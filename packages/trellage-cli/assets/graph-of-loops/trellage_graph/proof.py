"""Raindrop proof gate — Workshop 0.1.21.

Lifecycle:
  1. raindrop replay register --cwd=<repo> with isolated HOME/state
  2. Start raindrop workshop daemon if needed, health-check via HTTP
  3. Spawn raindrop workshop mcp (Popen, stdin/stdout pipes)
  4. JSON-RPC: initialize → notifications/initialized → tools/list
     (require replay_run) → tools/call replay_run
  5. Read correlated response IDs with bounded timeout
  6. Always terminate/kill the child process
  7. Require ok:true and nonempty replay_run_id
  8. Full repository snapshot before/after: detect new, modified, deleted
     files outside declared allowed patterns
  9. Evaluate declared trace assertions without shell execution

Default not-applicable without both .raindrop/agents.yaml + Trellage policy.
Required unavailable/failure blocks.
"""
from __future__ import annotations

import fnmatch
import json
import os
import queue
import re
import signal
import subprocess
import threading
import time
from http.client import HTTPConnection
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlparse

from .contracts import validate_proof_policy, PlanValidationError, content_digest


class ProofError(Exception):
    """Raised when proof validation fails."""


# -- Injectable Popen transport --

class PopenTransport(Protocol):
    """Injectable subprocess.Popen boundary for MCP stdio."""

    def spawn(
        self, args: list[str], *, env: dict[str, str],
    ) -> subprocess.Popen[str]: ...


class RealPopenTransport:
    def spawn(
        self, args: list[str], *, env: dict[str, str],
    ) -> subprocess.Popen[str]:
        return subprocess.Popen(
            args, env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )


class SubprocessRunner(Protocol):
    """For CLI calls (register, etc.)."""

    def run(
        self, args: list[str], *,
        capture_output: bool = True, text: bool = True,
        check: bool = True, cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: int | None = None,
    ) -> subprocess.CompletedProcess[str]: ...


class RealSubprocessRunner:
    def run(
        self, args: list[str], *,
        capture_output: bool = True, text: bool = True,
        check: bool = True, cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: int | None = None,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            args, capture_output=capture_output, text=text,
            check=check, cwd=cwd, env=env, timeout=timeout,
        )


# -- MCP client protocol --

class WorkshopMCPClient(Protocol):
    """Boundary for Raindrop Workshop 0.1.21 proof replay."""

    def register_replay(self, *, repo_root: str) -> None: ...

    def replay_run(
        self, *, run_id: str,
        user_message: str | None,
        model: str | None,
        timeout: int,
    ) -> dict[str, Any]: ...


# -- JSON-RPC helpers --

def _jsonrpc_request(id_: int, method: str, params: dict[str, Any]) -> str:
    return json.dumps({
        "jsonrpc": "2.0", "id": id_, "method": method, "params": params,
    })


def _jsonrpc_notification(method: str, params: dict[str, Any] | None = None) -> str:
    msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        msg["params"] = params
    return json.dumps(msg)


def _read_response(
    proc: subprocess.Popen[str],
    expected_id: int,
    timeout: float,
) -> dict[str, Any]:
    """Read lines from proc.stdout until the response with expected_id arrives."""
    deadline = time.monotonic() + timeout
    assert proc.stdout is not None
    responses: queue.Queue[dict[str, Any] | None] = queue.Queue()

    def _reader() -> None:
        while True:
            line = proc.stdout.readline()  # type: ignore[union-attr]
            if not line:
                responses.put(None)
                return
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(message, dict) and message.get("id") == expected_id:
                responses.put(message)
                return

    threading.Thread(target=_reader, daemon=True).start()
    remaining = deadline - time.monotonic()
    if remaining > 0:
        try:
            response = responses.get(timeout=remaining)
        except queue.Empty:
            response = None
        if response is not None:
            return response

    raise ProofError(
        f"timed out waiting for JSON-RPC response id={expected_id}"
    )


def _send(proc: subprocess.Popen[str], line: str) -> None:
    assert proc.stdin is not None
    proc.stdin.write(line + "\n")
    proc.stdin.flush()


def _kill_proc(proc: subprocess.Popen[str]) -> None:
    """Terminate then kill the child, always."""
    try:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)
    except OSError:
        pass


