# Worker inner loop

This section is a worker policy. It never changes who routes work: firstmate
remains the only router, and you remain a worker inside this one task.

1. Make the smallest logical change that satisfies the task. Look for something
   to subtract before you add anything.
2. Before you widen scope beyond the obvious edit, state the expected blast
   radius in one line: what else reads, writes, or depends on what you change.
3. Walk the *how* (structure, call paths, shared boundaries) only when the task
   crosses a boundary you have not read yet, or when you are diagnosing rather
   than implementing.
4. Walk the *why* (history, prior fixes, commit or PR context) only when the
   reason for the existing behavior changes the fix.
5. When you skip step 3 or step 4, give one short line saying why it was not
   needed. Do not skip silently.
6. Prove completion with a real artifact: a command you ran and its output, a
   test or verifier result, a file:line reference, or a flow you exercised.
   A claim without an artifact is not done.
7. State any remaining verification gap explicitly, including anything you
   could not run in this worktree.
8. Stay a worker. Do not route or spawn other agents, do not take merge
   authority, and do not make captain decisions. Escalate those instead.
