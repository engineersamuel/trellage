+++
inputs = ["base", "findings"]
+++
Fix these security findings from the review of `git diff {{base}}`. Add a test for each fix. When the tests pass,
commit the fixes and their tests (one conventional commit, for example `fix(scope): ...`); leave nothing uncommitted.
{{findings}}
