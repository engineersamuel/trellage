# Handoff: copilot-cli-aci-minimal

**Date:** 2026-08-28 (updated from 2026-08-27 to add folder-mount support)
**Status:** Verified working end-to-end against a real Azure subscription,
including folder mount + round-trip local sync.
**Location decision:** Standalone repo, deliberately separate from `trellage`.

## Why a separate repo (not inside trellage)

1. The blog goal is "the absolute minimum required." Trellage's locked
   profile compiler, Effect-based CLI, and ARM64-VM workaround for Azure
   are the opposite of minimal — mixing them in would defeat the point.
2. ACI only runs `linux/amd64`, and GitHub Copilot CLI ships a native
   `copilot-linux-x64` binary. This means the ARM64-VM detour trellage
   needed for its Azure `--remote` mode does not apply here. This
   standalone path is genuinely simpler than trellage's Azure path.
3. Trellage's README/tests enforce strict repo-wide contracts. A
   throwaway/educational demo repo should not have to satisfy those.
4. A standalone repo is trivially cloneable and reproducible without any
   trellage context, which is what a blog reader needs.

## IMPORTANT limitation surfaced this session — communicated to the user before implementing

**ACI cannot do a true live bind mount.** ACI containers run on Azure's
infrastructure, not on the local machine. There is no way to point ACI at
a local folder the way `docker run -v $(pwd):/workspace` does — this is a
hard platform limit, not a missing flag.

What's possible instead, and what was implemented: mirror the local folder
into an **Azure File Share**, mount that share into the container at
`/workspace`, and sync the share's contents back to the local folder at
defined sync points (`attach` exit, explicit `sync`, and `down`). This is
not continuously live, but it is a real, verified round trip using only
ACI + Storage — no VM, no SSHFS, staying true to the "minimal" story.

The user was told this limitation explicitly and asked two clarifying
questions (sync-on-exit acceptable? folder as `up` argument vs. separate
sync command?) before implementation began. The runtime then instructed
autonomous completion; the following decisions were made without further
confirmation, using the lowest-risk / most-conventional choice at each
fork:

| Decision | Choice | Rationale |
|---|---|---|
| Sync model | Sync-on-exit (`attach` end) + explicit `sync` command + sync-on-`down` | Matches what the user asked ("if possible... changes would reflect locally"); explicit `sync` gives control without requiring a background daemon. |
| Folder argument | `./run.sh up <folder>` (positional arg) | Matches the user's literal request: "modify run.sh such that it takes a folder path to mount." |
| Mount mechanism | Azure File Share (SMB) mounted via `--azure-file-volume-*` flags on `az container create` | The only ACI-native way to attach persistent, host-writable storage; no VM/SSHFS needed. |
| Upload/download mechanism | `az storage file upload-batch` / `download-batch` | Built into `az`, no extra tooling (no `azcopy` dependency), works for whole-folder recursive copy. |

## What was changed

- `run.sh` — rewritten. New verbs: `up <folder>` (was `up` with no args),
  `attach` (now syncs down automatically on exit), `sync` (new — manual
  pull-down without ending the session), `down` (now syncs down before
  deleting resources). New Azure resources: a Storage Account + File Share
  per demo, in addition to the RG/ACR/ACI from the original version.
- `README.md` — rewritten to document the folder-mount workflow, the
  "not a live mount" limitation up front, the new command table, updated
  cost line for storage, and updated "what this deliberately does NOT do"
  section (no live/continuous sync, no conflict resolution).
- `Dockerfile` — unchanged (still just Debian + git + ca-certificates +
  the `copilot` binary; `WORKDIR /workspace` is where the file share lands).

## Live verification performed this session

Real Azure resources were created, used, and torn down in your subscription:

1. Created a local test folder `/tmp/copilot-test-project` with
   `README.md` and `notes.txt`.
2. `./run.sh up /tmp/copilot-test-project`:
   - Registered `Microsoft.Storage` was already registered (confirmed via
     `az storage account list`).
   - Created resource group, storage account, file share.
   - `az storage file upload-batch` uploaded both local files to the share.
   - `az acr build` built the (unchanged) `Dockerfile` in Azure (~48s).
   - `az container create` started the container with the file share
     mounted at `/workspace` via `--azure-file-volume-*` flags.
