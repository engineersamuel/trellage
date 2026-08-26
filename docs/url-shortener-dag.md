# URL Shortener — Bernstein DAG

Tasks marked `[P]` are Bernstein-parallel: their read sets and write sets do not
intersect, so they may run concurrently in isolated worktrees.

## Task graph

```
                 T001 spec
                  /      \
                 /        \
          T002 [P]        T003 [P]
          tests/          shortener/
                \        /
                 \      /
                  T004 gate
                     |
                  T005 review
```

## Tasks

- [ ] **T001** — Write the spec (this file's sibling, `url-shortener-spec.md`).
      Blocks everything.
      Writes: `docs/`.
- [ ] **T002** `[P]` — Failing tests for shorten + redirect. Blocked by T001.
      Writes: `tests/` only. Reads: `docs/url-shortener-spec.md`.
- [ ] **T003** `[P]` — In-memory store + HTTP handlers. Blocked by T001 only —
      explicitly *not* blocked by T002, so the two run in parallel.
      Writes: `shortener/*.py` only. Reads: `docs/url-shortener-spec.md`.
- [ ] **T004** — Wire the server, merge both worktrees, run the suite.
      Blocked by T002 **and** T003. This is the gate.
      Writes: `shortener/server.py`, merge commits.
- [ ] **T005** — Review and fix. Blocked by T004.
      Writes: `reviews/`.

## Bernstein conditions for T002 ∥ T003

| Task | Read set | Write set |
|------|----------|-----------|
| T002 | `docs/url-shortener-spec.md` | `tests/**` |
| T003 | `docs/url-shortener-spec.md` | `shortener/*.py` |

- W(T002) ∩ W(T003) = ∅ — no output dependency.
- W(T002) ∩ R(T003) = ∅ — no anti-dependency.
- W(T003) ∩ R(T002) = ∅ — no flow dependency.

All three conditions hold, so the two tasks are safe to run in parallel.
T002 writing tests against a module T003 has not written yet is intentional:
under TDD those tests are expected to fail until the merge at T004.

## Gate

T004 is green only when:

```
python3 -m unittest discover -s tests -t . -v
```

exits 0. If it exits non-zero, the responsible bead is reopened
(`bd update <id> --status open`) and "done" is taken back — no merge.
