.PHONY: test publication-contract publication-history-audit publication-contract-self-test agent-profile-hup-contract profile-compiler trellage-identity agent-harness claude-entry copilot-entry pi-entry native-codex-profiles native-copilot-profiles native-grok-profiles native-omp-profile native-profile-router copilot-hve-image copilot-hve-smoke manifest contract adapter awesome-adapter copilot-image runner session workspace-checks playwright-matrix evidence profile-matrix profile-matrix-test build compare compare-down clean

HARNESS ?= harnesses/todo-side-by-side/harness.json
PROFILE_MATRIX_ARGS ?=
test: publication-contract publication-contract-self-test agent-profile-hup-contract profile-compiler trellage-identity agent-harness claude-entry copilot-entry pi-entry native-codex-profiles native-copilot-profiles native-grok-profiles native-omp-profile native-profile-router manifest contract adapter awesome-adapter copilot-image runner session workspace-checks playwright-matrix evidence

publication-contract:
	bash tests/publication_contract.sh

publication-history-audit:
	bash tests/publication_contract.sh --sanitized-history

publication-contract-self-test:
	bash tests/publication_contract_self_test.sh

agent-profile-hup-contract:
	bash tests/agent_profile_hup_contract.sh

profile-compiler:
	cd packages/trellage-cli && npm run lint && npm run format:check && npm run check && npm run build && npm test

trellage-identity:
	bash tests/trellage_identity_contract.sh

agent-harness:
	bash tests/agent_harness_contract.sh

claude-entry:
	bash prototypes/trellage/tests/claude_entry_contract.sh

copilot-entry:
	bash prototypes/trellage/tests/copilot_entry_contract.sh

pi-entry:
	bash prototypes/trellage/tests/pi_entry_contract.sh

native-codex-profiles:
	bash prototypes/trellage-codex-profiles/tests/contract.sh

native-copilot-profiles:
	bash prototypes/trellage-copilot-profiles/tests/contract.sh

native-grok-profiles:
	bash prototypes/trellage-grok-profiles/tests/contract.sh

native-omp-profile:
	bash prototypes/trellage-omp-profiles/tests/contract.sh

native-profile-router:
	bash prototypes/trellage-router/tests/contract.sh

copilot-hve-image:
	cd prototypes/trellage && ./trellage build --locked ../../profiles/copilot-hve/profile.toml

copilot-hve-smoke:
	cd prototypes/trellage && ./tests/smoke.sh --copilot ../../profiles/copilot-hve/profile.toml

manifest:
	bash tests/manifest_contract.sh

contract:
	bash tests/harness_contract.sh

adapter:
	bash tests/agent_kit_adapter.sh

awesome-adapter:
	bash tests/awesome_copilot_adapter.sh

copilot-image:
	bash tests/copilot_agent_image.sh

runner:
	bash tests/harness_runner.sh

session:
	bash tests/run_agent_session.sh

workspace-checks:
	bash tests/workspace_checks.sh

playwright-matrix:
	bash tests/playwright_matrix.sh

evidence:
	bash tests/evidence_contract.sh

profile-matrix:
	scripts/verify-agent-profiles $(PROFILE_MATRIX_ARGS)

profile-matrix-test:
	bash tests/agent_profile_matrix.sh

build:
	docker compose build

compare:
	./scripts/harness compare "$(HARNESS)"

compare-down:
	./scripts/harness down "$(HARNESS)"

clean:
	docker compose down --volumes --remove-orphans
