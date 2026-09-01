"""Bounded Waku 0.1.1 node supervision."""
from __future__ import annotations

import json
import signal
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Protocol


class ToolEventKind(Enum):
    SPECIALIST_START = "specialist_start"
    SPECIALIST_END = "specialist_end"
    GATE_START = "gate_start"
    GATE_END = "gate_end"
    ERROR = "error"


@dataclass
class ToolEvent:
    kind: ToolEventKind
    tool: str
    timestamp: float = field(default_factory=time.time)
    status: str = ""
    detail: str = ""


class WakuRuntimeError(Exception):
    def __init__(self, reason: str, *, events: list[ToolEvent] | None = None) -> None:
        self.reason = reason
        self.events = events or []
        super().__init__(reason)


class LoopResultLike(Protocol):
    iterations: int
    reply: str
    tool_calls: list[Any]


class WakuLoopRunner(Protocol):
    def __call__(
        self,
        client: Any,
        model: str,
        system: str,
        messages: list[dict[str, Any]],
        tools: Any,
        *,
        max_iterations: int,
        max_tokens: int,
        observer: Any,
        stream: bool,
    ) -> LoopResultLike: ...


@dataclass
class FakeToolCall:
    name: str
    output: str


@dataclass
class FakeLoopResult:
    iterations: int
    reply: str
    tool_calls: list[FakeToolCall] = field(default_factory=list)


@dataclass(frozen=True)
class ExecutionCeilings:
    max_iterations: int = 10
    max_specialist_attempts: int = 3
    max_gate_calls: int = 12
    max_supervisor_tokens: int = 2048
    node_timeout_seconds: int = 1800


def _decoded_tool_result(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        return None
    return decoded if isinstance(decoded, dict) else None


def _tool_call_value(call: Any, key: str, default: Any = "") -> Any:
    if isinstance(call, dict):
        return call.get(key, default)
    return getattr(call, key, default)


def _is_exhausted(result: LoopResultLike, maximum: int) -> bool:
    return (
        result.iterations >= maximum
        and result.reply.startswith("(I hit my iteration limit")
    )


def _event_index(
    events: list[ToolEvent], kind: ToolEventKind, status: str,
) -> int | None:
    for index, event in enumerate(events):
        if event.kind == kind and event.status == status:
            return index
    return None


def _verify_tdd_order(events: list[ToolEvent]) -> list[str]:
    red_specialist = _event_index(events, ToolEventKind.SPECIALIST_END, "red")
    red_gate = _event_index(events, ToolEventKind.GATE_END, "red")
    implementation = _event_index(events, ToolEventKind.SPECIALIST_END, "implement")
    green_gate = _event_index(events, ToolEventKind.GATE_END, "green")
    required = {
        "red specialist": red_specialist,
        "red gate": red_gate,
        "implementation specialist": implementation,
        "green gate": green_gate,
    }
    errors = [f"missing {name}" for name, index in required.items() if index is None]
    if errors:
        return errors
    assert red_specialist is not None
    assert red_gate is not None
    assert implementation is not None
    assert green_gate is not None
    if not red_specialist < red_gate < implementation < green_gate:
        errors.append("TDD events are not ordered red-specialist, red-gate, implement, green-gate")
    return errors


def verify_required_events(
    events: list[ToolEvent],
    *,
    require_specialist: bool = True,
    require_final_gate: bool = False,
    behavior_change: bool = False,
    required_final_gates: set[str] | None = None,
) -> list[str]:
    errors = _recorded_event_errors(events)
    if errors:
        return errors
    errors.extend(
        _required_completion_errors(
            events,
            require_specialist=require_specialist,
            behavior_change=behavior_change,
        )
    )
    final_events = [
        event for event in events
        if event.kind == ToolEventKind.GATE_END and event.status == "final"
    ]
    errors.extend(
        _final_gate_errors(
            events,
            final_events,
            require_final_gate=require_final_gate,
            required_final_gates=required_final_gates,
        )
    )
    return errors


def _recorded_event_errors(events: list[ToolEvent]) -> list[str]:
    errors = [
        f"tool error: {event.tool}: {event.detail}"
        for event in events
        if event.kind == ToolEventKind.ERROR
    ]
    if errors:
        return errors
    malformed_completions = [
        event for event in events
        if event.kind in (ToolEventKind.SPECIALIST_END, ToolEventKind.GATE_END)
        and event.detail.startswith("malformed")
    ]
    if malformed_completions:
        errors.append("malformed completion event")
    return errors


def _required_completion_errors(
    events: list[ToolEvent],
    *,
    require_specialist: bool,
    behavior_change: bool,
) -> list[str]:
    errors: list[str] = []
    specialist_ends = [
        event for event in events if event.kind == ToolEventKind.SPECIALIST_END
    ]
    if require_specialist and not specialist_ends:
        errors.append("no specialist completion recorded")
    if behavior_change:
        errors.extend(_verify_tdd_order(events))
    return errors


def _final_gate_errors(
    events: list[ToolEvent],
    final_events: list[ToolEvent],
    *,
    require_final_gate: bool,
    required_final_gates: set[str] | None,
) -> list[str]:
    errors: list[str] = []
    if require_final_gate and not final_events:
        errors.append("no final gate result recorded")
    errors.extend(_missing_final_gate_errors(final_events, required_final_gates))
    if _final_gate_precedes_last_specialist(events):
        errors.append("a final gate ran before the last specialist attempt")
    return errors


def _missing_final_gate_errors(
    final_events: list[ToolEvent],
    required_final_gates: set[str] | None,
) -> list[str]:
    if required_final_gates is None:
        return []
    called = {event.detail for event in final_events}
    missing = sorted(required_final_gates - called)
    return [f"missing final gates: {', '.join(missing)}"] if missing else []


def _final_gate_precedes_last_specialist(events: list[ToolEvent]) -> bool:
    specialist_indexes = [
        index
        for index, event in enumerate(events)
        if event.kind == ToolEventKind.SPECIALIST_END
    ]
    if not specialist_indexes:
        return False
    last_specialist = max(specialist_indexes)
    return any(
        index < last_specialist
        for index, event in enumerate(events)
        if event.kind == ToolEventKind.GATE_END and event.status == "final"
    )


class _DeadlineExpired(Exception):
    pass


class _Deadline:
    def __init__(self, seconds: int) -> None:
        self._seconds = seconds
        self._previous: Any = None

    def __enter__(self) -> None:
        if threading.current_thread() is not threading.main_thread():
            raise WakuRuntimeError("hard node timeout requires main-thread execution")
        self._previous = signal.getsignal(signal.SIGALRM)

        def expire(_signum: int, _frame: Any) -> None:
            raise _DeadlineExpired()

        signal.signal(signal.SIGALRM, expire)
        signal.setitimer(signal.ITIMER_REAL, self._seconds)

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, self._previous)


