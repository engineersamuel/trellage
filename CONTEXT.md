# Trellage

Trellage helps users select agent profiles and workflows for their work.

## Conversation continuation

**Conversation snapshot**:
The human user messages and completed, user-visible assistant answers from one
exactly identified conversation, through a stated cutoff. It excludes internal
instructions, reasoning, tool traffic, and nested-agent traffic.
_Avoid_: Terminal snapshot, full harness context

**Continuation assessment**:
An analysis of a conversation snapshot identifying the current goal, reported
progress, unresolved work, blockers, and ranked opportunities for what to do next.
Reported progress is not independently verified completion.
_Avoid_: Completion proof

**Next action**:
A proposed next use of the work or its results, informed by the conversation and
available profile capabilities. It can include further implementation,
visualization, a second opinion, or review; it need not imply unfinished work.
_Avoid_: Remaining task
