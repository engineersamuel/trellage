.PHONY: test manifest contract adapter awesome-adapter copilot-image runner session workspace-checks playwright-matrix evidence build compare compare-down clean

HARNESS ?= harnesses/todo-side-by-side/harness.json

test: manifest contract adapter awesome-adapter copilot-image runner session workspace-checks playwright-matrix evidence

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

build:
	docker compose build

compare:
	./scripts/harness compare "$(HARNESS)"

compare-down:
	./scripts/harness down "$(HARNESS)"

clean:
	docker compose down --volumes --remove-orphans
