"""Deterministic gate runner.

- Executes argv arrays via subprocess with shell=False
- Validates gate names, no absolute/.. paths, cwd
- Enforces TDD red->green->final ordering
- Red-phase write-set validation via git diff
- Same red/green command identity (argv equality)
- Final gates after last specialist attempt
- Inspects returned status; does not record every result as OK
"""
from __future__ import annotations

import subprocess
from typing import Any

from .beads_repository import SubprocessRunner, RealSubprocessRunner
from .contracts import content_digest
from .gate_command import gate_command_errors


class GateError(Exception):
    """Raised when a gate fails."""


class GateRunner:
    def __init__(
        self, *, runner: SubprocessRunner | None = None,
        timeout_seconds: int = 900,
    ) -> None:
        self._runner = runner or RealSubprocessRunner()
        self._timeout_seconds = timeout_seconds
        self._red_argv: list[list[str]] = []
        self._red_digest: str | None = None
        self._green_passed: bool = False

    @staticmethod
    def validate_argv(argv: list[str], gate_name: str, node_id: str) -> None:
        """Reject unsafe or inline-evaluated gate commands."""
        errors = gate_command_errors(argv)
        if errors:
            raise GateError(
                f"gate '{gate_name}' node '{node_id}': {'; '.join(errors)}"
            )

    def run_gate(
        self, *, name: str, argv: list[str], phase: str = "",
        cwd: str | None = None, node_id: str = "",
    ) -> dict[str, Any]:
        """Run a single gate.

        TDD semantics:
          red:   argv MUST fail (nonzero exit)
          green: MUST use same argv as red, MUST pass
          final: runs after last specialist, MUST pass
        """
        self.validate_argv(argv, name, node_id)

        self._prepare_phase(name, argv, phase)

        passed, exit_code, digest = self._execute(name, argv, cwd)
        return self._evaluate_result(
            name=name,
            phase=phase,
            passed=passed,
            exit_code=exit_code,
            digest=digest,
        )

    def _prepare_phase(self, name: str, argv: list[str], phase: str) -> None:
        if phase == "red":
            self._red_argv.append(list(argv))
            return
        if phase != "green":
            return
        if not self._red_argv:
            raise GateError(f"green gate '{name}' has no preceding red gate")
        matching = next(
            (
                index
                for index, red_argv in enumerate(self._red_argv)
                if argv == red_argv
            ),
            None,
        )
        if matching is None:
            raise GateError(
                f"green gate '{name}' argv differs from red: "
                f"red={self._red_argv}, green={argv}"
            )
        self._red_argv.pop(matching)

    def _execute(
        self, name: str, argv: list[str], cwd: str | None,
    ) -> tuple[bool, int, str]:
        try:
            result = self._runner.run(
                argv, cwd=cwd,
                capture_output=True, text=True, check=True,
                timeout=self._timeout_seconds,
            )
            output = f"{result.stdout}\n{result.stderr}"
            passed = True
            exit_code = 0
        except subprocess.CalledProcessError as exc:
            output = f"{exc.stdout or ''}\n{exc.stderr or ''}"
            passed = False
            exit_code = exc.returncode
        except subprocess.TimeoutExpired as exc:
            raise GateError(
                f"gate '{name}' timed out after {self._timeout_seconds}s"
            ) from exc
        return passed, exit_code, content_digest(output)

    def _evaluate_result(
        self,
        *,
        name: str,
        phase: str,
        passed: bool,
        exit_code: int,
        digest: str,
    ) -> dict[str, Any]:
        if phase == "red":
            if passed:
                raise GateError(f"red gate '{name}' must fail, but succeeded")
            self._red_digest = digest
            return {
                "status": "ok", "gate": name, "phase": "red",
                "passed": True, "exit_code": exit_code,
                "output_digest": digest,
            }

        if phase == "green":
            if not passed:
                raise GateError(
                    f"green gate '{name}' must pass, exit_code={exit_code}"
                )
            self._green_passed = True
            return {
                "status": "ok", "gate": name, "phase": "green",
                "passed": True, "exit_code": 0, "output_digest": digest,
            }

        if phase == "final":
            if not passed:
                raise GateError(f"final gate '{name}' failed, exit_code={exit_code}")
            return {
                "status": "ok", "gate": name, "phase": "final",
                "passed": True, "exit_code": 0, "output_digest": digest,
            }

        # Non-TDD gate
        if not passed:
            raise GateError(f"gate '{name}' failed: exit_code={exit_code}")
        return {
            "status": "ok", "gate": name, "phase": phase or "default",
            "passed": True, "exit_code": exit_code, "output_digest": digest,
        }

    def validate_tdd_write_set(
        self, *, changed_files: list[str],
        test_write_set: list[str], phase: str,
    ) -> None:
        """Red-phase: only test_write_set paths allowed."""
        if phase != "red":
            return
        import fnmatch
        violations = [
            p for p in changed_files
            if not any(fnmatch.fnmatch(p, pat) for pat in test_write_set)
        ]
        if violations:
            raise GateError(
                f"red phase changed non-test files: {', '.join(violations)}"
            )

    def get_changed_files(self, *, cwd: str, base_ref: str) -> list[str]:
        """Use git diff to find actually changed files."""
        try:
            result = self._runner.run(
                ["git", "diff", "--name-only", base_ref, "HEAD"],
                cwd=cwd, capture_output=True, text=True, check=True,
                timeout=30,
            )
            return [f for f in result.stdout.strip().splitlines() if f]
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise GateError(f"cannot determine changed files: {exc}") from exc