3. Verified the mount from inside the running container:
   ```
   $ az container exec ... --exec-command "ls"
   README.md  notes.txt
   $ az container exec ... --exec-command "pwd"
   /workspace
   $ az container exec ... --exec-command "cat /workspace/README.md"
   # Test Project
   ```
   Confirms `az container exec`'s default working directory is already
   `/workspace` (inherited from the image's `WORKDIR`), so `attach` needs
   no extra `cd`.
4. Simulated container-side edits (creating `created-in-container.txt` and
   `README.md.bak` via `az container exec`, since a real interactive
   Copilot CLI session could not be scripted headlessly in this
   environment).
5. Ran `./run.sh sync` and confirmed **both new files appeared in the local
   folder** `/tmp/copilot-test-project` — the full round trip (local →
   Azure File Share → container edit → Azure File Share → local) is proven
   working.
6. Ran `./run.sh down`, which synced down again (idempotent, no new
   changes) and deleted the container + resource group. Polled
   `az group exists` until it returned `false` — full teardown confirmed,
   no lingering Azure resources or cost.
7. Cleaned up all local scratch files (`/tmp/copilot-test-project`, prior
   session's `/tmp/copilot.tar.gz`/`/tmp/copilot` binary, `/tmp/build.log`,
   `/tmp/acr_name.env`).

## Follow-up fix: gitignored / build-artifact uploads

The user reported `up` was uploading gitignored build junk (a Rust
`target/release/.fingerprint/...` tree from an unrelated project used as
the mount test). Root cause: `az storage file upload-batch` uploads the
raw source folder verbatim with no `.gitignore` awareness.

Fix: `run.sh` now stages a filtered copy before uploading (`stage_folder`):
- Git repos: `git ls-files -z --cached --others --exclude-standard` piped
  through `tar` to copy only tracked + untracked-but-not-ignored files.
- Non-git folders: `rsync -a` with a fixed exclude list (`.git`,
  `node_modules`, `target`, `dist`, `build`, `__pycache__`, `.venv`,
  `venv`, `.DS_Store`, `*.pyc`, `.next`, `.cache`).

Verified locally (outside Azure, no cost) with two throwaway test trees:
one git repo with `.gitignore`d `target/`/`node_modules/` (confirmed only
`README.md`/`.gitignore` staged) and one non-git folder with `target/`/
`node_modules/` (confirmed only `README.md` staged, both excluded by the
fallback list).

## Follow-up fix: `down` returning before teardown actually finished

The user noticed `./run.sh down` returned almost instantly and doubted
whether resources were really being deleted. Root cause confirmed with a
live test: `az group delete --yes --no-wait` submits the delete request
and returns in under a second, but the resource group (`az group exists`)
stays `true` for anywhere from ~20 seconds (empty RG) to several minutes
(RG with ACR/ACI/storage) while Azure finishes the teardown server-side.
The old script printed a success-sounding message immediately, which was
misleading even though the deletion request itself was valid.

Fix: `cmd_down` now polls `az group exists` every 5s (up to a 300s
timeout) after issuing the delete, printing progress dots, and only
reports success once the group is actually confirmed gone. If it somehow
exceeds the timeout, it says so explicitly rather than silently hanging
forever, and still points at `az group exists` for a manual check.

Verified live: created two throwaway resource groups (one empty, one with
a real storage account), ran `az group delete --yes --no-wait` against
each, and confirmed via repeated `az group exists` polling that deletion
completion lagged well behind the command returning — then confirmed the
new polling loop in `run.sh` correctly waits for `exists` to flip to
`false` before returning. Both test resource groups deleted, confirmed
gone.

## Follow-up fix: sync was re-copying the entire tree every time

The user noticed that `sync` (including the automatic sync on `attach`
exit) was downloading everything, not just what changed, even though only
one or two files were touched inside the container. Root cause confirmed
by inspecting `az storage file download-batch`'s CLI help: it has no
incremental/overwrite-control flags at all — every run does a full,
unconditional re-copy of the entire share.

Fix: `sync_down` now prefers `azcopy sync` (installed via `brew install
azcopy`), which performs a real size + last-modified-time diff and
transfers only new/changed files — with no `--delete-destination` flag,
so local-only files (e.g. gitignored build artifacts never uploaded in
the first place) are never removed. If `azcopy` isn't installed, `sync`
falls back to the old `download-batch` behavior with a warning suggesting
the install.

Verified live end-to-end using `./run.sh sync` itself (not just raw
`azcopy`) against the actually-running `copilot-aci-demo-rg` container:
- Ran `sync` with no changes on the share → job summary showed
  `Number of Copy Transfers for Files: 0`.
- Created one new file inside the container via `az container exec ...
  touch`, ran `sync` again → job summary showed exactly
  `Number of Copy Transfers for Files: 1`, and the file appeared locally.
- Cleaned up all test marker files from both the container and locally
  afterward; confirmed `git status` in the mounted project showed no
  stray files.

## Known gaps / things NOT tested live this session

- Did not run an actual interactive `copilot` prompt against the mounted
  folder in this session (the previous session already proved Copilot CLI
  itself works inside ACI with a real prompt; this session's focus was
  proving the folder-mount + sync round trip specifically, using direct
  `az container exec` file operations as a stand-in for "Copilot editing a
  file").
- No test of syncing while `attach` is actively open in a second terminal
  (i.e., running `./run.sh sync` concurrently with an open interactive
  session) — should work since it's a separate `az` call, but not verified.
- No test of conflict behavior if the local folder is modified after `up`
  but before the container also modifies the same file (last-write-wins
  from whichever `upload-batch`/`download-batch` runs last; documented as
  an explicit non-goal in the README rather than solved).

## Files ready to hand off

All in `~/copilot-cli-aci-minimal/` (git repo, commit pending for this
change — see below):

```
copilot-cli-aci-minimal/
├── Dockerfile
├── run.sh
├── README.md
└── HANDOFF.md   (this file)
```

## Next steps for you

1. Decide the final home: push to a new GitHub repo or fold into an
   existing blog-content repo. Not yet pushed to any remote.
2. If you want, ask me to run `gh repo create` — give me the name and
   visibility (public/private).
3. Optionally add a `LICENSE` file if this will be public.
4. If you later want closer-to-live sync (e.g., a background loop syncing
   every N seconds while `attach` is open), that's a small addition to
   `run.sh` but intentionally left out here to keep the four-command
   surface area minimal for the blog post.
