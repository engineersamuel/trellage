+++
inputs = ["checks", "criteria"]
+++
## Factory SDLC rules for verify
{{#checks}}Run exactly these repo checks (the same as CI) and report each result:
{{checks}}{{/checks}}{{^checks}}Find and run the repo's own test, lint and type checks (the same as CI).{{/checks}}
Prove each acceptance criterion and write .factory/evidence.md, one line each: `AC-n: PASS|FAIL — command — key output`.
{{criteria}}
