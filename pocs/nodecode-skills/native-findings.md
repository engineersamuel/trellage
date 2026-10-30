# Native knowledge/instruction spike

## Result

**B is feasible on installed Nodecode `0.1.1+6d58aa70b`.** A generated knowledge-only cell is discoverable through Nodecode's real knowledge index/help APIs, its contents do not execute, and its registration can be replaced without overwriting user learning. Home `AGENTS.md` is the actual composed-instruction loader.

**Important additional lifecycle requirement:** existing conversations pin their knowledge index. Removing a managed skill removes fresh knowledge/help lookup immediately, but the conversation's pinned index continues advertising the old name until explicit index refresh, eviction, or a fresh conversation. Production reconciliation must address this separately; restarting a process is not enough to assume a durable conversation's pinned index changed.

## Reproduce

```sh
python3 pocs/nodecode-skills/native-probe.py
# Optional: preserve the disposable home and per-phase reports/input forms:
python3 pocs/nodecode-skills/native-probe.py --keep
# An explicit executable can be selected with --nodecode PATH.
```

Verified locally: **34 checks passed**, repeated successfully, zero model calls. The only external executable needed by the probe is the installed `nodecode` (and its normal runtime prerequisites); the driver uses Python 3's standard library.

The driver invokes the binary's **internal** `trial` entrypoint, not a supported public automation CLI. `trial` loads the home normally, evaluates one Lisp form from stdin, and reports a numeric score. It suppresses ordinary form output and resets `nlk::*cells-directory*` before evaluation, so the probe explicitly binds that variable back to its disposable home's `cells/` when querying knowledge. This is a version-specific testing seam, not a recommended production integration API.

Every child receives a stripped environment containing only `PATH`, disposable `HOME`, disposable `NODECODE_HOME`, and disposable XDG paths. Updates are off. No RPC turn or provider method is invoked. No normal Nodecode home, credentials, config, or learned state is copied into the fixture. The default run removes its temporary evidence. `--keep` intentionally retains it.

## Proven packaging

A cell folder named `trellage-knowledge` contains `trellage-knowledge.asd`:

```lisp
(defsystem "trellage-knowledge"
  :class nodecode.kernel:layer
  :depends-on ("nodecode")
  :properties ((:knowledge . t))
  :components ())
```

One generated `.lisp` file per skill:

```lisp
(define-skill trellage-example "A short description"
  "The entire skill document, correctly escaped as a Lisp string.")
```

The generator must own the `.asd` and serialize strings; upstream prose is data, never a source template, executable cell, or arbitrary `.asd` file. No Git repository was required for native discovery in this spike. Managed folders should not masquerade as the mutable user layer.

A stable cell symlink can point to an immutable snapshot outside generations:

```text
home/
  cells/
    trellage-knowledge -> ../managed/snapshots/v2/trellage-knowledge
    user-memory/           # untouched fixture of user-owned knowledge
    user-learning/         # untouched fixture of executable user learning
  managed/
    snapshots/v1/trellage-knowledge/{*.asd,*.lisp}
    snapshots/v1/assets/large.txt
    snapshots/v2/trellage-knowledge/{*.asd,*.lisp}
    private/i-have-adhd/SKILL.md
```

Native knowledge discovery follows the cell symlink. An atomic rename of a replacement symlink updates lookups in the same process, including when the old and new ordinary skill files deliberately have identical lengths and mtimes. Removing the registration removes discovery while leaving retained snapshots usable by existing readers. This is evidence for immutable snapshot registration, **not** a full atomic publisher or garbage collector.

## What the 34 checks establish

- Boot reports the generated cell as `:knowledge`, not executable code.
- Selected ordinary and always fixtures appear in native help/knowledge and the actual request's pinned index.
- A private manual-only fixture appears in neither discovery nor the pinned index.
- Code-looking prose is readable unchanged. Raw executable and `#.` reader-eval forms placed in knowledge files do not create their side-effect sentinel files during boot/indexing.
- Knowledge reads do not intern generated names into the live evolved package.
- User-owned prose knowledge and a callable learned function coexist with managed cells and survive update/removal/relaunch; their fixture files remain byte-identical.
- A real disposable durable session and its user-owned harness section survive reconciliation/relaunch.
- Home `AGENTS.md` reaches `read-harness-sections` as `operator-rules`; project `AGENTS.md` independently reaches it as `instructions`.
- Editing home instructions is reflected on the next section assembly; deletion withdraws them. A file of 65,537 characters is rejected whole (the implementation counts characters, despite some names saying bytes).
- Retargeting the managed cell updates fresh lookup immediately and removes the deselected always fixture in the same image. Relaunch has one managed cell, not duplicates.
- An old complete asset larger than 8 KiB remains readable after registration advances.
- The old pinned conversation index **does remain stale** after deselection. Calling `nlk:mark-index-refresh` then rebuilding request sections removes the stale name.
- Removing the cell registration takes effect for fresh discovery immediately and for the cell boot report on the next process start.

## API/source evidence

Installed source root: `~/.local/share/nodecode/current/src/`.

- `src/organism/cells.lisp`: `make-cell-folder`, `cell-folder-knowledge-p`, `folder-records`, `load-cells`. Knowledge cells are classified from `.asd` data and never loaded.
- `src/organism/knowledge.lisp`: `knowledge-entries`, `knowledge-entry-named`, `knowledge-help-text`, `knowledge-surface`, `pin-index-section`, `mark-index-refresh`. The parser binds `*read-eval*` false and uses a temporary package; the memo keys include resolved paths, file size, and whole-second mtime.
- `src/organism/scribe.lisp`: `fresh-layer-system` and `ensure-knowledge-system` show the canonical knowledge declaration.
- `src/engine/context.lisp`: `operator-rules-section`, `read-harness-sections`. These are internal request-assembly functions used directly by the offline spike.
- `src/engine/turn.lisp`: `index-slash` implements `/index reload` using `mark-index-refresh`.
- `src/organism/launch.lisp`: `trial-main`, `throwaway-environment` describe the test seam and home isolation requirement.
- Public references checked: <https://nodecode.ai/docs/cells>, <https://nodecode.ai/docs/instructions>, <https://nodecode.ai/docs/cell-api>.

## Boundaries and next decisions

This does **not** prove model compliance, a real user skill workflow, Trellage's source/profile selection pipeline, floating refresh, a production manual dispatcher, command/UI behavior, concurrent publishers, rollback, crash consistency, or a safe snapshot garbage collector. No production Trellage adapter was changed. The complete-asset test proves retained snapshot readability, not Office/tool dependency compatibility.

The durable-state proof is a real session record and a standing section, not a populated conversation with tool calls. The user-learning fixtures were installed as user-owned files, not written by paid model inference.

Instructions need ownership-aware merging: blindly replacing home `AGENTS.md` would overwrite user rules. Knowledge registration and instruction publication are separate native surfaces; one symlink rename does not atomically update both.

A versioned bridge can refresh the native pinned index at an appropriate session boundary, or the product can explicitly require `/index reload`/a fresh conversation after selection changes. Do not silently promise immediate removal from existing prompt context. Even a refreshed index does not erase previously learned or conversation-retained content. The manual-only store is a discovery boundary, not a host filesystem sandbox.