class WakuNodeRuntime:
    def __init__(
        self,
        *,
        loop_runner: WakuLoopRunner | None = None,
        client_factory: Callable[[], Any] | None = None,
        model: str = "claude-haiku-4.5",
        gateway: str = "http://copilot-proxy-rs:8080",
    ) -> None:
        self._loop_runner = loop_runner
        self._client_factory = client_factory
        self._model = model
        self._gateway = gateway
        self._events: list[ToolEvent] = []

    @property
    def events(self) -> list[ToolEvent]:
        return list(self._events)

    def fork(self) -> WakuNodeRuntime:
        return WakuNodeRuntime(
            loop_runner=self._loop_runner,
            client_factory=self._client_factory,
            model=self._model,
            gateway=self._gateway,
        )

    def _get_loop_runner(self) -> WakuLoopRunner:
        if self._loop_runner is not None:
            return self._loop_runner
        try:
            from waku.loop.agent import run_loop
        except ImportError as exc:
            raise WakuRuntimeError("waku.loop.agent is not installed") from exc
        return run_loop

    def _make_client(self) -> Any:
        if self._client_factory is not None:
            return self._client_factory()
        try:
            import anthropic
        except ImportError as exc:
            raise WakuRuntimeError("anthropic client is not installed") from exc
        return anthropic.Anthropic(
            base_url=self._gateway,
            api_key="trellage-local-proxy",
            timeout=120.0,
            max_retries=2,
        )

    def _build_tool_registry(
        self,
        *,
        specialist_fn: Callable[..., str],
        gate_fn: Callable[..., str],
        phases: list[str],
        gate_names: list[str],
    ) -> Any:
        try:
            from waku.tools.registry import Tool, ToolRegistry
        except ImportError:
            return {"run_specialist": specialist_fn, "run_gate": gate_fn}
        registry = ToolRegistry()
        registry.register(Tool(
            name="run_specialist",
            description="Run the fixed specialist for one authorized node phase.",
            input_schema={
                "type": "object",
                "additionalProperties": False,
                "required": ["phase"],
                "properties": {"phase": {"type": "string", "enum": phases}},
            },
            fn=specialist_fn,
        ))
        registry.register(Tool(
            name="run_gate",
            description="Run one predeclared deterministic gate by name.",
            input_schema={
                "type": "object",
                "additionalProperties": False,
                "required": ["name"],
                "properties": {"name": {"type": "string", "enum": gate_names}},
            },
            fn=gate_fn,
        ))
        return registry

    def record_event(self, event: ToolEvent) -> None:
        self._events.append(event)

    def make_specialist_tool(
        self,
        *,
        launcher: Callable[..., Any],
        ceilings: ExecutionCeilings,
        authorized_roles: set[str] | None = None,
        allowed_phases: set[str] | None = None,
        fixed_role: str | None = None,
    ) -> Callable[..., str]:
        attempts = 0

        def run_specialist(**kwargs: Any) -> str:
            nonlocal attempts
            phase = str(kwargs.get("phase", ""))
            role = fixed_role or str(kwargs.get("role", ""))
            if authorized_roles is not None and role not in authorized_roles:
                return self._tool_error("run_specialist", f"unauthorized role: {role}")
            if allowed_phases is not None and phase not in allowed_phases:
                return self._tool_error("run_specialist", f"unauthorized phase: {phase}")
            attempts += 1
            if attempts > ceilings.max_specialist_attempts:
                return self._tool_error("run_specialist", "max attempts exceeded")
            self.record_event(ToolEvent(
                ToolEventKind.SPECIALIST_START, "run_specialist", status=phase,
            ))
            try:
                result = launcher(phase=phase, role=role)
            except Exception as exc:
                return self._tool_error("run_specialist", str(exc))
            decoded = _decoded_tool_result(result)
            if decoded is None or decoded.get("status") != "ok":
                return self._tool_error("run_specialist", "specialist returned an error or malformed result")
            self.record_event(ToolEvent(
                ToolEventKind.SPECIALIST_END, "run_specialist", status=phase,
            ))
            return json.dumps(decoded, sort_keys=True)

        return run_specialist

    def make_gate_tool(
        self,
        *,
        gate_runner: Callable[..., Any],
        ceilings: ExecutionCeilings,
        declared_gates: dict[str, dict[str, Any]] | None = None,
    ) -> Callable[..., str]:
        calls = 0

        def run_gate(**kwargs: Any) -> str:
            nonlocal calls
            gate_name = str(kwargs.get("name", ""))
            gate = (declared_gates or {}).get(gate_name)
            if gate is None:
                return self._tool_error("run_gate", f"undeclared gate: {gate_name}")
            calls += 1
            if calls > ceilings.max_gate_calls:
                return self._tool_error("run_gate", "max gate calls exceeded")
            phase = str(gate.get("phase", "final"))
            self.record_event(ToolEvent(
                ToolEventKind.GATE_START, "run_gate", status=phase, detail=gate_name,
            ))
            try:
                result = gate_runner(gate=gate)
            except Exception as exc:
                return self._tool_error("run_gate", str(exc))
            decoded = _decoded_tool_result(result)
            if decoded is None or decoded.get("status") != "ok" or decoded.get("passed") is not True:
                return self._tool_error("run_gate", f"gate failed: {gate_name}")
            self.record_event(ToolEvent(
                ToolEventKind.GATE_END, "run_gate", status=phase, detail=gate_name,
            ))
            return json.dumps(decoded, sort_keys=True)

        return run_gate

    def _tool_error(self, tool: str, detail: str) -> str:
        self.record_event(ToolEvent(ToolEventKind.ERROR, tool, detail=detail))
        return json.dumps({"status": "error", "reason": detail}, sort_keys=True)

    def _inspect_loop_result(
        self, result: LoopResultLike, ceilings: ExecutionCeilings,
    ) -> None:
        if _is_exhausted(result, ceilings.max_iterations):
            self.record_event(ToolEvent(
                ToolEventKind.ERROR,
                "waku_loop",
                detail=f"iteration exhaustion: {result.iterations}/{ceilings.max_iterations}",
            ))
        for call in result.tool_calls:
            output = _tool_call_value(call, "output")
            decoded = _decoded_tool_result(output)
            if isinstance(output, str) and output.startswith("Error running "):
                self.record_event(ToolEvent(
                    ToolEventKind.ERROR,
                    str(_tool_call_value(call, "tool", _tool_call_value(call, "name", "unknown"))),
                    detail=f"waku-wrapped error: {output}",
                ))
            elif decoded is None or decoded.get("status") != "ok":
                self.record_event(ToolEvent(
                    ToolEventKind.ERROR,
                    str(_tool_call_value(call, "tool", _tool_call_value(call, "name", "unknown"))),
                    detail="malformed or error-shaped Waku tool output",
                ))

    def run_node(
        self,
        *,
        envelope: dict[str, Any],
        specialist_launcher: Callable[..., Any],
        gate_runner_fn: Callable[..., Any],
        ceilings: ExecutionCeilings,
        system_prompt: str = "",
        initial_message: str = "",
    ) -> dict[str, Any]:
        self._events = []
        behavior_change = bool(envelope.get("behavior_change", False))
        repair_mode = bool(envelope.get("repair_mode", False))
        phases = (
            ["repair"]
            if repair_mode
            else ["red", "implement", "validate"]
            if behavior_change
            else [str(envelope["phase"])]
        )
        declared_gates = {gate["name"]: gate for gate in envelope.get("gates", [])}
        specialist = self.make_specialist_tool(
            launcher=specialist_launcher,
            ceilings=ceilings,
            authorized_roles={str(envelope["role"])},
            allowed_phases=set(phases),
            fixed_role=str(envelope["role"]),
        )
        gate = self.make_gate_tool(
            gate_runner=gate_runner_fn,
            ceilings=ceilings,
            declared_gates=declared_gates,
        )
        tools = self._build_tool_registry(
            specialist_fn=specialist,
            gate_fn=gate,
            phases=phases,
            gate_names=sorted(declared_gates),
        )
        messages = [{"role": "user", "content": initial_message or "Execute the node envelope."}]
        started = time.monotonic()
        try:
            with _Deadline(ceilings.node_timeout_seconds):
                result = self._get_loop_runner()(
                    self._make_client(),
                    self._model,
                    system_prompt or self._system_prompt(envelope),
                    messages,
                    tools,
                    max_iterations=ceilings.max_iterations,
                    max_tokens=ceilings.max_supervisor_tokens,
                    observer=None,
                    stream=False,
                )
        except _DeadlineExpired as exc:
            raise WakuRuntimeError(
                f"node timed out after {ceilings.node_timeout_seconds}s",
                events=self.events,
            ) from exc
        except WakuRuntimeError:
            raise
        except Exception as exc:
            raise WakuRuntimeError(f"Waku loop failed: {exc}", events=self.events) from exc
        self._inspect_loop_result(result, ceilings)
        final_gates = {
            gate["name"] for gate in envelope.get("gates", [])
            if gate.get("phase", "final") == "final"
        }
        violations = verify_required_events(
            self._events,
            behavior_change=behavior_change and not repair_mode,
            require_final_gate=bool(final_gates),
            required_final_gates=final_gates,
        )
        if violations:
            raise WakuRuntimeError(
                f"node {envelope['node_id']} verification failed: {'; '.join(violations)}",
                events=self.events,
            )
        return {
            "status": "ok",
            "node_id": envelope["node_id"],
            "iterations": result.iterations,
            "elapsed_seconds": time.monotonic() - started,
            "events": [
                {
                    "kind": event.kind.value,
                    "tool": event.tool,
                    "status": event.status,
                    "detail": event.detail,
                }
                for event in self._events
            ],
        }

    @staticmethod
    def _system_prompt(envelope: dict[str, Any]) -> str:
        if envelope.get("repair_mode", False):
            sequence = (
                "Call run_specialist phase=repair once, then run every declared "
                "final gate. Do not rerun red or green gates because this is a "
                "repair of a previously attempted node."
            )
        elif envelope.get("behavior_change", False):
            sequence = (
                "Call run_specialist phase=red, then the red gate, then "
                "run_specialist phase=implement, then the green gate, then "
                "run_specialist phase=validate, then every final gate."
            )
        else:
            sequence = (
                f"Call run_specialist phase={envelope['phase']}, then every declared gate."
            )
        return (
            "You supervise exactly one immutable node envelope. "
            "Use only run_specialist and run_gate. "
            f"{sequence} Do not claim completion in prose; stop after the required calls."
        )
