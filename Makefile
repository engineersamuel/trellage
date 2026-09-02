.PHONY: test dependency-bootstrap development-resolution-contract remote-azure-contract sandbox-entry-fixture publication-contract publication-history-audit publication-contract-self-test agent-profile-hup-contract floating-skills-contract profile-guide-core profile-guide-contract profile-guide-live-evaluation profile-compiler launcher trellage-identity trellage-session-bridge trellage-orphan-cleanup trellage-host-runtime azure-fresh-install-contract agent-harness claude-entry claude-ecc-image-probe copilot-entry headlong-entry pi-entry prime-entry native-codex-auth-config-launch native-codex-lifecycle native-codex-catalog native-codex-installation native-codex-pstack native-copilot-profiles native-claude-profile native-firstmate-profile native-grok-profiles native-jcode-profile native-omp-profile native-picx-profile native-prime-profile native-profile-router copilot-hve-image copilot-hve-smoke manifest contract adapter awesome-adapter copilot-image runner session workspace-checks playwright-matrix evidence profile-matrix profile-matrix-test headless-matrix headless-matrix-live headless-matrix-test build compare compare-down clean

HARNESS ?= harnesses/todo-side-by-side/harness.json
PROFILE_MATRIX_ARGS ?=
HEADLESS_MATRIX_ARGS ?=
TEST_JOBS ?= 4
PARALLEL_TEST_TARGETS := dependency-bootstrap development-resolution-contract remote-azure-contract publication-contract publication-contract-self-test agent-profile-hup-contract floating-skills-contract profile-guide-contract profile-compiler launcher trellage-identity trellage-session-bridge trellage-orphan-cleanup trellage-host-runtime azure-fresh-install-contract agent-harness claude-entry copilot-entry headlong-entry pi-entry prime-entry native-codex-catalog native-codex-installation native-codex-pstack native-copilot-profiles native-claude-profile native-firstmate-profile native-jcode-profile native-omp-profile native-picx-profile native-prime-profile manifest contract adapter awesome-adapter copilot-image runner session workspace-checks playwright-matrix evidence headless-matrix-test
TIMING_SENSITIVE_TEST_TARGETS := native-codex-auth-config-launch native-codex-lifecycle native-grok-profiles
SERIAL_TEST_TARGETS := native-profile-router headless-matrix
SANDBOX_ENTRY_FIXTURE_IMAGE := mcr.microsoft.com/devcontainers/javascript-node@sha256:0d29e5fdc64f8397cd502223e0c4679f1e60877ca0fd2db4f2e2e0028e4271af

test:
	$(MAKE) --no-print-directory -j$(TEST_JOBS) $(PARALLEL_TEST_TARGETS)
	$(MAKE) --no-print-directory $(TIMING_SENSITIVE_TEST_TARGETS)
	$(MAKE) --no-print-directory $(SERIAL_TEST_TARGETS)

dependency-bootstrap:
	bash tests/dependency_bootstrap_contract.sh

development-resolution-contract:
	bash tests/development_resolution_contract.sh

remote-azure-contract:
	bash prototypes/trellage/tests/remote_azure_contract.sh


publication-contract:
	bash tests/publication_contract.sh

publication-history-audit:
	bash tests/publication_contract.sh --sanitized-history

publication-contract-self-test:
	bash tests/publication_contract_self_test.sh

agent-profile-hup-contract:
	bash tests/agent_profile_hup_contract.sh

floating-skills-contract:
	node --test tests/floating_skills.test.mjs

profile-guide-core:
	cd packages/trellage-guide-core && npm run check && npm run build && npm test

profile-guide-contract: profile-guide-core
	node tests/profile_guides_contract.mjs

profile-guide-live-evaluation:
	node scripts/evaluate-profile-guides.mjs --live

profile-compiler: profile-guide-core
	cd packages/trellage-cli && npm run lint && npm run format:check && npm run check && npm run build && npm test

launcher: profile-guide-core
	cd packages/trellage-launcher && npm run check && npm run build && npm test
	bash tests/profile_compiler_fingerprint_contract.sh

trellage-identity:
	bash tests/trellage_identity_contract.sh

trellage-session-bridge:
	python3 tests/trellage_session_bridge_test.py

