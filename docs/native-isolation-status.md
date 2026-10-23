# Native isolation status

Source: `adapters` registry, `packages/trellage-runtime/src/native-run/adapters.ts:2214`.
Evidence lines point to the evidence text in that file. Status values are `proven` or `unproven`.
The only existing probe is `scripts/probe-native-isolation.ts` (copilot, codex).

| Harness | Status | Evidence (adapters.ts line) | Test that would make it `proven` |
| --- | --- | --- | --- |
| `agency` | unproven | "Agency owns the Copilot process while Trellage supplies its generated Copilot home" (L762) | Run the Copilot probe through the Agency launcher. Pass: no repository or host skills listed, only selected skills. |
| `pi` | **proven** | "Pi 1.0.4 resource loader: --no-skills plus explicit --skill kept only selected skills and retained AGENTS.md" (L1222) | None needed. Re-run on each Pi version bump. |
| `copilot` | unproven | "Copilot CLI 1.0.93-1 still discovers trusted repository skills with a dedicated COPILOT_HOME (scripts/probe-native-isolation.ts)" (L1386) | `bun scripts/probe-native-isolation.ts copilot <exe>` lists only selected skills in a repository that has its own skills. |
| `claude` | unproven | "no model-free native proof exists for Claude Code discovery yet" (L1826) | Add a `claude` mode to the probe. Pass: model-free discovery in a repository with its own skills and `CLAUDE.md` returns only selected skills and instructions. |
| `codex` | unproven | "Codex 0.160.1 skills/list still returns repository skills despite skip_host_skill_discovery and extra-root controls (scripts/probe-native-isolation.ts)" (L1642) | `bun scripts/probe-native-isolation.ts codex <exe>`: `skills/list` returns only selected skills. |
| `firstmate` | unproven | "Firstmate retains its prepared fleet runtime and captain home while trx owns process dispatch" (L847) | Launch with a canary skill in the captain home and in the repository. Pass: neither is visible to the session. |
| `jcode` | unproven | "JCode receives a generated JCODE_HOME but may still discover repository context" (L902) | Add a probe mode for `jcode`. Pass: a canary repository skill and instruction file are not loaded. |
| `omp` | unproven | "OMP uses its native profile store and receives selected Trellage instructions explicitly" (L963) | Add a probe mode for `omp`. Pass: native-profile and repository canaries are not loaded; only selected instructions are. |
| `prime` | unproven | "Prime uses the generated coding-agent directory while its kernel remains native" (L1009) | Add a probe mode for `prime`. Pass: kernel-native and repository canaries are not loaded. |
| `grok` | unproven | "generated GROK_HOME disables host Claude/Cursor compatibility, but Grok still discovers repository-native instructions and skills" (L1990) | Add a probe mode for `grok`. Pass: a repository canary instruction and skill are not discovered. |
| `fx` | unproven | "Fx intentionally uses the host HOME and ~/.fx so GitHub CLI, Git, SSH and shell context remain available" (L285) | By design not isolated. It can reach `proven` only if the design changes to a generated HOME. Then pass: host `~/.fx` canaries are not loaded. |
| `uji` | unproven | "Uji uses a generated config and selected skill roots; broader workspace and tool isolation has not been verified" (L2134) | Add a probe mode for `uji`. Pass: workspace and tool canaries outside the selected roots are not reachable. |

## Notes

- 1 of 12 harnesses is `proven` (`pi`).
- Only `copilot` and `codex` have a probe. Their evidence shows a failing result, not a missing test.
- Rows with "Add a probe mode" need new probe code. This document changes no code.
