+++
inputs = ["parent", "repo", "defect", "thread"]
+++
Fix a defect in the software factory (prototypes/software-factory in this repo) that blocks goal "{{parent}}" (target repo {{repo}}, conversation {{thread}}).

The blocked loop reported:
{{defect}}

Find the factory cause (not the symptom), fix it with a test that fails without the fix, and open a PR. Read GET /api/runs/{{thread}} and the parent conversation's events to see what happened. Do not change the parent goal's target repo. A human merges the PR and restarts the factory; then the parent goal resumes.
