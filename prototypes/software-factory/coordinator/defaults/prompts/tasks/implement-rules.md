+++
inputs = ["criteria", "design", "testFirst", "docs", "scopeWarning"]
+++
## Factory SDLC rules for this change
Acceptance criteria (.factory/acceptance.md):
{{criteria}}
{{#design}}Follow the design note in .factory/design.md.
{{/design}}{{#testFirst}}Tests first: write failing tests for the criteria, run them and see them fail, and commit them alone (tests only, message starts with `test:`). Then implement in later commits.
{{/testFirst}}{{#docs}}Update README, docs or CHANGELOG for every user-visible change.
{{/docs}}Make the smallest change that meets the criteria: no extra scripts, wrappers, abstractions or features the criteria do not ask for.
{{#scopeWarning}}Scope warning: {{scopeWarning}}
{{/scopeWarning}}Commit with conventional messages (feat:, fix:, test:, docs:). Keep commits small. Never commit .factory/.
Git safety (the shell enforces it): never change git config (`git config` writes, --global, --file), never set GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR or GIT_INDEX_FILE, and never run git or tests against a repository other than your worktree. A worktree's config is the main checkout's shared .git/config; a test that runs `git init` with GIT_DIR set once made the owner's checkout bare.
