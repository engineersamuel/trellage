#!/usr/bin/env python3
"""Execute reviewed Firstmate entry points with real Git and fake external tools."""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

COMMIT = "527aa7c12d25aadbdf3cc56791f87ae71fca5280"
OWNER = "trellage-firstmate-profiles-v1"


def run(argv, env, cwd=None, data=None, success=True):
    result = subprocess.run(
        [str(value) for value in argv], env=env, cwd=cwd, input=data,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False,
    )
    if success is not None:
        assert (result.returncode == 0) == success, (
            f"{argv}: exit {result.returncode}\n"
            + result.stdout.decode(errors="replace") + result.stderr.decode(errors="replace")
        )
    return result


def executable(path, body):
    path.write_text("#!/usr/bin/env bash\nset -eu\n" + body)
    path.chmod(0o755)


class Pinned:
    def __init__(self, argv):
        fixture, package, install, profiles, fakebin, realgit, realbash, home, gh = map(Path, argv)
        self.package, self.install, self.profiles = package, install, profiles
        self.work = fixture / "pinned-contract"
        self.work.mkdir()
        self.runtime = self.work / "runtime"
        shutil.copytree(package / "tests/fixtures/firstmate" / COMMIT, self.runtime)
        self.external = self.work / "external"
        self.external.mkdir()
        self.external_log = self.work / "external.log"
        self.external_log.touch()
        self.launch_log = self.work / "launch.log"
        self.launch_log.touch()
        self.env = {
            "HOME": str(home), "PATH": str(self.external) + ":" + str(fakebin),
            "TMPDIR": str(fixture / "scratch"), "GH_CONFIG_DIR": str(gh),
            "NATIVE_CLAUDE_LOG": str(self.work / "native.log"),
            "NATIVE_CLAUDE_LAUNCH_LOG": str(self.work / "claude.log"),
            "FAKE_GIT_LOG": str(self.work / "git.log"),
            "FAKE_GH_LOG": str(self.work / "gh.log"),
            "FMX_WORKER_LAUNCHER": str(install / "lib/fmx-worker"),
            "FMX_WORKER_HOME": str(home),
            "FMX_WORKER_PATH": str(self.external) + ":" + str(fakebin),
            "FMX_WORKER_BASH": str(realbash),
            "FMX_GH_CONFIG_DIR": str(gh),
            "FMX_CAPTAIN_PANE_ID": "",
            "FM_SPAWN_NO_GUARD": "1",
            "FM_BACKEND": "tmux",
            "FM_TEST_EXTERNAL_LOG": str(self.external_log),
            "FM_TEST_LAUNCH_LOG": str(self.launch_log),
            "FM_TEST_ALLOWLIST_LOG": str(self.work / "allowlist.log"),
            "FM_TEST_TASKS_STATE": str(self.work / "tasks-state"),
            "TMUX": "fake,1,0",
        }
        self.external.joinpath("git").symlink_to(realgit)
        Path(self.env["FM_TEST_TASKS_STATE"]).mkdir()
        self.make_external_tools()
        run([
            sys.executable, package / "lib/fmx-overlay.py",
            "--root", self.runtime, "--manifest", package / "overlay" / COMMIT / "manifest.json",
            "--commit", COMMIT,
        ], self.env)
        run([
            sys.executable, package / "lib/fmx-overlay.py",
            "--root", self.runtime, "--manifest", package / "overlay" / COMMIT / "manifest.json",
            "--commit", COMMIT, "--verify-only",
        ], self.env)
        self.select_profile("default", "fmd")

    def make_external_tools(self):
        executable(self.external / "tmux", r'''
printf '%s\n' "tmux $*" >>"$FM_TEST_EXTERNAL_LOG"
if [[ -n "${FM_TEST_CONTROL_STATE:-}" ]]; then
  state=$(cat "$FM_TEST_CONTROL_STATE")
  case "$1:$*" in
    list-windows:*)
      [[ "$state" == absent ]] || printf 'fm-%s\n' "$FM_TEST_CONTROL_TASK"
      exit 0 ;;
    new-window:*) printf 'dead\n' >"$FM_TEST_CONTROL_STATE"; printf '@42\n'; exit 0 ;;
    display-message:*pane_current_command*)
      if [[ "$state" == alive ]]; then printf 'claude\n'; else printf 'bash\n'; fi
      exit 0 ;;
    display-message:*pane_tty*) exit 0 ;;
    display-message:*cursor_y*) printf '0\n'; exit 0 ;;
    capture-pane:*) printf '❯ \n'; exit 0 ;;
    send-keys:*)
      previous=''
      for value in "$@"; do
        if [[ "$previous" == -l ]]; then
          case "$value" in
            /exit) printf 'exit\n' >"$FM_TEST_CONTROL_STATE.pending" ;;
            *fmx-worker*)
              printf '%s\n' "$value" >>"$FM_TEST_LAUNCH_LOG"
              printf 'launch\n' >"$FM_TEST_CONTROL_STATE.pending" ;;
          esac
        fi
        previous="$value"
      done
      if [[ "$previous" == Enter && -f "$FM_TEST_CONTROL_STATE.pending" ]]; then
        case "$(cat "$FM_TEST_CONTROL_STATE.pending")" in
          exit) printf 'dead\n' >"$FM_TEST_CONTROL_STATE" ;;
          launch) printf 'alive\n' >"$FM_TEST_CONTROL_STATE" ;;
        esac
        rm "$FM_TEST_CONTROL_STATE.pending"
      fi
      exit 0 ;;
  esac
fi
case "$*" in
  *'#{pane_current_path}'*) printf '%s\n' "$FM_TEST_WORKTREE"; exit 0 ;;
esac
case "${1-}" in
  new-window) printf '@42\n' ;;
  display-message) printf 'firstmate\n' ;;
  send-keys)
    previous=''
    for value in "$@"; do
      if [[ "$previous" == -l ]]; then printf '%s\n' "$value" >>"$FM_TEST_LAUNCH_LOG"; fi
      previous="$value"
    done ;;
esac
''')
        for tool in ("treehouse", "ssh", "herdr"):
            executable(self.external / tool, f'printf "%s\\n" "{tool} $*" >>"$FM_TEST_EXTERNAL_LOG"\n')
        executable(self.external / "sleep", "exit 0\n")
        executable(self.external / "timeout", 'if [[ "${1-}" == -k ]]; then shift 2; fi\nshift\nexec "$@"\n')
        executable(self.external / "claude", 'printf "2.1.233 (Claude Code)\\n"\n')
        executable(self.external / "tasks-axi", r'''
case "$*" in
  --version) printf 'tasks-axi 0.2.5\n' ;;
  'update --help') printf '%s\n' '--archive-body' ;;
  'mv --help') printf '%s\n' '[<id>...]' ;;
  show*)
    state=queued
    [[ ! -f "$FM_TEST_TASKS_STATE/$2" ]] || state=in_flight
    printf '  state: %s\n  held: no\n  blocked: no\n' "$state" ;;
  start*) : >"$FM_TEST_TASKS_STATE/$2" ;;
  list*) printf '[]\n' ;;
esac
''')

    def select_profile(self, profile, prefix):
        self.profile = self.profiles / profile
        self.home = self.profile / "home"
        self.prefix = prefix
        self.env.update(
            FM_HOME=str(self.home), FMX_PROFILE=profile, FMX_PROFILE_ROOT=str(self.profile),
            FMX_TASK_ID_PREFIX=prefix, FM_ROOT_OVERRIDE=str(self.runtime),
        )
        self.env.pop("FMX_WORKER_POLICY_FILE", None)
        if profile == "pstack-workers":
            self.env["FMX_WORKER_POLICY_FILE"] = str(self.profile / "policy/worker-policy.md")

    def entry(self, script, *args, success=True, data=None):
        return run([self.runtime / "bin" / script, *args], self.env, self.runtime, data, success)

    def refused(self, script, *args):
        self.external_log.write_text("")
        before = sorted(path.relative_to(self.home).as_posix() for path in self.home.rglob("*"))
        self.entry(script, *args, success=False)
        assert self.external_log.read_text() == "", f"{script} reached an external resource"
        after = sorted(path.relative_to(self.home).as_posix() for path in self.home.rglob("*"))
        assert before == after, f"{script} created resources before admission"

    def early_admission(self):
        for args in (
            ("fmd-wrong-kind", "host:project", "--secondmate"),
            ("fmd-wrong-harness", "project", "--harness", "codex"),
            ("fmd-raw", "project", "claude --model opus"),
            ("fmp-foreign", "project"),
            ("fmd-bad-backend", "project", "--backend", "remote"),
            ("fmd-bad-model", "project", "--model", "gpt-5"),
            ("fmd-bad-effort", "project", "--effort", "automatic"),
            ("fmd-batch=project", "fmp-foreign=project"),
            ("fmd-batch=project", "--secondmate"),
            ("fmd-herdr", "project", "--backend", "herdr"),
        ):
            self.refused("fm-spawn.sh", *args)
        record = self.home / "state/fmd-restored.meta"
        for fields in (
            "kind=secondmate\nharness=claude\nbackend=tmux\n",
            "kind=ship\nharness=codex\nbackend=tmux\n",
            "kind=ship\nharness=claude\nbackend=remote\n",
            "kind=scout\nharness=claude\nbackend=tmux\nremote_host=example.invalid\n",
            "harness=claude\nbackend=tmux\n",
        ):
            record.write_text(fields)
            self.refused("fm-spawn.sh", "fmd-restored", "--relaunch")
            self.refused("fm-control.sh", "fmd-restored", "relaunch")
        record.unlink()
        for script in (
            "fm-remote-secondmate-control.sh", "fm-remote-home-provision.sh",
            "fm-home-seed.sh", "fm-remote-home-seed.sh",
        ):
            self.refused(script, "fmd-remote", "--recover", "example.invalid")
        self.dispatch_admission()

    def dispatch_admission(self):
        path = self.home / "config/crew-dispatch.json"
        for config in (
            {"default": [{"harness": "claude"}, {"harness": "codex"}]},
            {"default": {"harness": "codex"}},
            {"default": {"harness": "claude", "command": "claude"}},
            {"rules": [{"when": "work", "use": {"harness": "claude", "effort": "auto"}}]},
            {"default": {"harness": "claude", "model": "claude-unavailable"}},
            {"default": {"harness": "claude"}, "quota": []},
        ):
            path.write_text(json.dumps(config))
            self.refused("fm-spawn.sh", "fmd-config", "project", "--harness", "claude")
        path.unlink()

    def create_worktree(self, name):
        project, worktree = self.work / (name + "-project"), self.work / (name + "-worktree")
        run(["git", "init", "-q", "-b", "main", project], self.env)
        (project / "README.md").write_text("initial work\n")
        run(["git", "-C", project, "add", "README.md"], self.env)
        run(["git", "-C", project, "-c", "user.name=Tests", "-c", "user.email=test@example.invalid",
             "commit", "-qm", "initial"], self.env)
        run(["git", "-C", project, "worktree", "add", "--quiet", "--detach", worktree], self.env)
        self.env["FM_TEST_WORKTREE"] = str(worktree)
        return project, worktree

    def originless(self, kind, batch=False):
        task = self.prefix + "-originless-" + kind + ("-batch" if batch else "")
        project, worktree = self.create_worktree(task)
        flags = ["--scout"] if kind == "scout" else ["--mode", "no-mistakes", "--yolo", "off"]
        brief_flags = ["--scout"] if kind == "scout" else ["--mode", "no-mistakes"]
        self.entry("fm-brief.sh", task, project, *brief_flags)
        brief = self.home / "data" / task / "brief.md"
        intent, spec = "Keep the captain's exact words — 🧭.", "Implement only the reviewed behavior."
        template = brief.read_text()
        assert "{TASK}" in template and "{FIRSTMATE_SPEC}" in template
        self.entry("fm-spawn.sh", task, project, *flags, success=False)
        brief.write_text(template.replace("{TASK}", intent).replace("{FIRSTMATE_SPEC}", spec))
        allowlist = self.home / "config/launch-env-allowlist"
        allowlist.write_text("KEPT_WORKER_VALUE\nNATIVE_CLAUDE_LOG\nNATIVE_CLAUDE_LAUNCH_LOG\nFM_TEST_ALLOWLIST_LOG\n")
        self.env.update(KEPT_WORKER_VALUE="allowed value", REJECTED_WORKER_VALUE="must be absent")
        before = run(["git", "-C", project, "rev-parse", "HEAD"], self.env).stdout
        self.launch_log.write_text("")
        if batch:
            self.entry("fm-spawn.sh", f"{task}={project}", *flags)
        else:
            self.entry("fm-spawn.sh", task, project, *flags, "--model", "sonnet", "--effort", "xhigh")
        assert run(["git", "-C", worktree, "rev-parse", "HEAD"], self.env).stdout == before
        assert not (project / ".git/FETCH_HEAD").exists()
        metadata = dict(line.split("=", 1) for line in (self.home / "state" / (task + ".meta")).read_text().splitlines() if "=" in line)
        expected = ("claude", "claude-opus-5", "") if batch else ("claude", "claude-sonnet-5", "xhigh")
        assert (metadata["harness"], metadata["model"], metadata["effort"]) == expected
        run([sys.executable, self.install / "lib/fmx-controls.py", "fleet", "--offline"], self.env)
        launch = self.launch_log.read_text().strip()
        assert "/usr/bin/env -i" in launch, "spawn bypassed the configured environment allowlist"
        assert "CLAUDE_CONFIG_DIR=" not in launch, "spawn forwarded captain Claude state"
        if not self.env.get("FMX_INSTANCE_ID"):
            run(["/bin/sh", "-c", launch], self.env, worktree)
        self.check_worker(task, worktree, metadata)
        assert not (self.runtime / "state").exists(), "operational state leaked into the source runtime"
        if kind == "scout":
            self.entry("fm-promote.sh", task, "--mode", "no-mistakes", "--yolo", "off")
            promoted = (self.home / "data" / task / "ship-instructions.md").read_text()
            assert intent in promoted
            assert promoted.count("# Worker inner loop") == 1
        allowlist.unlink()

    def check_worker(self, task, worktree, metadata):
        worker = self.profile / "workers" / task
        controls = json.loads((worker / "worker.json").read_text())
        assert controls["model"] == metadata["model"] and controls["effort"] == metadata["effort"]
        assert (worker / "claude").is_dir()
        log = Path(self.env["NATIVE_CLAUDE_LAUNCH_LOG"]).read_text()
        expected = "--model " + metadata["model"]
        if metadata["effort"]:
            expected += " --effort " + metadata["effort"]
        assert expected in log
        assert str(worker / "claude") in log
        assert "KEPT_WORKER_VALUE=allowed value|REJECTED_WORKER_VALUE=unset" in Path(self.env["FM_TEST_ALLOWLIST_LOG"]).read_text()
        settings = json.loads((worktree / ".claude/settings.local.json").read_text())
        commands = [hook["command"] for hooks in settings["hooks"].values() for group in hooks for hook in group["hooks"]]
        assert commands and all(str(self.home) in command for command in commands)

    def controller(self):
        self.select_profile("default", "fmd")
        terminal_state = self.work / "controller-terminal"
        self.env.update(
            FM_TEST_CONTROL_STATE=str(terminal_state), FM_CONTROL_POLL="0.01",
            FM_CONTROL_SETTLE_WAIT="0", FM_CONTROL_EXIT_WAIT="0.2", FM_CONTROL_LAUNCH_WAIT="0.2",
        )
        cases = [
            ("both", ["--model", "default", "--effort", "default"], "claude-opus-5", ""),
            ("model", ["--model", "default"], "claude-opus-5", "high"),
            ("effort", ["--effort", "default"], "claude-sonnet-5", ""),
        ]
        for name, flags, model, effort in cases:
            task = f"fmd-reset-{name}"
            project, worktree = self.create_worktree(task)
            self.env["FM_TEST_CONTROL_TASK"] = task
            terminal_state.write_text("absent\n")
            self.entry("fm-brief.sh", task, project, "--mode", "no-mistakes")
            brief = self.home / "data" / task / "brief.md"
            brief.write_text(brief.read_text().replace("{TASK}", "Preserve the work in progress.")
                             .replace("{FIRSTMATE_SPEC}", "Reset only the requested controls."))
            self.launch_log.write_text("")
            self.entry("fm-spawn.sh", task, project, "--mode", "no-mistakes", "--yolo", "off",
                       "--model", "sonnet", "--effort", "high")
            self.control_worker(task, worktree, "claude-sonnet-5", "high")
            progress = worktree / "local-progress.txt"
            progress.write_text("Uncommitted progress must survive relaunch.\n")
            self.external_log.write_text("")
            self.launch_log.write_text("")
            result = self.entry("fm-control.sh", task, "relaunch", *flags,
                                "--note", "Retain the worktree and reset the selected controls.")
            assert f"model={model} effort={effort} backend=tmux" in result.stdout.decode(), result.stdout
            assert terminal_state.read_text().strip() == "alive"
            assert "/exit" in self.external_log.read_text()
            assert "new-window" not in self.external_log.read_text(), "relaunch replaced the owned endpoint"
            assert progress.read_text() == "Uncommitted progress must survive relaunch.\n"
            journal = (self.home / "state" / f"{task}.control-relaunch").read_text()
            assert f"to_model={model}\nto_effort={effort}\n" in journal and "phase=complete\n" in journal
            self.control_worker(task, worktree, model, effort)

        self.offline_controller(task, terminal_state)
        for key in ("FM_TEST_CONTROL_STATE", "FM_TEST_CONTROL_TASK", "FM_CONTROL_POLL",
                    "FM_CONTROL_SETTLE_WAIT", "FM_CONTROL_EXIT_WAIT", "FM_CONTROL_LAUNCH_WAIT"):
            self.env.pop(key, None)

    def control_worker(self, task, worktree, model, effort):
        meta = self.home / "state" / f"{task}.meta"
        fields = dict(line.split("=", 1) for line in meta.read_text().splitlines() if "=" in line)
        assert fields["model"] == model and fields.get("effort", "") == effort, fields
        native_log = Path(self.env["NATIVE_CLAUDE_LAUNCH_LOG"])
        native_log.write_text("")
        launch = self.launch_log.read_text().strip()
        assert launch and len(launch.splitlines()) == 1, launch
        run(["/bin/sh", "-c", launch], self.env, worktree)
        controls = json.loads((self.profile / "workers" / task / "worker.json").read_text())
        assert controls["model"] == model and controls["effort"] == effort
        arguments = native_log.read_text().split("|args=", 1)[1].split()
        assert [arguments[i + 1] for i, arg in enumerate(arguments) if arg == "--model"] == [model], arguments
        assert [arguments[i + 1] for i, arg in enumerate(arguments) if arg == "--effort"] == ([effort] if effort else []), arguments

    def offline_controller(self, task, terminal_state):
        meta = self.home / "state" / f"{task}.meta"
        original = meta.read_text()
        dispatch = self.home / "config/crew-dispatch.json"
        for condition in ("proxy-offline", "retired-model", "invalid-dispatch"):
            meta.write_text(original)
            if condition == "proxy-offline":
                self.env["NATIVE_CLAUDE_MODELS_STATUS"] = "1"
            elif condition == "retired-model":
                meta.write_text(original.replace("model=claude-sonnet-5", "model=claude-retired"))
            else:
                dispatch.write_text('{"rules":[{"harness":"grok","when":"always"}]}\n')
            terminal_state.write_text("alive\n")
            recorded = meta.read_bytes()
            self.refused("fm-control.sh", task, "relaunch", "--note", "Must fail before stopping.")
            assert terminal_state.read_text().strip() == "alive" and meta.read_bytes() == recorded
            self.entry("fm-control.sh", task, "interrupt")
            assert f"send-keys -t firstmate:fm-{task} Escape" in self.external_log.read_text()
            assert terminal_state.read_text().strip() == "alive"
            self.entry("fm-control.sh", task, "exit")
            assert f"send-keys -t firstmate:fm-{task} -l /exit" in self.external_log.read_text()
            assert terminal_state.read_text().strip() == "dead" and meta.read_bytes() == recorded
            self.env.pop("NATIVE_CLAUDE_MODELS_STATUS", None)
            if dispatch.exists():
                dispatch.unlink()
        self.unsafe_controller(task, terminal_state, original)

    def unsafe_controller(self, task, terminal_state, original):
        meta = self.home / "state" / f"{task}.meta"
        self.env["NATIVE_CLAUDE_MODELS_STATUS"] = "1"
        terminal_state.write_text("alive\n")
        for field, value in (("kind", "secondmate"), ("harness", "codex"),
                             ("backend", "remote"), ("remote_host", "example.invalid"),
                             ("endpoint_task_id", "fmd-another-task")):
            changed = "\n".join(line for line in original.splitlines() if not line.startswith(field + "="))
            meta.write_text(changed + f"\n{field}={value}\n")
            for verb in ("interrupt", "exit"):
                self.refused("fm-control.sh", task, verb)
            assert terminal_state.read_text().strip() == "alive"
        meta.write_text(original)
        for verb in ("interrupt", "exit"):
            self.refused("fm-control.sh", "fmp-foreign-task", verb)
        backup = meta.with_suffix(".owned-meta")
        meta.rename(backup)
        meta.symlink_to(backup)
        for verb in ("interrupt", "exit"):
            self.refused("fm-control.sh", task, verb)
        meta.unlink()
        backup.rename(meta)
        self.env.pop("NATIVE_CLAUDE_MODELS_STATUS", None)

    def inbox(self):
        body = b'{"originalIntent":"exact intent","generatedSpec":"separate spec"}'
        key = str(uuid.uuid4())
        args = ["note", "--request-id", key, "-"]
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.entry("fm-inbox.sh", *args, data=body), range(6)))
        assert all(result.returncode == 0 for result in results)
        notes = list((self.home / "state/inbox").rglob(key + ".note"))
        assert len(notes) == 1, "concurrent producers created more than one note"
        digest = hashlib.sha256(body).hexdigest()
        status = self.entry("fm-inbox.sh", "receipt", "--request-id", key, "--json")
        assert json.loads(status.stdout)["digest"] == digest
        self.entry("fm-inbox.sh", *args, data=b"different", success=False)
        self.entry("fm-inbox.sh", "drain", "--ack", key)
        self.entry("fm-inbox.sh", *args, data=body)
        assert not (self.home / "state/inbox" / (key + ".note")).exists()
        self.interrupted_inbox(body)
        legacy = self.entry("fm-inbox.sh", "note", "-", data=b"legacy inbox behavior")
        legacy_id = legacy.stdout.decode().splitlines()[0].split()[1]
        assert (self.home / "state/inbox" / (legacy_id + ".note")).is_file()
        self.entry("fm-inbox.sh", "drain", "--ack", legacy_id)

    def interrupted_inbox(self, body):
        key = str(uuid.uuid4())
        inbox = self.home / "state/inbox"
        (inbox / (".staging-" + key + "-interrupted")).write_bytes(b"partial unpublished data")
        lock = inbox / ".requests" / (key + ".lock")
        lock.touch(mode=0o600)
        self.entry("fm-inbox.sh", "note", "--request-id", key, "-", data=body)
        signal = inbox / ".requests" / (key + ".announcement")
        signal.unlink()
        self.entry("fm-inbox.sh", "note", "--request-id", key, "-", data=body)
        assert len(list(inbox.rglob(key + ".note"))) == 1
        lock.unlink()
        self.entry("fm-inbox.sh", "receipt", "--request-id", key, "--json", success=False)
        self.entry("fm-inbox.sh", "note", "--request-id", key, "-", data=body, success=False)

    def verify_fixture(self):
        base = self.package / "tests/fixtures/firstmate" / COMMIT
        hashes = json.loads((self.package / "tests/fixtures" / (COMMIT + ".sha256.json")).read_text())
        for path, digest in hashes.items():
            assert hashlib.sha256((base / path).read_bytes()).hexdigest() == digest

    def test(self):
        self.verify_fixture()
        self.early_admission()
        self.originless("ship")
        self.originless("ship", batch=True)
        self.select_profile("pstack-workers", "fmp")
        self.originless("scout")
        self.controller()
        self.inbox()
        print("Pinned entry points: admission, worktrees, argv, hooks, promotion, controller resets, offline control, inbox passed")


if __name__ == "__main__":
    Pinned(sys.argv[1:]).test()