# -- Real MCP client --

class StdioWorkshopMCPClient:
    """Workshop MCP client using Popen stdio JSON-RPC transport."""

    def __init__(
        self, *,
        transport: PopenTransport | None = None,
        runner: SubprocessRunner | None = None,
        home: str = "",
        workshop_url: str = "",
        assume_healthy: bool = False,
    ) -> None:
        self._transport = transport or RealPopenTransport()
        self._runner = runner or RealSubprocessRunner()
        self._home = home
        self._workshop_url = workshop_url or "http://localhost:5899"
        self._assume_healthy = assume_healthy

    def _env(self) -> dict[str, str]:
        env = dict(os.environ)
        if self._home:
            env["HOME"] = self._home
        env["RAINDROP_WORKSHOP_URL"] = self._workshop_url
        return env

    def register_replay(self, *, repo_root: str) -> None:
        """raindrop replay register --cwd=<repo> with isolated HOME."""
        env = self._env()
        try:
            self._runner.run(
                ["raindrop", "replay", "register", f"--cwd={repo_root}"],
                env=env, capture_output=True, text=True,
                check=True, timeout=30,
            )
        except subprocess.CalledProcessError as exc:
            raise ProofError(
                f"raindrop replay register failed: exit={exc.returncode} "
                f"{exc.stderr}"
            ) from exc
        except FileNotFoundError as exc:
            raise ProofError("raindrop binary is not installed") from exc

    def _ensure_workshop_healthy(self) -> None:
        """Health-check RAINDROP_WORKSHOP_URL via stdlib HTTP.

        If unhealthy, start the daemon via runner, then re-check.
        All IO goes through injectable boundaries.
        """
        if self._assume_healthy or self._http_health_ok():
            return

        # Start daemon via injectable runner (check=False: may already be running)
        env = self._env()
        try:
            self._runner.run(
                ["raindrop", "workshop"],
                env=env, capture_output=True, text=True,
                check=False, timeout=5,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
            raise ProofError(f"cannot start raindrop workshop: {exc}") from exc

        # Wait for health
        for _ in range(15):
            time.sleep(0.1)
            if self._http_health_ok():
                return
        raise ProofError("raindrop workshop did not become healthy")

    def _http_health_ok(self) -> bool:
        """GET RAINDROP_WORKSHOP_URL health endpoint via stdlib."""
        parsed = urlparse(self._workshop_url)
        host = parsed.hostname or "localhost"
        port = parsed.port or 5899
        try:
            conn = HTTPConnection(host, port, timeout=3)
            conn.request("GET", "/health")
            resp = conn.getresponse()
            conn.close()
            return resp.status == 200
        except Exception:
            return False

    def replay_run(
        self, *, run_id: str,
        user_message: str | None = None,
        model: str | None = None,
        timeout: int = 300,
    ) -> dict[str, Any]:
        self._ensure_workshop_healthy()

        env = self._env()
        proc = self._transport.spawn(
            ["raindrop", "workshop", "mcp"], env=env,
        )
        try:
            return self._mcp_session(proc, run_id, user_message, model, timeout)
        finally:
            _kill_proc(proc)

    def _mcp_session(
        self,
        proc: subprocess.Popen[str],
        run_id: str,
        user_message: str | None,
        model: str | None,
        timeout: float,
    ) -> dict[str, Any]:
        # 1. initialize
        _send(proc, _jsonrpc_request(1, "initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "trellage-graph", "version": "0.1.0"},
        }))
        init_resp = _read_response(proc, 1, timeout=10)
        if "error" in init_resp:
            raise ProofError(f"MCP initialize failed: {init_resp['error']}")

        # 2. notifications/initialized
        _send(proc, _jsonrpc_notification("notifications/initialized"))

        # 3. tools/list — require replay_run
        _send(proc, _jsonrpc_request(2, "tools/list", {}))
        tools_resp = _read_response(proc, 2, timeout=10)
        tool_names = [
            t.get("name", "")
            for t in tools_resp.get("result", {}).get("tools", [])
        ]
        if "replay_run" not in tool_names:
            raise ProofError(
                f"Workshop MCP does not expose replay_run; "
                f"available: {tool_names}"
            )

        # 4. tools/call replay_run
        call_args: dict[str, Any] = {"run_id": run_id}
        if user_message:
            call_args["user_message"] = user_message
        if model:
            call_args["model"] = model

        _send(proc, _jsonrpc_request(3, "tools/call", {
            "name": "replay_run",
            "arguments": call_args,
        }))
        call_resp = _read_response(proc, 3, timeout=timeout)

        return self._extract_replay_result(call_resp)

    @staticmethod
    def _extract_replay_result(call_resp: dict[str, Any]) -> dict[str, Any]:
        if "error" in call_resp:
            return {"ok": False, "error": str(call_resp["error"])}
        content = call_resp.get("result", {}).get("content", [])
        for item in content:
            if not isinstance(item, dict) or item.get("type") != "text":
                continue
            try:
                parsed = json.loads(item["text"])
                if isinstance(parsed, dict):
                    return parsed
            except (json.JSONDecodeError, KeyError):
                pass
        return {"ok": False, "error": "no parseable text in tools/call response"}