trellage-orphan-cleanup:
	bash tests/trellage_orphan_cleanup_contract.sh

trellage-host-runtime: profile-compiler
	HERDR_ENV=0 TRELLAGE_HOST_SESSION_BRIDGE_ONLY=1 bash prototypes/trellage/tests/host_command_contract.sh
	HERDR_ENV=0 TRELLAGE_HOST_LIFECYCLE_ONLY=1 bash prototypes/trellage/tests/host_command_contract.sh
	HERDR_ENV=0 TRELLAGE_HOST_CLAUDE_TTY_ONLY=1 bash prototypes/trellage/tests/host_command_contract.sh

azure-fresh-install-contract:
	bash tests/azure_fresh_install_contract.sh

agent-harness:
	bash tests/agent_harness_contract.sh

sandbox-entry-fixture:
	@docker image inspect "$(SANDBOX_ENTRY_FIXTURE_IMAGE)" >/dev/null 2>&1 || docker image pull "$(SANDBOX_ENTRY_FIXTURE_IMAGE)"

claude-entry:
	bash prototypes/trellage/tests/claude_entry_contract.sh

claude-ecc-image-probe:
	bash tests/claude_ecc_image_probe.sh

copilot-entry: sandbox-entry-fixture
	bash prototypes/trellage/tests/copilot_entry_contract.sh

headlong-entry: sandbox-entry-fixture
	bash prototypes/trellage/tests/headlong_entry_contract.sh

pi-entry: sandbox-entry-fixture
	bash prototypes/trellage/tests/pi_entry_contract.sh

prime-entry: sandbox-entry-fixture
	bash prototypes/trellage/tests/prime_entry_contract.sh

native-codex-auth-config-launch:
	bash prototypes/trellage-codex-profiles/tests/blocks/auth-config-launch.sh

native-codex-lifecycle:
	bash prototypes/trellage-codex-profiles/tests/blocks/lifecycle.sh

native-codex-catalog:
	bash prototypes/trellage-codex-profiles/tests/blocks/catalog.sh

native-codex-installation:
	bash prototypes/trellage-codex-profiles/tests/blocks/installation.sh

native-codex-pstack:
	bash prototypes/trellage-codex-profiles/tests/blocks/pstack.sh

native-copilot-profiles:
	bash prototypes/trellage-copilot-profiles/tests/contract.sh

native-claude-profile:
	bash prototypes/trellage-claude-profiles/tests/contract.sh

native-firstmate-profile:
	bash prototypes/trellage-firstmate-profiles/tests/contract.sh

native-grok-profiles:
	bash prototypes/trellage-grok-profiles/tests/contract.sh

native-jcode-profile:
	bash prototypes/trellage-jcode-profiles/tests/contract.sh

native-omp-profile:
	bash prototypes/trellage-omp-profiles/tests/contract.sh

native-picx-profile:
	bash prototypes/trellage-picx-profiles/tests/contract.sh

native-prime-profile:
	bash prototypes/trellage-prime-profiles/tests/contract.sh

native-profile-router:
	bash prototypes/trellage-router/tests/contract.sh

copilot-hve-image:
	cd prototypes/trellage && ./trellage build ../../profiles/copilot-hve/profile.toml

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
	bash tests/harness_session_discovery.sh

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

headless-matrix:
	scripts/verify-headless-contracts $(HEADLESS_MATRIX_ARGS)

headless-matrix-live:
	scripts/verify-headless-contracts --live

headless-matrix-test:
	bash tests/headless_contract_matrix.sh

build:
	@skills_stage="$$(mktemp -d "$${TMPDIR:-/tmp}/trellage-make-skills.XXXXXX")"; \
	trap 'rm -rf -- "$$skills_stage"' EXIT; \
	node scripts/floating-skills.mjs stage \
		--catalog skills.json \
		--bundle comparison-common \
		--output "$$skills_stage/snapshot" >/dev/null; \
	HARNESS_SKILLS_CONTEXT="$$skills_stage/snapshot" docker compose build

compare:
	./scripts/harness compare "$(HARNESS)"

compare-down:
	./scripts/harness down "$(HARNESS)"

clean:
	docker compose down --volumes --remove-orphans
