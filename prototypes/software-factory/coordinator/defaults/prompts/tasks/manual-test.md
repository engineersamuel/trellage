+++
inputs = ["summary", "criteria", "diff"]
+++
A human wants to try the change in this worktree by hand. Write the shortest manual test that shows it works.

What the change does (the sub-coordinator's report):
{{summary}}

Acceptance criteria:
{{criteria}}

Changed files:
{{diff}}

Read the code, the README and the scripts to find how this repo builds and starts. Do not edit files and do not run builds or servers.

Rules:
- `setup`: shell commands, run in order from the worktree root in bash, that build and start what the human needs. Use free test ports, not the repo's default ports (another copy may already run there). A command that keeps running (a dev server) goes last. Nothing that pushes, deletes branches, or changes files tracked by git.
- `steps`: 2 to 8 things the human does and sees: open a URL, click something, run a command. Each has `do` (one sentence), an optional `command`, and `expect` (what they must see when it works).
- `cleanup`: commands that stop what setup started. May be empty.

Reply with only one JSON object, no other text:
{"setup": ["..."], "steps": [{"do": "...", "command": "...", "expect": "..."}], "cleanup": ["..."]}
