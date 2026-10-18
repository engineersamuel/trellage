.PHONY: native-harness-version test dependency-bootstrap development-resolution-contract publication-contract publication-history-audit publication-contract-self-test agent-profile-hup-contract floating-skills-contract profile-guide-core profile-guide-contract profile-guide-live-evaluation launcher conversation-source source-runtime trellage-identity trellage-session-bridge azure-fresh-install-contract agent-harness native-copilot-profiles native-agency-profile native-claude-profile native-jcode-profile native-omp-profile native-prime-profile native-profile-router manifest contract adapter awesome-adapter copilot-image runner session workspace-checks playwright-matrix evidence profile-matrix profile-matrix-test native-tui-matrix native-tui-matrix-live native-tui-matrix-test headless-matrix headless-matrix-live headless-matrix-test headless-matrix-static-test build compare compare-down clean trellage-statusline

.PHONY: profile-compiler-fingerprint
.PHONY: test-command
.PHONY: test-pr shell-syntax
.PHONY: rebuild-profiles-bun-runtime

HARNESS ?= harnesses/todo-side-by-side/harness.json
PROFILE_MATRIX_ARGS ?=
NATIVE_TUI_MATRIX_ARGS ?=
HEADLESS_MATRIX_ARGS ?=
TEST_JOBS ?= 4
TEST_TIMING ?= 0
ifeq ($(TEST_TIMING),1)
%: SHELL = python3 scripts/test-command.py $@
endif
PARALLEL_TEST_TARGETS := test-command native-copilot-profiles native-prime-profile launcher conversation-source source-runtime dependency-bootstrap development-resolution-contract rebuild-profiles-bun-runtime publication-contract publication-contract-self-test agent-profile-hup-contract floating-skills-contract profile-guide-contract trellage-identity trellage-session-bridge azure-fresh-install-contract agent-harness native-harness-version native-agency-profile native-jcode-profile manifest contract adapter awesome-adapter copilot-image runner session workspace-checks playwright-matrix evidence headless-matrix-static-test trellage-statusline
TIMING_SENSITIVE_TEST_TARGETS := native-omp-profile native-claude-profile native-tui-matrix-test
FINAL_TEST_TARGETS := native-profile-router

test:
	$(MAKE) --no-print-directory TEST_TIMING=1 -j$(TEST_JOBS) $(PARALLEL_TEST_TARGETS)
	$(MAKE) --no-print-directory TEST_TIMING=1 -j1 profile-compiler-fingerprint
	$(MAKE) --no-print-directory TEST_TIMING=1 -j1 $(TIMING_SENSITIVE_TEST_TARGETS)
	$(MAKE) --no-print-directory TEST_TIMING=1 -j$(TEST_JOBS) $(FINAL_TEST_TARGETS)

test-pr:
	$(MAKE) --no-print-directory TEST_TIMING=1 -j1 shell-syntax test-command agent-harness trellage-identity manifest
	bun run check
	bun run test
	bash tests/source_startup_contract.sh
	bun --no-install --no-env-file tests/profile_guides_contract.ts

shell-syntax:
	bash scripts/check-shell-syntax.sh

test-command:
	python3 tests/test_command.py

dependency-bootstrap:
	bash tests/dependency_bootstrap_contract.sh
	bash tests/manage_dependencies_contract.sh

development-resolution-contract:
	bash tests/development_resolution_contract.sh

rebuild-profiles-bun-runtime:
	bash tests/rebuild_profiles_bun_runtime_contract.sh


publication-contract:
	bash tests/publication_contract.sh

publication-history-audit:
	bash tests/publication_contract.sh --sanitized-history

publication-contract-self-test:
	bash tests/publication_contract_self_test.sh

agent-profile-hup-contract:
	bash tests/agent_profile_hup_contract.sh

floating-skills-contract:
	bun test tests/floating_skills.test.mjs tests/composed_skill_snapshot.test.ts prototypes/trellage-claude-common/tests/composed-instructions.test.ts

profile-guide-core:
	cd packages/trellage-guide-core && bun run check && bun run test

profile-guide-contract: profile-guide-core
	bun --no-install --no-env-file tests/profile_guides_contract.ts

profile-guide-live-evaluation:
	bun --no-install --no-env-file scripts/evaluate-profile-guides.ts --live

launcher: profile-guide-core
	cd packages/trellage-launcher && bun run check && bun run test

profile-compiler-fingerprint:
	bash tests/profile_compiler_fingerprint_contract.sh

conversation-source:
	cd packages/trellage-conversation-source && bun run check && bun run test

source-runtime:
	cd packages/trellage-runtime && bun run check && bun run test
	bash tests/source_startup_contract.sh

trellage-identity:
	bash tests/trellage_identity_contract.sh

trellage-session-bridge:
	python3 tests/trellage_session_bridge_test.py

trellage-statusline:
	bash tests/trellage_statusline.sh
	bash tests/trellage_statusline_apply.sh

azure-fresh-install-contract:
	bash tests/azure_fresh_install_contract.sh

agent-harness:
	bash tests/agent_harness_contract.sh


native-copilot-profiles:
	bash prototypes/trellage-copilot-profiles/tests/version_cache_contract.sh
	bash prototypes/trellage-copilot-profiles/tests/contract.sh

native-agency-profile:
	bash prototypes/trellage-agency-profiles/tests/contract.sh

native-claude-profile:
	bash prototypes/trellage-claude-profiles/tests/contract.sh

native-jcode-profile:
	bun test prototypes/trellage-claude-common/tests/manual-skills.test.ts prototypes/trellage-claude-common/tests/source-helpers.test.ts
	bash prototypes/trellage-jcode-profiles/tests/contract.sh

native-omp-profile:
	bash prototypes/trellage-omp-profiles/tests/contract.sh


native-prime-profile:
	bash prototypes/trellage-prime-profiles/tests/contract.sh

native-profile-router:
	bash prototypes/trellage-router/tests/contract.sh

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

headless-matrix-static-test:
	TRELLAGE_HEADLESS_SKIP_PUBLICATION_TEST=1 bash tests/headless_contract_matrix.sh

build:
	@skills_stage="$$(mktemp -d "$${TMPDIR:-/tmp}/trellage-make-skills.XXXXXX")"; \
	trap 'rm -rf -- "$$skills_stage"' EXIT; \
	bun --no-install --no-env-file scripts/floating-skills.ts stage \
		--catalog config.toml \
		--bundle comparison-common \
		--output "$$skills_stage/snapshot" >/dev/null; \
	HARNESS_SKILLS_CONTEXT="$$skills_stage/snapshot" docker compose build

compare:
	./scripts/harness compare "$(HARNESS)"

compare-down:
	./scripts/harness down "$(HARNESS)"

clean:
	docker compose down --volumes --remove-orphans

native-harness-version:
	bash tests/native-harness-version.sh
