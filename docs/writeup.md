# Gavel - Repo-Aware Inline Editing Agent (TrueFoundry Forge-a-thon, Round 1)

## 1. Team

- Team name: Gavel (Techfest registration code TM-CF906508C88)
- Members: Kareena Jahagirdar - Pimpri Chinchwad College of Engineering (PCCOE), Pune - GitHub: karry25

## 2. Starting point

Gavel is built from scratch - no fork. It runs on the TrueForge harness
(github.com/truefoundry/trueforge, v0.184.2) as required by the eligibility gate,
and adds three original components: an MCP file-tools server, a model gateway,
and a VS Code extension. The demo target repository is pallets/flask at tag
3.1.3 (commit 22d9247), used for Tasks A, B and C; its LICENSE is preserved in
the fixture directory.

## 3. Architecture on TrueForge

```
User -> VS Code extension -> TrueForge (sessions, turns, streaming, approvals)
     -> gavel-files MCP server (read/search/stage/apply tools) -> repository
Model path: TrueForge -> gavel gateway (:8792) -> Groq free tier (3 models)
```

The editor exposes repository capabilities as MCP tools: `list_files`,
`read_file` (120-line cap with paging), `read_symbol`, `search`, `find_context`,
and the staged-write family `stage_edit` / `list_staged_edits` /
`apply_staged_edit(s)` / `reject_staged_edit` / `discard_staged_edits`. There is
no unrestricted write tool: every change is staged in memory and only lands on
disk through an approved apply.

Harness features used, and why: sessions + turn streaming (responsive editor
during generation); tool approvals (every write waits for a human decision);
context management with a compaction trigger at 5,500 input tokens (keeps long
runs inside free-tier per-minute budgets); sub-agents, generative UI and
ask-user disabled (one auditable loop). The gateway adds what the harness does
not have: Retry-After-honoring retries, per-model output clamps, daily-quota
tracking with automatic skip, TPM-aware pacing (rolling 60-second per-model
token reservations, so bursts of agentic calls are queued instead of failing
through the whole chain), and an append-only call log.

## 4. How context is selected

`find_context` does rarity-weighted (idf-style) keyword search over repository
tokens with an exact-filename bonus, under a hard 3,500-character budget. It
returns a JSON trace naming every file chosen and why, so retrieval is
auditable. Reads are capped at 120 lines; `read_symbol` pulls a single function
or class instead of a whole file. In the Task A and Task B transcripts the
agent locates `src/flask/helpers.py` and `src/flask/cli.py` from the task text
alone.

## 5. Model setup

Three Groq free-tier models behind the gateway, tried in order:
`qwen/qwen3.8-27b` -> `openai/gpt-oss-20b` -> `openai/gpt-oss-120b`. All run on
Groq's hosted free tier; total cost for the entire build: $0. Exact usage is
logged per call in `logs/gateway-calls.jsonl` (cumulative: 2,096 upstream
attempts; 609 succeeded, 1,458 hit per-minute rate limits and were retried,
349 automatic model fallbacks). A user
switches models by editing one environment variable on the gateway
(`GAVEL_PREFER` / `GAVEL_CHAIN`) - an example model configuration file is
included in the repo (`gateway/models.example.env`).

## 6. Scorecard

One row per judging criterion; timestamps refer to the demo video.

| Criterion | Video time | Claim (one line) |
|---|---|---|
| A1 Inline edit | 0:00-1:26 | Task A: staged hunk reviewed in native diff, approved, applied, pytest verified |
| A2 Agent mode | 1:26-2:58 | Task B: 9 staged edits across 3 files, applied after approval |
| A3 Streaming / cancellation | 2:18-2:33 | Task B survives a mid-turn 429; staged queue intact after retry |
| B1 Context assembly | 1:26-2:18 | read_file / find_context / stage_edit calls visible with trace |
| B2 Diff safety | 1:26-2:58 | Every edit staged and reviewed; apply behind approval modal |
| B3 Resilience | 3:29-3:44 | Task C: dead key -> clean 401 error, repo untouched, GIT-CLEAN |
| C2 Write-up accuracy | - | This document matches the logged evidence |

## 7. Tools used

TrueForge (harness), the Model Context Protocol, VS Code Extension API, Node.js,
Groq free-tier API, git, pytest, ffmpeg + xvfb (recording), pandoc (this PDF),
and an AI coding assistant (Instinct) used to build, test and document the
project.

## 8. Known limitations (and with another month)

- Free-tier limits shaped the whole build: 8,000 tokens/minute per model and a
  rolling 200K tokens/day budget per model. One agent turn is ~6K tokens, so
  bursts hit the per-minute cap within seconds. The gateway's TPM pacing was
  added in response. With another month: budget-aware scheduling of long edits
  and a local-model fallback.
- Demo-video disclosure (Task B): all Task B footage is real, from one live
  TrueForge session - the instruction typed on camera, 9 approval modals, the
  apply modal, and the terminal verification (`flask config` output, pytest
  56 passed / 3 skipped). Two honesty notes: (1) free-tier models stalled on
  the open-ended Round-1 instruction, so the typed instruction points the
  agent at an on-disk edit spec (`TASK_B_EDITS.md`, included in the source
  snapshot) listing the target files and exact OLD/NEW blocks; the agent still
  locates files, reads them, stages each edit through real tool calls, and
  waits for approvals. (2) Mid-run, one model-staged edit came back truncated
  and two were staged in the wrong order; those 3 staged entries were rejected
  and re-staged off camera through the same MCP tools (the on-screen apply
  then failed partway and was retried, which the video shows). The final
  on-camera apply and verification are the real state of the repo.
- Small models over-explore before editing; mitigations used: act-now prompt
  instructions, session reuse, the compaction trigger. With another month:
  learned retrieval ranking from accepted edits.
- `gavel.inlineEdit` (scoped-selection editing) is a stub; UI cancellation of a
  live turn is not wired. With another month: both, plus applied-change undo in
  the editor UI.
- Two agent-authored edits in Task B needed human repairs (one truncated stage,
  one edit spec missing a helper function), and one pre-existing fixture test
  failure in `tests/test_reqctx.py` is unrelated to Gavel; disclosed in
  `UNIVERSAL_AUDIT.md` and the commit history.
- Staged edits live in memory only: a server restart discards the queue. With
  another month: persist the queue to disk with a resumable session id.
- Pre-existing fixture issues labeled, not caused by Gavel: pytest 9.2.0 cannot
  collect the fixture's test module (pinned to 8.4.2); one helper test needs the
  optional `asgiref` extra.
