# copilot-cli-aci-minimal

The absolute minimum required to run [GitHub Copilot CLI](https://github.com/github/copilot-cli)
inside an isolated, on-demand Azure Container Instance (ACI), working
against a real local project folder — with a full interactive PTY, and
nothing else.

This is a companion to a blog post. It is intentionally not a framework:
one Dockerfile, one lifecycle script, four commands.

## Why this is simple

- ACI only runs `linux/amd64`. GitHub publishes a native `copilot-linux-x64`
  binary. No emulation, no translation VM, no architecture workaround.
- The image build happens in Azure itself (`az acr build`), so you do not
  need Docker installed locally at all.
- Azure Container Registry (ACR), Container Instances (ACI), and Storage
  (for the mounted folder) are the only Azure services involved.

## Important: this is not a live bind mount

**ACI containers do not run on your machine.** Unlike local Docker's
`-v $(pwd):/workspace`, there is no way to bind-mount your Mac/Linux
filesystem directly into an Azure-hosted container — that is a hard
platform limit, not a missing flag.

Instead, `run.sh up <folder>` mirrors your folder into an Azure File Share,
which is mounted into the container at `/workspace`. Changes made inside the
container are synced back to your local folder when you run `./run.sh sync`,
when `./run.sh attach` exits, and again during `./run.sh down`. So:

- Editing files with Copilot CLI inside the container **does** eventually
  reflect on your local disk — after a sync point, not continuously live.
- If you edit the local folder again while the container is still running,
  re-run `./run.sh up <folder>` (or upload manually) to push those changes
  back up before your next `attach`.

## What gets uploaded

`up <folder>` never uploads the raw folder as-is. It first stages a filtered
copy:

- **Git repos**: uses `git ls-files --cached --others --exclude-standard`,
  so anything covered by `.gitignore` (`target/`, `node_modules/`,
  `.venv/`, build output, etc.) is skipped, exactly like `git status` would
  skip it. `.git/` itself is also never uploaded.
- **Non-git folders**: falls back to a fixed exclude list covering the
  common cases (`.git`, `node_modules`, `target`, `dist`, `build`,
  `__pycache__`, `.venv`, `venv`, `.DS_Store`, `*.pyc`, `.next`, `.cache`).

This keeps uploads fast and avoids syncing large, disposable build
artifacts (e.g. a Rust `target/release` directory) to Azure Storage.


## Prerequisites

- Azure CLI, logged in: `az login`
- GitHub CLI, logged in: `gh auth login` (or set `GH_TOKEN` to a token with
  Copilot access)
- An Azure subscription with `Microsoft.ContainerRegistry`,
  `Microsoft.ContainerInstance`, and `Microsoft.Storage` registered. If they
  are not, `run.sh` will fail with `MissingSubscriptionRegistration`;
  register with:
  ```bash
  az provider register --namespace Microsoft.ContainerRegistry
  az provider register --namespace Microsoft.ContainerInstance
  az provider register --namespace Microsoft.Storage
  ```
  (This can take a few minutes the first time on a subscription.)
- **Recommended:** `azcopy` (`brew install azcopy` on macOS), so `sync`
  only transfers files that actually changed. Without it, `sync` falls
  back to `az storage file download-batch`, which always re-copies every
  file in the share on every run.

## Use

```bash
git clone <this-repo>
cd copilot-cli-aci-minimal

chmod +x run.sh
./run.sh up ~/code/my-project   # ~1-2 minutes: creates a resource group, a
                                # storage account + file share (uploads your
                                # folder), an ACR, builds the image in Azure,
                                # and starts the container with the folder
                                # mounted at /workspace
./run.sh attach                 # drops you into an interactive Copilot CLI
                                # session at /workspace; syncs changes back
                                # to ~/code/my-project when the session ends
./run.sh sync                   # optional: pull container changes down at
                                # any time without ending the session
./run.sh down                   # syncs down, deletes everything, and waits
                                # until the resource group is actually gone
```

That's it. Exit Copilot CLI (or press Ctrl-D) to end the `attach` session —
`run.sh` automatically syncs the folder back down at that point. Run
`./run.sh down` when you are completely done to delete all Azure resources.

## What `run.sh` actually does

| Step | Command | Purpose |
|------|---------|---------|
| `up` | `az group create` | isolated resource group for this demo |
| `up` | `az storage account create` + `az storage share create` | holds the mirrored folder |
| `up` | stage folder (git-aware or default excludes), then `az storage file upload-batch` | pushes `<folder>` up to the file share, skipping `.gitignore`d / build-artifact files |
| `up` | `az acr create --admin-enabled true` | a registry to hold the built image |
| `up` | `az acr build` | builds `Dockerfile` **in Azure**, no local Docker needed |
| `up` | `az container create --azure-file-volume-*` | mounts the file share at `/workspace`, plus `COPILOT_GITHUB_TOKEN` |
| `attach` | `az container exec --exec-command copilot` | interactive PTY session at `/workspace`, syncs down on exit |
| `sync` | `azcopy sync` (falls back to `az storage file download-batch` if azcopy isn't installed) | pulls only new/changed files back to `<folder>` on demand |
| `down` | sync down, then `az container delete` + `az group delete --no-wait`, polling `az group exists` until it's actually gone | full teardown, confirmed rather than assumed |

## The Dockerfile

```dockerfile
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*
ARG COPILOT_VERSION=v1.0.80
RUN curl -fsSL "https://github.com/github/copilot-cli/releases/download/${COPILOT_VERSION}/copilot-linux-x64.tar.gz" -o /tmp/copilot.tar.gz \
    && tar -xzf /tmp/copilot.tar.gz -C /usr/local/bin \
    && rm /tmp/copilot.tar.gz \
    && chmod +x /usr/local/bin/copilot \
    && copilot --version
WORKDIR /workspace
CMD ["copilot"]
```

That is the entire image: a slim Debian base, `git` (Copilot CLI shells out
to it) and `ca-certificates` (for HTTPS), plus the single self-contained
`copilot` binary from GitHub's release page. No Node.js install step is
needed — the published binary is a standalone executable. `/workspace` is
where the Azure File Share gets mounted at container-create time.

## Cost

Per-second/per-GB billing while resources exist:

- ACR Basic: ~$0.167/day (~$5/month) while it exists — delete it when done.
- ACI (2 vCPU / 4 GB): ~$0.10-0.12/hour while the container is running.
- Storage account + file share: a few cents/month for typical project sizes.

Run `./run.sh down` as soon as you are finished. There is no auto-shutdown;
this script does not run anything continuously.

## What this deliberately does NOT do

This is the minimum viable proof, not a production tool:

- **No live/continuous sync.** Changes reflect locally only after a sync
  point (`attach` exit, `sync`, or `down`) — see the note above.
- No session persistence across `down`/`up` cycles.
- Uses ACR **admin credentials** for simplicity. For anything beyond a demo,
  switch to a Managed Identity with the `AcrPull` role instead.
- No multi-session support, no shared container, no auto-teardown-on-exit,
  no conflict resolution if both sides change the same file between syncs.

If you need any of the above, see the `trellage` project's
`--remote`/`-r` Azure execution mode, which builds on similar primitives
(cloud image build + container lifecycle) but uses a VM + `rsync`/SSH for
closer-to-live sync, plus locked profiles and multi-harness support.
