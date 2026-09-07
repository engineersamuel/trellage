#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

python3 - <<'PY'
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tomllib

root = Path.cwd()
fixture = root / "tests" / f".run-agent-session.{os.getpid()}"
fixture.mkdir()
try:
    workspace = fixture / "workspace"
    bin_dir = fixture / "bin"
    opt = fixture / "opt"
    copilot_home = workspace / ".copilot-home"
    codex_home = workspace / ".codex-home"
    for directory in (bin_dir, copilot_home, codex_home, fixture / "secrets"):
        directory.mkdir(parents=True, exist_ok=True)
    plugin = opt / "awesome-plugins/demo/.github/plugin"
    plugin.mkdir(parents=True)
    (plugin / "plugin.json").write_text('{"name":"demo"}')
    instructions = fixture / "share/trellage/copilot-instructions"
    instructions.mkdir(parents=True)
    (instructions / "rundown.instructions.md").write_text("Fixture instructions\n")
    (fixture / "secrets/copilot_token").write_text("fixture-token")
    shutil.copyfile(root / "docker/codex-config.toml", codex_home / "config.toml")

    # Execute the shipped scripts with only container filesystem roots remapped.
    for name in (
        "run-agent.sh", "run-copilot-agent.sh",
        "copilot-agent-entrypoint.sh", "find-harness-session.sh",
    ):
        source = (root / "scripts" / name).read_text()
        for container_path, local_path in (
            ("/workspace", workspace),
            ("/usr/local/bin", bin_dir),
            ("/usr/local/share", fixture / "share"),
            ("/run/secrets", fixture / "secrets"),
            ("/opt", opt),
        ):
            source = source.replace(container_path, str(local_path))
        target = bin_dir / name
        target.write_text(source)
        target.chmod(0o755)

    fake_runtime = '''\
import json
import os
from pathlib import Path
import sys
import tomllib

runtime = Path(sys.argv[0]).name
args = sys.argv[1:]
if args == ["--version"]:
    print(f"{runtime} fixture")
    sys.exit(0)
workspace = Path(os.environ["FIXTURE_WORKSPACE"])
home = Path(os.environ[f"{runtime.upper()}_HOME"])
if runtime == "codex":
    config = tomllib.loads((home / "config.toml").read_text())
    model_override = None
    index = 0
    while index < len(args):
        argument = args[index]
        if argument == "--":
            break
        value = None
        if argument in ("-c", "--config", "-m", "--model"):
            index += 1
            value = args[index]
        elif argument.startswith(("--config=", "--model=")):
            argument, value = argument.split("=", 1)
        elif argument.startswith(("-c", "-m")) and len(argument) > 2:
            argument, value = argument[:2], argument[2:]
        if argument in ("-c", "--config"):
            key, raw = value.split("=", 1)
            try:
                config.update(tomllib.loads(f"{key} = {raw}"))
            except tomllib.TOMLDecodeError:
                config[key.strip()] = raw.strip()
        elif argument in ("-m", "--model"):
            assert model_override is None, "Codex rejects duplicate --model flags"
            model_override = value
        index += 1
    model = model_override or config["model"]
    effort = config["model_reasoning_effort"]
    session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    session = home / "sessions/fixture.jsonl"
    session.parent.mkdir(parents=True, exist_ok=True)
    session.write_text(json.dumps({
        "type": "session_meta", "payload": {"cwd": str(workspace), "id": session_id},
    }) + "\\n")
    print(json.dumps({"type": "thread.started", "thread_id": session_id}))
else:
    config_file = home / "config.json"
    config = json.loads(config_file.read_text()) if config_file.exists() else {}
    model = args[args.index("--model") + 1]
    effort = args[args.index("--reasoning-effort") + 1]
    session_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    session = home / "session-state" / session_id / "workspace.yaml"
    session.parent.mkdir(parents=True, exist_ok=True)
    session.write_text(f"cwd: {workspace}\\n")
    print(json.dumps({"type": "assistant.message", "data": {"content": "OK"}}))
    print(json.dumps({"type": "result", "sessionId": session_id}))
(workspace / f"{runtime}-call.json").write_text(json.dumps({
    "model": model, "reasoningEffort": effort, "args": args, "config": config,
}))
'''
    for name in ("codex", "copilot"):
        path = bin_dir / name
        path.write_text(f"#!{sys.executable}\n{fake_runtime}")
        path.chmod(0o755)

    fake_curl = '''\
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
if any(argument.endswith("/health") for argument in args):
    print('{"status":"ok"}')
elif any(argument.endswith("/v1/models") for argument in args):
    print(json.dumps({"models": [{
        "slug": os.environ["FIXTURE_MODEL"], "supported_endpoints": ["/responses"],
    }]}))
elif any(argument.endswith("/v1/responses") for argument in args):
    request = json.loads(args[args.index("-d") + 1])
    (Path(os.environ["FIXTURE_WORKSPACE"]) / "proxy-request.json").write_text(json.dumps(request))
    print('{"output":[{"content":[{"type":"output_text","text":"PROXY_OK"}]}]}')
else:
    sys.exit(1)
'''
    (bin_dir / "curl").write_text(f"#!{sys.executable}\n{fake_curl}")
    (bin_dir / "curl").chmod(0o755)
    for name in ("node", "git"):
        (bin_dir / name).write_text("#!/bin/sh\nexit 0\n")
        (bin_dir / name).chmod(0o755)
    (bin_dir / "find").write_text(
        f"#!{sys.executable}\n"
        "from pathlib import Path\nimport os\nimport sys\n"
        "if '-printf' not in sys.argv:\n"
        f"    os.execv({shutil.which('find')!r}, sys.argv)\n"
        "root = Path(sys.argv[1])\n"
        "for path in root.rglob('*'):\n"
        "    if path.is_file(): print(path.relative_to(root))\n"
    )
    (bin_dir / "find").chmod(0o755)
    (bin_dir / "mktemp").write_text(
        f"#!{sys.executable}\n"
        "import os\nfrom pathlib import Path\nimport sys\n"
        "path = Path(sys.argv[1].replace('XXXXXX', str(os.getpid())))\n"
        "assert path.is_relative_to(Path(os.environ['FIXTURE_ROOT']))\n"
        "path.touch(exist_ok=False)\nprint(path)\n"
    )
    (bin_dir / "mktemp").chmod(0o755)

    env = {
        key: value for key, value in os.environ.items()
        if not key.startswith(("COPILOT_", "CODEX_", "GIT_"))
        and key not in ("GH_TOKEN", "GITHUB_TOKEN")
    }
    env.update({
        "HOME": str(fixture), "CODEX_HOME": str(codex_home),
        "COPILOT_HOME": str(copilot_home), "PATH": f"{bin_dir}:{env['PATH']}",
        "FIXTURE_ROOT": str(fixture), "FIXTURE_WORKSPACE": str(workspace),
    })
    def check(runtime, mode, model="gpt-6-astra", effort="max", overrides=None, arguments=(), plan_effort="max"):
        config_file = copilot_home / "config.json"
        stored_config = config_file.read_bytes() if config_file.exists() else None
        config_mode = config_file.stat().st_mode if config_file.exists() else None
        command = [str(bin_dir / ("run-agent.sh" if runtime == "codex" else "run-copilot-agent.sh"))]
        if runtime == "copilot":
            command.insert(0, str(bin_dir / "copilot-agent-entrypoint.sh"))
        result = subprocess.run(
            [*command, mode, *arguments, "Reply exactly OK"],
            env={**env, "FIXTURE_MODEL": model, **(overrides or {})},
            text=True, capture_output=True,
        )
        assert result.returncode == 0, (runtime, mode, result.stdout, result.stderr)
        launch = json.loads((workspace / f"{runtime}-call.json").read_text())
        receipt = json.loads((workspace / f".harness/{runtime}-runtime.json").read_text())
        assert receipt["runtime"] == runtime, receipt
        assert receipt["provider"] == (
            "copilot-proxy-rs" if runtime == "codex" else "github-copilot-native"
        ), receipt
        for configuration in (launch, receipt):
            assert configuration["model"] == model, configuration
            assert configuration["reasoningEffort"] == effort, configuration
        session_id = (workspace / f".harness/{runtime}-session-id").read_text().strip()
        if mode == "--resume":
            assert session_id in launch["args"] or f"--resume={session_id}" in launch["args"]
        if runtime == "codex":
            assert launch["config"]["plan_mode_reasoning_effort"] == plan_effort, launch
            request = json.loads((workspace / "proxy-request.json").read_text())
            assert request["model"] == model, request
            assert request["reasoning"]["effort"] == effort, request
        else:
            if stored_config is None:
                assert not config_file.exists(), "Copilot launch created persistent config"
            else:
                assert config_file.read_bytes() == stored_config, "Copilot launch changed persistent config"
                assert config_file.stat().st_mode == config_mode, "Copilot launch changed config permissions"

    check("codex", "--new")
    check("copilot", "--new")
    (copilot_home / "config.json").write_text(
        '{"model":"gpt-stored","reasoningEffort":"low","theme":"dark"}'
    )
    (copilot_home / "config.json").chmod(0o600)
    for runtime in ("codex", "copilot"):
        (workspace / f".harness/{runtime}-session-id").unlink()
        check(runtime, "--resume", "gpt-5.5", "high", {
            f"{runtime.upper()}_MODEL": "gpt-5.5",
            f"{runtime.upper()}_REASONING_EFFORT": "high",
        }, plan_effort="high")
    check("codex", "--new", "gpt-5.5", "medium", arguments=(
        "--model", "gpt-5.5", "-c", 'model_reasoning_effort="medium"',
    ))
    check("codex", "--resume", "gpt-5.5", "low", arguments=(
        "--config=model='gpt-5.5'", "--config=model_reasoning_effort='low'",
    ))
    check("codex", "--new", "gpt-5.5", "high", arguments=(
        "-mgpt-5.5", "-cmodel=gpt-override", "-cmodel_reasoning_effort=high",
        "--config=plan_mode_reasoning_effort=medium",
    ), plan_effort="medium")
finally:
    shutil.rmtree(fixture)
PY

grep -Fq '/workspace/.harness/agent-package-inventory.txt' scripts/agent-entrypoint.sh || {
  printf 'run agent session: FAIL: Codex package inventory is missing\n' >&2
  exit 1
}

printf 'run agent session: PASS\n'
