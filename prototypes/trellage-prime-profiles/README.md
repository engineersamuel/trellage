# Native Prime Agent profile

`prx` runs [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent)
directly on the host with an isolated profile. It uses keyless
`copilot-proxy-rs` at `http://127.0.0.1:8080` (Anthropic Messages API), pins
the provider to `copilot-proxy-rs`, and defaults the model to `claude-opus-5`.

This launcher is independent of the Docker `prime-agent` Trellage Sandbox
profile. Native launchers isolate agent state but are not security boundaries.

## Requirements

- `mise`
- `node` 22+
- `npm`
- `curl`
- `jq`
- `uv` (bootstraps the Prime IPython kernel venv; `mise use -g uv` if missing)
- `copilot-proxy-rs` listening on `http://127.0.0.1:8080`

No host model credentials are copied. The launcher materializes an owned
`models.json` with a dummy proxy API key and restores the exact provider and
selected model on every launch so persisted edits cannot redirect the endpoint.
Launch unsets `ANTHROPIC_*`, `OPENAI_API_KEY`, `COPILOT_GITHUB_TOKEN`,
`GH_TOKEN`, and `GITHUB_TOKEN`.

## Install and lifecycle

```bash
./install.sh
prx setup
prx doctor
prx update --check
prx update
prx repair
```

The installer publishes `~/.local/bin/prx` and owns its runtime beneath
`~/.local/share/trellage/prx`. `setup` resolves the latest Prime Agent release
eligible under `mise` policy on first use, installs the release package into a
managed npm prefix, and records the exact installed version in the local
`installed-version` receipt. Ordinary launches reuse that version without a
network request. Only explicit `prx update` resolves latest again. Updates
stage and verify a complete npm prefix before publication.

`prx` records one canonical runtime identity containing the identity schema,
the exact Prime Agent version, a deterministic SHA-256 of the bundled
`dist/prime-agent-runtime` tree, and the managed kernel specification version.
The kernel and daemon stamps include that identity. Normal launch compares
these cheap stamps; `doctor` also hashes the published bundled runtime to
detect content drift. Legacy version-only state causes one managed rebuild
during doctor, repair, or launch. Inventory reports that state as unhealthy
without changing it, and reports `busy` while another profile mutation owns
the lock.

The launcher is named `prx` (Prime + `x`) so it does not collide with macOS
`/bin/pax` (POSIX archive tool). `trx` refuses any `prx` that does not resolve
to the owned runtime under `~/.local/share/trellage/prx/bin/prx`.

Profile state lives at:

```text
~/.local/share/trellage/profiles/prime/default/home/
```

`PRIME_AGENT_CODING_AGENT_DIR` points at that home so configuration, sessions,
and other Prime state stay isolated from direct `prime-agent` use. Setup also
bootstraps an isolated IPython kernel venv at
`…/home/kernel-venv` (Python 3.11, `ipykernel`, `prime-agent-runtime`, and the
default RLM packages). Launch sets `PRIME_AGENT_KERNEL_PYTHON` and
`PRIME_AGENT_KERNEL_VENV` so Prime does not write a half-broken kernel under
`~/.prime/agent/`.

Every setup, repair, and launch also materializes the managed
[`ask_user`](https://github.com/am-will/prime-agent-plugins) extension at
`…/home/extensions/ask-user.ts` (Prime auto-discovers `extensions/*.ts`). Only
that extension is installed—not the full prime-agent-plugins collection. Unmanaged
extensions in the same directory are preserved; do not replace the managed file
with divergent content or a symlink. The extension is a package-owned vendored
asset. Installation checks that the source is a regular file, and profile
verification compares installed bytes directly with that asset. No separate
manually maintained source hash is required.

Prime’s default daemon socket is UID-global, and resident workers inherit the
supervisor environment at spawn — they do **not** receive client
`PRIME_AGENT_KERNEL_*` over the wire. `prx` therefore pins
`--daemon-socket ~/.local/share/trellage/profiles/prime/default/daemon/daemon.sock`
and restarts that profile daemon when its runtime identity or kernel paths
change, so workers see the matching managed venv. Use `prx shutdown` to stop
the profile daemon.

Setup, repair, update, doctor, and launch readiness use a profile-local
owner-token lock. Update verifies the staged npm runtime and identity first,
stops the old profile daemon, backs up all published runtime, receipt, kernel,
and stamp state, and builds the replacement venv at its final path from the
staged npm prefix. It publishes only matching state. A failure restores the
previous state and leaves any stopped daemon stopped; the next launch starts a
clean daemon lazily. Launch also stops the profile daemon before it replaces a
stale or incomplete kernel venv.

Kernel bootstrap needs network access to a PyPI simple index; if
`files.pythonhosted.org` is unreachable, `prx` falls back to
`https://mirrors.aliyun.com/pypi/simple`. Setup and repair refuse symlinked
paths or unrelated existing profile files. Uninstall preserves this profile.

Bare and explicit launches are equivalent:

```bash
prx
prx default
prx -p "Reply exactly PRX_OK"
```

Arguments pass after managed `--provider copilot-proxy-rs`, `--model`,
`--offline`, and `--autonomous` flags. Pass `--model MODEL` or `--model=MODEL`
to select another model advertised by the proxy. `doctor` verifies proxy health
and confirms that the default `claude-opus-5` model is advertised.

Long-running interactive sessions may leave Prime background workers on the
profile socket. Stop them with:

```bash
prx shutdown
```

Prefer `-p` / `--print` for one-shot smoke tests.

`prx` adds no containment. Prime Agent runs with all host access available to
the process.

## Uninstall

```bash
./uninstall.sh
```

## Test

```bash
make native-prime-profile
```
