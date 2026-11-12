+++
inputs = ["tag", "event", "lost", "commits", "uncommitted", "criteria", "gates"]
+++
[{{tag}}] {{event}} That stopped this conversation's running work. Nothing finished it. Continue your delivery loop from the state below; do not redo finished steps.
Workers that were stopped mid-task:
{{lost}}
Commits on this branch:
{{commits}}
Uncommitted changes (a stopped worker may have left them half done; check them, then keep or discard):
{{uncommitted}}
Acceptance criteria:
{{criteria}}
Gates:
{{gates}}
Next: call sdlc_status, then spawn again the steps that were stopped (same step, a task that says what is already done). A code review stopped this way runs again by itself; a stopped evaluation or security review starts again at your next ship request. Pending approvals are still open; do not ask again.
