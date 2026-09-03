.PHONY: test dependency-bootstrap development-resolution-contract remote-azure-contract sandbox-entry-fixture publication-contract publication-history-audit publication-contract-self-test agent-profile-hup-contract floating-skills-contract profile-guide-core profile-guide-contract profile-guide-live-evaluation profile-compiler launcher trellage-identity trellage-session-bridge trellage-orphan-cleanup trellage-host-runtime trellage-host-headless trellage-host-headless-test azure-fresh-install-contract agent-harness claude-entry claude-ecc-image-probe copilot-entry headlong-entry pi-entry prime-entry native-codex-auth-config-launch native-codex-lifecycle native-codex-catalog native-codex-installation native-codex-pstack native-copilot-profiles native-agency-profile native-claude-profile native-firstmate-profile native-grok-profiles native-jcode-profile native-omp-profile native-picx-profile native-prime-profile native-profile-router copilot-hve-image copilot-hve-smoke manifest contract adapter awesome-adapter copilot-image runner session workspace-checks playwright-matrix evidence profile-matrix profile-matrix-test native-tui-matrix native-tui-matrix-live native-tui-matrix-test headless-matrix headless-matrix-live headless-matrix-test headless-matrix-static-test graph-of-loops-runtime-contract graph-of-loops-image graph-of-loops-image-probe build compare compare-down clean

HARNESS ?= harnesses/todo-side-by-side/harness.json
PROFILE_MATRIX_ARGS ?=
NATIVE_TUI_MATRIX_ARGS ?=
HEADLESS_MATRIX_ARGS ?=
TEST_JOBS ?= 4
PARALLEL_TEST_TARGETS := trellage-host-runtime native-copilot-profiles native-firstmate-profile native-prime-profile claude-entry copilot-entry native-claude-profile native-omp-profile launcher dependency-bootstrap development-resolution-contract remote-azure-contract publication-contract publication-contract-self-test agent-profile-hup-contract floating-skills-contract profile-guide-contract trellage-identity trellage-session-bridge trellage-orphan-cleanup azure-fresh-install-contract agent-harness headlong-entry pi-entry prime-entry native-codex-catalog native-codex-installation native-codex-pstack native-agency-profile native-jcode-profile native-picx-profile native-tui-matrix-test manifest contract adapter awesome-adapter copilot-image runner session workspace-checks playwright-matrix evidence headless-matrix-static-test graph-of-loops-runtime-contract
TIMING_SENSITIVE_TEST_TARGETS := native-codex-auth-config-launch native-codex-lifecycle native-grok-profiles
FINAL_TEST_TARGETS := native-profile-router trellage-host-headless-test
SANDBOX_ENTRY_FIXTURE_IMAGE := mcr.microsoft.com/devcontainers/javascript-node@sha256:0d29e5fdc64f8397cd502223e0c4679f1e60877ca0fd2db4f2e2e0028e4271af
TRELLAGE_GRAPH_OF_LOOPS_IMAGE ?= trellage-profile-claude-graph-of-loops-linux-arm64:locked

test:
	$(MAKE) --no-print-directory -j$(TEST_JOBS) $(PARALLEL_TEST_TARGETS)
	$(MAKE) --no-print-directory -j$(TEST_JOBS) $(TIMING_SENSITIVE_TEST_TARGETS)
	$(MAKE) --no-print-directory -j$(TEST_JOBS) $(FINAL_TEST_TARGETS)

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

trellage-host-headless: profile-compiler
	TRELLAGE_HOST_HEADLESS_ONLY=1 bash prototypes/trellage/tests/host_command_contract.sh

trellage-host-headless-test:
	TRELLAGE_HOST_HEADLESS_ONLY=1 bash prototypes/trellage/tests/host_command_contract.sh

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

native-agency-profile:
	bash prototypes/trellage-agency-profiles/tests/contract.sh

native-claude-profile:
	bash prototypes/trellage-claude-profiles/tests/contract.sh

native-firstmate-profile:
	bash prototypes/trellage-firstmate-profiles/tests/contract.sh

native-grok-profiles:
	bash prototypes/trellage-grok-profiles/tests/contract.sh

native-jcode-profile:
	@bundle_check="$$(mktemp "$${TMPDIR:-/tmp}/trellage-jcx-config-manager.XXXXXX")"; \
	trap 'rm -f -- "$$bundle_check"' EXIT; \
	packages/trellage-launcher/node_modules/.bin/esbuild \
		prototypes/trellage-jcode-profiles/config-manager.source.mjs \
		--bundle --platform=node --format=esm --target=node18 \
		--alias:smol-toml=./packages/trellage-cli/node_modules/smol-toml/dist/index.js \
		--legal-comments=inline --log-level=error --outfile="$$bundle_check"; \
	cmp -s "$$bundle_check" prototypes/trellage-jcode-profiles/config-manager.mjs \
		|| { printf '%s\n' 'jcx config manager bundle is stale' >&2; exit 1; }
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

native-tui-matrix:
	scripts/verify-native-tuis $(NATIVE_TUI_MATRIX_ARGS)

native-tui-matrix-live:
	scripts/verify-native-tuis --live $(NATIVE_TUI_MATRIX_ARGS)

native-tui-matrix-test:
	python3 tests/native_tui_matrix_test.py

headless-matrix:
	scripts/verify-headless-contracts $(HEADLESS_MATRIX_ARGS)

headless-matrix-live:
	scripts/verify-headless-contracts --live

headless-matrix-test:
	bash tests/headless_contract_matrix.sh

graph-of-loops-runtime-contract:
	bash tests/graph_of_loops_runtime_contract.sh

# Builds the claude-graph-of-loops profile image (mirrors the
# copilot-hve-image / copilot-hve-smoke split below). Not part of `make
# test`: a Docker build is too slow/heavy for the default suite, and this
# target consumes no model quota itself but can take several minutes.
graph-of-loops-image:
	cd prototypes/trellage && ./trellage build ../../profiles/claude-graph-of-loops/profile.toml

# Probes an already-built claude-graph-of-loops image. Does NOT build
# the image itself: run `make graph-of-loops-image` first (or any equivalent
# `trellage build` invocation) so $(TRELLAGE_GRAPH_OF_LOOPS_IMAGE)
# exists, then run this target. Not part of `make test` for the same reason
# `graph-of-loops-image` is not: no model quota is consumed, but building
# and probing a real container is too slow/heavy for the default suite.
graph-of-loops-image-probe:
	TRELLAGE_GRAPH_OF_LOOPS_IMAGE=$(TRELLAGE_GRAPH_OF_LOOPS_IMAGE) bash tests/graph_of_loops_image_probe.sh

headless-matrix-static-test:
	TRELLAGE_HEADLESS_SKIP_PUBLICATION_TEST=1 bash tests/headless_contract_matrix.sh

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
