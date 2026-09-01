"""Facade over Bernstein 3.16.0 DAG and worktree APIs."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Protocol


class WorktreeManagerLike(Protocol):
    def create(self, session_id: str) -> Path: ...
    def cleanup(self, session_id: str) -> None: ...


@dataclass(frozen=True)
class FakeTaskNode:
    task_id: str
    description: str = ""
    parallel_safe: bool = False
    story_id: str | None = None
    depends_on: tuple[str, ...] = ()


class BernsteinError(Exception):
    pass


def topological_iter_with_parallel(
    nodes: list[FakeTaskNode],
) -> list[frozenset[FakeTaskNode]]:
    """Stdlib test double that mirrors Bernstein's serial/parallel batches."""
    pending = {node.task_id: node for node in nodes}
    completed: set[str] = set()
    batches: list[frozenset[FakeTaskNode]] = []
    while pending:
        ready = _ready_nodes(pending, completed)
        if not ready:
            raise BernsteinError(
                f"cycle in task DAG involving: {', '.join(sorted(pending))}"
            )
        batch = _next_batch(ready)
        batches.append(batch)
        for node in batch:
            completed.add(node.task_id)
            pending.pop(node.task_id)
    return batches


def _ready_nodes(
    pending: dict[str, FakeTaskNode], completed: set[str],
) -> list[FakeTaskNode]:
    return sorted(
        (
            node
            for node in pending.values()
            if all(dependency in completed for dependency in node.depends_on)
        ),
        key=lambda node: node.task_id,
    )


def _next_batch(ready: list[FakeTaskNode]) -> frozenset[FakeTaskNode]:
    serial = next((node for node in ready if not node.parallel_safe), None)
    return frozenset([serial] if serial is not None else ready)


class BernsteinFacade:
    def __init__(
        self,
        *,
        worktree_manager: WorktreeManagerLike | None = None,
        task_node_factory: Callable[..., Any] | None = None,
        dag_factory: Callable[[list[Any]], Any] | None = None,
        wave_iterator: Callable[[Any], Iterable[frozenset[Any]]] | None = None,
    ) -> None:
        self._worktree_manager = worktree_manager
        self._task_node_factory = task_node_factory
        self._dag_factory = dag_factory
        self._wave_iterator = wave_iterator
        self._dag: Any = None
        self._paths: dict[str, Path] = {}

    @classmethod
    def from_live(cls, *, repo_root: Path) -> "BernsteinFacade":
        try:
            from bernstein.core.git.worktree import WorktreeManager
            from bernstein.core.orchestration.task_dag import (
                TaskDag,
                TaskNode,
                topological_iter_with_parallel as iterate,
            )
        except ImportError as exc:
            raise BernsteinError("Bernstein 3.16.0 is not installed") from exc
        return cls(
            worktree_manager=WorktreeManager(
                repo_root=repo_root,
                salvage_on_cleanup=True,
                salvage_push=False,
            ),
            task_node_factory=TaskNode,
            dag_factory=TaskDag.from_nodes,
            wave_iterator=iterate,
        )

    def build_dag(self, plan_nodes: list[dict[str, Any]]) -> None:
        if self._task_node_factory is None:
            nodes = [
                FakeTaskNode(
                    task_id=node["id"],
                    description=str(node.get("prompt", node["id"])),
                    parallel_safe=bool(node.get("parallel_safe", False)),
                    depends_on=tuple(node["dependencies"]),
                )
                for node in plan_nodes
            ]
            self._dag = nodes
            return
        nodes = [
            self._task_node_factory(
                task_id=node["id"],
                description=str(node.get("prompt", node["id"])),
                parallel_safe=bool(node.get("parallel_safe", False)),
                story_id=None,
                depends_on=tuple(node["dependencies"]),
            )
            for node in plan_nodes
        ]
        if self._dag_factory is None:
            raise BernsteinError("Bernstein TaskDag factory is not configured")
        try:
            self._dag = self._dag_factory(nodes)
        except Exception as exc:
            raise BernsteinError(f"cannot build Bernstein task DAG: {exc}") from exc

    def ready_waves(self) -> list[list[str]]:
        if self._dag is None:
            raise BernsteinError("Bernstein task DAG is not built")
        try:
            batches = (
                self._wave_iterator(self._dag)
                if self._wave_iterator is not None
                else topological_iter_with_parallel(self._dag)
            )
            return [
                sorted(node.task_id for node in batch)
                for batch in batches
            ]
        except Exception as exc:
            if isinstance(exc, BernsteinError):
                raise
            raise BernsteinError(f"cannot schedule Bernstein task DAG: {exc}") from exc

    @property
    def worktree_manager(self) -> WorktreeManagerLike:
        if self._worktree_manager is None:
            raise BernsteinError("Bernstein WorktreeManager is not configured")
        return self._worktree_manager

    def create_worktree(self, session_id: str) -> Path:
        try:
            worktree = Path(self.worktree_manager.create(session_id)).resolve()
        except Exception as exc:
            raise BernsteinError(f"cannot create Bernstein worktree: {exc}") from exc
        expected_suffix = Path(".sdd") / "worktrees" / session_id
        if not str(worktree).endswith(str(expected_suffix)):
            raise BernsteinError(f"Bernstein returned unexpected worktree path: {worktree}")
        self._paths[session_id] = worktree
        return worktree

    def restore_worktree(self, session_id: str, path: str) -> None:
        self._paths[session_id] = Path(path).resolve()

    def get_worktree_path(self, session_id: str) -> Path:
        try:
            return self._paths[session_id]
        except KeyError as exc:
            raise BernsteinError(f"no persisted worktree path for {session_id}") from exc

    def cleanup_worktree(self, session_id: str) -> None:
        worktree = self._paths.get(session_id)
        self.worktree_manager.cleanup(session_id)
        if worktree is not None and worktree.exists():
            raise BernsteinError(f"Bernstein cleanup left worktree in place: {worktree}")
        self._paths.pop(session_id, None)

    @staticmethod
    def filter_parallel_safe(
        wave: list[str], nodes_by_id: dict[str, dict[str, Any]],
    ) -> list[list[str]]:
        parallel = [
            node_id for node_id in wave
            if nodes_by_id[node_id].get("parallel_safe", False)
        ]
        serial = [
            node_id for node_id in wave
            if not nodes_by_id[node_id].get("parallel_safe", False)
        ]
        return ([parallel] if parallel else []) + [[node_id] for node_id in serial]
