+++
inputs = ["checks", "criteria"]
+++
## Factory SDLC rules for verify
{{#checks}}Run exactly these repo checks (the same as CI) and report each result:
{{checks}}{{/checks}}{{^checks}}Find and run the repo's own test, lint and type checks (the same as CI).{{/checks}}
Git safety (the shell enforces it): never change git config (`git config` writes, --global, --file), never set GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR or GIT_INDEX_FILE, and never run git or tests against a repository other than your worktree. A worktree's config is the main checkout's shared .git/config; a test that runs `git init` with GIT_DIR set once made the owner's checkout bare.
Prove each acceptance criterion and write .factory/evidence.md, one line each: `AC-n: PASS|FAIL — command — key output`.
{{criteria}}
