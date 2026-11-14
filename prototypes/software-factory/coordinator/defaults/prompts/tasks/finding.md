+++
inputs = ["file", "conversation", "title", "body"]
+++
Implement this optimization from the report {{file}} (conversation "{{conversation}}").

## {{title}}

{{body}}

Follow the delivery loop: next_step, request_approval for the plan, implement, verify, ship. Keep the change to this one finding. Ship (push and PR) only after the human accepts request_approval ship=true. Never merge.