# -- Proof gate --

class RaindropProofGate:
    """Raindrop replay proof gate with repository-opt-in semantics."""

    def __init__(
        self, *, mcp_client: WorkshopMCPClient | None = None,
        repo_root: str = "",
    ) -> None:
        self._mcp = mcp_client
        self._repo_root = repo_root

    # -- Applicability --

    @staticmethod
    def _check_applicability(
        *, repo_root: str, proof_policy_path: str | None,
    ) -> tuple[bool, str]:
        if not (Path(repo_root) / ".raindrop" / "agents.yaml").is_file():
            return False, "no .raindrop/agents.yaml in repository"
        if proof_policy_path is None:
            return False, "no Trellage proof policy provided"
        if not Path(proof_policy_path).is_file():
            return False, f"proof policy not found: {proof_policy_path}"
        return True, "applicable"

    @staticmethod
    def _load_policy(path: str) -> dict[str, Any]:
        try:
            with open(path, encoding="utf-8") as fh:
                policy = json.load(fh)
        except (json.JSONDecodeError, OSError) as exc:
            raise ProofError(f"cannot read proof policy: {exc}") from exc
        try:
            validate_proof_policy(policy)
        except PlanValidationError as exc:
            raise ProofError(f"invalid proof policy: {exc}") from exc
        return policy

    @staticmethod
    def _validate_event_name(event_name: str, repo_root: str) -> None:
        """Parse agents.yaml and require event_name as a top-level key."""
        agents_path = Path(repo_root) / ".raindrop" / "agents.yaml"
        try:
            text = agents_path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ProofError(f"cannot read agents.yaml: {exc}") from exc

        scalar = re.compile(
            r"^(?:-\s*)?(?:event|event_name):\s*"
            r"(?:\"([^\"]*)\"|'([^']*)'|([^#]*?))"
            r"\s*(?:#.*)?$"
        )
        for line in text.splitlines():
            stripped = line.strip()
            if stripped == f"{event_name}:":
                return
            match = scalar.fullmatch(stripped)
            if match and next(
                value for value in match.groups() if value is not None
            ).strip() == event_name:
                return
        raise ProofError(
            f"event_name '{event_name}' not found in .raindrop/agents.yaml"
        )

    # -- Snapshots --

    @staticmethod
    def _snapshot_repository(repo_root: str) -> dict[str, str]:
        """Digest every file except .git internals."""
        snap: dict[str, str] = {}
        root = Path(repo_root)
        for path in root.rglob("*"):
            rel = path.relative_to(root)
            if ".git" in rel.parts or not path.is_file():
                continue
            snap[str(rel)] = content_digest(path.read_bytes())
        return snap

    @staticmethod
    def _unauthorized_effects(
        before: dict[str, str],
        after: dict[str, str],
        allowed: list[str],
    ) -> list[str]:
        """Detect new, modified, deleted files outside the allowlist."""
        changed = {
            p for p in before.keys() | after.keys()
            if before.get(p) != after.get(p)
        }
        return sorted(
            p for p in changed
            if not any(fnmatch.fnmatch(p, pat) for pat in allowed)
        )

    # -- Assertions --

    @staticmethod
    def _evaluate_assertions(
        replay: dict[str, Any],
        assertions: list[dict[str, Any]],
    ) -> list[str]:
        """Evaluate declared trace assertions — no shell execution."""
        failures: list[str] = []
        for a in assertions:
            check, name = a["check"], a["name"]
            if check == "replay_ok":
                if not replay.get("ok", False):
                    failures.append(
                        f"assertion '{name}': ok=false "
                        f"({replay.get('error', '?')})"
                    )
                if not replay.get("replay_run_id"):
                    failures.append(
                        f"assertion '{name}': empty replay_run_id"
                    )
            elif check == "output_contains":
                val = a.get("value", "")
                blob = json.dumps(replay.get("events", []))
                if val not in blob:
                    failures.append(
                        f"assertion '{name}': events do not contain '{val}'"
                    )
            elif check == "file_unchanged":
                pass  # handled by snapshot comparison
        return failures

    @staticmethod
    def _file_unchanged_failures(
        before: dict[str, str],
        after: dict[str, str],
        assertions: list[dict[str, Any]],
    ) -> list[str]:
        failures: list[str] = []
        for a in assertions:
            if a["check"] != "file_unchanged" or not a.get("value"):
                continue
            target = a["value"]
            old = before.get(target)
            new = after.get(target)
            if old is None:
                continue  # file did not exist before
            if new is None:
                failures.append(f"file_unchanged '{target}': deleted")
            elif new != old:
                failures.append(f"file_unchanged '{target}': modified")
        return failures

    # -- Entry point --

    def run_proof(
        self, *, node_id: str, repo_root: str = "",
        proof_policy_path: str | None = None,
        proof_required: bool = False,
        changed_files: list[str] | None = None,
    ) -> dict[str, Any]:
        root = repo_root or self._repo_root

        applicable, reason = self._check_applicability(
            repo_root=root, proof_policy_path=proof_policy_path,
        )
        if not applicable:
            if proof_required:
                raise ProofError(
                    f"proof is required but not applicable: {reason}"
                )
            return {"status": "not-applicable", "node_id": node_id, "reason": reason}

        policy = self._load_policy(proof_policy_path)  # type: ignore[arg-type]
        self._validate_event_name(policy["event_name"], root)

        source_run_id = policy.get("source_run_id", "")
        if not source_run_id:
            raise ProofError(
                "proof policy has no source_run_id; cannot replay "
                "without a valid Workshop source trace"
            )

        if self._mcp is None:
            raise ProofError("no Workshop MCP client configured")

        timeout = policy.get("timeout_seconds", 300)
        allowed = policy.get("allowed_file_effects", [])

        # Register before replay
        self._mcp.register_replay(repo_root=root)

        # Snapshot full repository
        before = self._snapshot_repository(root)

        # Replay
        try:
            result = self._mcp.replay_run(
                run_id=source_run_id,
                user_message=policy.get("user_message"),
                model=policy.get("model"),
                timeout=timeout,
            )
        except TimeoutError as exc:
            raise ProofError(f"replay timed out after {timeout}s") from exc
        except ProofError:
            raise
        except Exception as exc:
            raise ProofError(f"replay failed: {exc}") from exc

        # Require ok:true
        if not result.get("ok", False):
            raise ProofError(
                f"replay_run returned ok=false: "
                f"{result.get('error', json.dumps(result))}"
            )

        # Require nonempty replay_run_id
        if not result.get("replay_run_id"):
            raise ProofError("replay_run returned empty replay_run_id")

        # Snapshot after and compare
        after = self._snapshot_repository(root)
        effects = self._unauthorized_effects(before, after, allowed)

        # Evaluate assertions
        failures = self._evaluate_assertions(result, policy["assertions"])
        failures.extend(self._file_unchanged_failures(
            before, after, policy["assertions"],
        ))
        if effects:
            failures.append(
                f"unauthorized file effects: {', '.join(effects)}"
            )

        if failures:
            raise ProofError(
                f"proof assertions failed: {'; '.join(failures)}"
            )

        return {
            "status": "passed",
            "node_id": node_id,
            "source_run_id": source_run_id,
            "replay_run_id": result["replay_run_id"],
            "assertions_passed": len(policy["assertions"]),
        }
