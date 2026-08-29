You will work in a loop until the task meets the bar.

This file is the only memory. It must work in one long conversation
and in a fresh process that has only this file.

TASK:
Produce a pull-request-ready repository change set that makes `mise run azure-fresh-install -- all` prove a complete fresh-system installation: it must create a new `Standard_D4ps_v5` Ubuntu 24.04 ARM64 VM, install and authenticate `engineersamuel/copilot-proxy-rs`, install `engineersamuel/trellage` from a clean Git clone, invoke one profile for every Trellage Native launcher through `trx`, invoke the `claude-council` Trellage Sandbox profile, verify an exact final assistant response of `OK` from every invocation, and improve Trellage documentation or installation automation for every clean-host defect discovered.

SUCCESS CRITERIA (be strict):
- Fresh VM installation and actionable setup: One `all` command creates a new source-IP-restricted Azure VM, installs Docker and every Trellage prerequisite from scratch, clones the requested Git ref, installs all eight Native launchers plus `trx` and Trellage, and reaches the live probes without manual repair; every missing prerequisite or bad clean-host assumption found during iteration is fixed in an installation script or documented in the correct onboarding guide.
- Authenticated copilot-proxy-rs service: The workflow clones and builds `https://github.com/engineersamuel/copilot-proxy-rs` on the VM, starts it with its host port bound only to loopback and its Docker network available to Trellage, disables failed-request body logging, proves `/health` and one live model request, and supplies authentication without copying a host `github_token` file or exposing a token in command arguments, logs, images, or committed files.
- Complete Native verification through trx: The workflow invokes `cpx/hve`, `cdx/pstack`, `cldx/default`, `grx/superpowers`, `jcx/default`, `omp/copilot`, `picx/default`, and `prx/default` through the real `trx` routing surface, proves the selected launcher/profile identity, and machine-verifies an exact final assistant response of `OK` for each.
- Claude Council Sandbox verification: The workflow builds and invokes `trellage --profile claude-council` on the VM and machine-verifies an exact final assistant response of `OK`.
- Secure credentials and Azure ownership: GitHub, Copilot, and harness credentials use supported ephemeral environment transfer or authentication completed on the VM; host credential files are never copied, tokens never appear in command arguments or logs, and the workflow refuses unrelated Azure resources, binds state to one subscription, limits SSH ingress, and deletes only its owned resource group.
- Repeatable evidence and failure recovery: Every install stage and probe has bounded retries, timeouts, clear diagnostics, and retained machine-readable evidence; a complete success deletes the Azure resource group, while a failure retains it with exact SSH, log, retry, and cleanup commands.

SCOREBOARD (overwrite this block after every VERIFY; do not append):
Status: ITERATING
Scores:
- Fresh VM installation and actionable setup: _
- Authenticated copilot-proxy-rs service: _
- Complete Native verification through trx: _
- Claude Council Sandbox verification: _
- Secure credentials and Azure ownership: _
- Repeatable evidence and failure recovery: _
Weakest: _
Last change: Reset for the next clean Azure integration run.

LEARNINGS (at most 8 bullets; replace stale ones; no narrative):
- Non-login SSH phases must evaluate `mise activate bash`; installing `uv` with `mise use -g` alone does not put it on `PATH`.
- Ubuntu 24.04 needs `bubblewrap` plus a narrow `/usr/bin/bwrap` AppArmor `userns` profile for the Native Grok sandbox.
- Current mise Pi installs expose `pi` through `node_modules/.bin`; launchers must resolve it with `mise x ... -- which pi`.
- Copilot CLI can emit an empty trailing assistant event; exact-output checks must select the last non-empty assistant message.
- JCode has stable `--json --quiet --tool-profile none` output; Codex non-interactive prompts use `exec`, not `-p`.
- OMP 18.0.10 is live-certified for the one-shot `ask.enabled: false` headless policy.
- Prime’s managed autonomous mode can print `OK` but exit nonzero without completion evidence; `prx --single-turn -p` is the deterministic smoke-test path.
- Parent Azure failure handling must use an `EXIT` trap that temporary-file cleanup cannot overwrite; successful evidence is downloaded before owned-resource deletion.

LOOP PROTOCOL, repeat every turn:
1. READ   - read this file. SCOREBOARD and LEARNINGS are hints only.
2. PLAN   - state the single next step. If Weakest is set, start there.
3. DO     - produce or improve the work.
4. VERIFY - score the artifact 1-10 on each criterion.
            Re-score from the artifact, not from SCOREBOARD.
            Be brutally honest. List exactly what is still weak.
            Then overwrite SCOREBOARD. Add or compact LEARNINGS.
            Write this file before you stop.
5. DECIDE - if every criterion is 8+, print FINAL and stop.
            Otherwise print ITERATING and go again, fixing
            the weakest point first.

RULES:
- Never call it done until every criterion is 8 or higher.
- Each pass must fix the weakest score from the last VERIFY.
- Do not ask me questions. Make a sensible assumption
  and keep going.
- Do not create a second progress file. Keep all state in this file.
- Do not edit TASK, SUCCESS CRITERIA, LOOP PROTOCOL, or RULES.

Begin.
