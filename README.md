# Gavel

Repo-aware inline code editing for VS Code, built on the TrueForge harness and MCP.
TrueFoundry Forge-a-thon (Techfest 2026-27) Round 1 entry.

## Round 1 submission links

- Demo video (2 min 56 s): https://drive.google.com/file/d/1R0wCx27qgaiST0aVfnFJQHWKbPJ_BSDZ/view
- Write-up PDF: https://drive.google.com/file/d/1YIVaoDxS6WCVbyoO9ERAjyMnLJri_R2h/view

## What it does

- You ask for a change in plain language (agent panel or inline over a selection).
- Gavel explores the repo with budgeted, rarity-weighted retrieval (it shows which
  files it chose and why), plans, and stages edits.
- Every change is staged first. You review each hunk in VS Code's native diff view,
  accept or reject per hunk. Nothing touches disk without your approval.
- An applied change can be undone (revert the staged patch).
- If a model fails, the gateway retries with backoff and falls back to a second
  configured model automatically; the workspace is never left half-written.

## Architecture

- **TrueForge** (hackathon harness): sessions, turns, streaming, tool approvals.
- **MCP file server** (`server/server.mjs`): list_files, read_file (capped),
  read_symbol, search, find_context (budgeted retrieval + JSON trace),
  stage_edit / list / apply (one or all) / reject / discard. All writes staged.
- **Model gateway** (`gateway/gateway.mjs`): OpenAI-compatible proxy in front of the
  model provider. Retries 429s honoring Retry-After, skips daily-capped models,
  falls back to a second model, clamps output sizes to free-tier limits, logs every call.
- **VS Code extension** (`extension/`): commands, streaming output, approval modals,
  per-hunk native diff review.
- **Driver** (`driver/run.mjs`): headless runner used for scripted task verification.

## Models

Free tier only, all through the gateway: Groq `qwen/qwen3.8-27b` ->
`openai/gpt-oss-20b` -> `openai/gpt-oss-120b` (automatic fallback chain). Exact call
counts per run are in `logs/gateway-calls.jsonl`.

## Verified results (Nov 11-12, 2026)

- Task A: PASS, 12/12 input cases (flask-fixture commit 194af49).
- Task B (`flask config` command): PASS, agent-staged through the review flow;
  pytest 56 passed / 3 skipped; live secret masking verified (commit 0a7866f).
- Task C (resilience): PASS - invalid key gives a clean immediate error; a dead
  primary model triggers automatic fallback with no user action; workspace clean.
- Extension runtime: PASS in real VS Code 1.112 (headless harness in
  `extension-test/`); activation, streaming, approval flow, edit landed on disk.
- Demo video: `gavel-demo-raw.mp4` (2 min 56 s, full prompt -> approve -> applied loop).
- Write-up: `docs/writeup.md` (rendered PDF: gavel-writeup.pdf).

## Setup from a clean clone

Requirements: Node.js 22+, npm, and a Groq free-tier API key stored in a local
file OUTSIDE the repo (never commit keys).

```bash
npm install                       # root: MCP server, gateway, driver deps
# 1. MCP file server (repository tools) - point GAVEL_ROOT at any repo to edit
GAVEL_ROOT=/path/to/target-repo PORT=8791 node server/server.mjs &
# 2. Model gateway (OpenAI-compatible, resilience + fallback chain)
cp gateway/models.example.env /tmp/gavel-models.env   # edit paths inside
set -a; . /tmp/gavel-models.env; set +a
GROQ_KEY_FILE=/path/outside/repo/groq-key node gateway/gateway.mjs &
# 3. TrueForge locally (hackathon harness)
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge --port 8790 &
```

Register the gateway as a model provider and the MCP server with TrueForge
(one-time, via its API):

```bash
curl -X POST localhost:8790/api/v1/settings/model-providers -H 'content-type: application/json' \\
  -d '{"manifest":{"name":"gavel","type":"custom","base_url":"http://127.0.0.1:8792/v1","models":[{"name":"gpt-oss-120b","model_id":"gavel/gpt-oss-120b","properties":{}}]}}'
curl -X POST localhost:8790/api/v1/settings/mcp-servers -H 'content-type: application/json' \\
  -d '{"manifest":{"name":"gavel-files","type":"remote","url":"http://127.0.0.1:8791/mcp","description":"Gavel staged file tools"}}'
```

Load the agent definition (model + MCP tools + approval policy): it is the
session spec created by the driver (`driver/run.mjs`, see `node driver/run.mjs
--prompt-file prompts/task-a.txt --label demo`) or by the VS Code extension
(`extension/`, `gavel.ask`). Both declare the MCP server with
`requireApprovalForTools` on every write tool.

Fork point: none - Gavel is from scratch; the demo target repo in our runs is
pallets/flask tag 3.1.3. Example model configuration file:
`gateway/models.example.env`. Upstream LICENSEs (flask fixture, TrueForge) are
preserved. No API keys or secrets are committed.

## Status

Honest per-gate status: see UNIVERSAL_AUDIT.md and CHECKPOINT_STATUS.md.
Tests: `node tests/smoke.mjs` (25 checks), `node tests/injection-drill.mjs` (6 checks).
