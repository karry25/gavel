# Rubric anchors (from the brief)

a good coding agent from a bad
one: context assembly and a safe, fast editor experience.
Scoring: 100 points
Every criterion uses written anchors tied to fixed values. A judge selects the
description that fits, not a number. Where a submission sits between two anchors,
the lower one applies.

Criterion

Points Anchors

A. Capability coverage (30)
A1 Inline edit

10

0 not present, or output the user must copy by hand · 4
returns an edit but no diff in the editor · 7 diff rendered,
accept-all only · 10 diff rendered with per-hunk accept and
reject

A2 Agent mode 10

0 no tool loop · 4 edits a single file only · 7 edits several
files, but the user had to name them · 10 discovers and
edits three or more files unprompted (Task B)

A3 Streaming
and

10

0 editor blocks during generation · 4 streams, no
cancellation · 7 cancellation works but can leave
half-applied edits · 10 cancellation is immediate and the

cancellation

workspace stays consistent

B. Technical depth (45)
B1 Context

15

assembly

0 whole files concatenated until the window fills · 5 explicit
@-mentions only · 10 automatic retrieval, strategy stated
in the write-up · 15 retrieval with a size budget, strategy
stated, and visibly at work in Task B (the agent shows
which files it chose and why)

B2 Diff safety

10

0 writes to disk without showing the user · 5 full-file
preview before write · 10 per-hunk review and a working
undo of an applied change, shown on screen

B3 Resilience

10

(Task C)

0 hang, stack trace, or files changed · 4 clear error
message, workspace unchanged · 7 retry with backoff,
then a clear error, workspace unchanged · 10 automatic
fallback to a second configured model with no user acti