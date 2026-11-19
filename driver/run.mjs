// Gavel driver - runs a headless TrueForge session against the gavel-files MCP server.
// Usage: node driver/run.mjs --prompt "..." [--model FQN] [--label NAME] [--auto-approve]
// Streams events to stdout + logs/<label>.transcript.jsonl. Approves staged-edit tool
// calls through TrueForge's approval API (simulating the user pressing "accept").
// SIGINT/SIGTERM cancels the session server-side so a killed run leaves nothing half-run.
import { TrueForge } from "@truefoundry/trueforge-sdk";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
}
const PROMPT = arg("prompt", null);
const PROMPT_FILE = arg("prompt-file", null);
const MODEL = arg("model", process.env.GAVEL_MODEL || "gavel/gpt-oss-120b");
const LABEL = arg("label", `run-${Date.now()}`);
const BASE_URL = process.env.TRUEFORGE_URL || "http://localhost:8790";
const LOG_DIR = path.resolve(process.cwd(), "logs");
const MCP_NAME = process.env.GAVEL_MCP_NAME || "gavel-files";

const prompt = PROMPT || (PROMPT_FILE ? fs.readFileSync(PROMPT_FILE, "utf8") : null);
if (!prompt) { console.error("need --prompt or --prompt-file"); process.exit(2); }

fs.mkdirSync(LOG_DIR, { recursive: true });
const transcript = path.join(LOG_DIR, `${LABEL}.transcript.jsonl`);
const log = (obj) => fs.appendFileSync(transcript, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");

const client = new TrueForge({ baseUrl: BASE_URL });

const INSTRUCTIONS = `You are Gavel, a coding agent working in a repository through MCP file tools.
Workflow rules:
- Find code yourself with find_context, search and list_files. Never ask the user to name files.
- Read before you edit: use read_file or read_symbol on the exact region first.
- Make changes ONLY with stage_edit (exact string match, must match once). Never invent a file write of your own.
- Keep every stage_edit new_string under 250 characters. For a larger insert, stage several small edits that share the same unique anchor; they apply in order.
- Stage every edit the task needs across all files, then call list_staged_edits and confirm the queue is not empty. If a stage_edit call failed, retry it with a smaller new_string.
- Only after the queue holds every edit, STOP and summarize what you staged. The user reviews the staged edits and will ask you to apply them; only then call apply_staged_edits.
- Keep edits minimal and in the style of the surrounding code.
- When done, summarize: files changed and why.`;

let sessionId = null;
let cancelling = false;
async function cancelNow(reason) {
  if (cancelling || !sessionId) return;
  cancelling = true;
  try {
    await client.sessions.cancel(sessionId, {});
    log({ type: "driver.cancel", reason });
    console.error(`\n[driver] session cancelled (${reason})`);
  } catch (e) { console.error(`[driver] cancel failed: ${e.message}`); }
}
process.on("SIGINT", async () => { await cancelNow("SIGINT"); process.exit(130); });
process.on("SIGTERM", async () => { await cancelNow("SIGTERM"); process.exit(143); });

const session = await client.sessions.create({
  agent: {
    spec: {
      model: { name: MODEL },
      instructions: INSTRUCTIONS,
      mcpServers: [{
        name: MCP_NAME,
        preload: true,
        requireApprovalForTools: ["stage_edit", "apply_staged_edits"],
      }],
      config: {
        dynamicSubAgents: { enabled: false },
        generativeUi: { enabled: false },
        askUserQuestions: { enabled: false },
      },
    },
  },
});
sessionId = session.data.id;
log({ type: "driver.session", sessionId, model: MODEL });
console.log(`[driver] session ${sessionId} model=${MODEL}`);

let turnId = null;
let deltas = 0;
let buffer = "";
const t0 = Date.now();
let finished = false;
let stagedPending = false;
let errorResumes = 0;
let resumeNext = false;

let input = [{ type: "user.message", content: prompt }];
for (let round = 0; round < 25 && !finished; round++) {
  resumeNext = false;
  const pendingApprovals = [];
  let sawDone = false;
  const stream = await client.sessions.createTurnStream(sessionId, { input });
  for await (const ev of stream) {
    log({ type: "event", event: ev });
    switch (ev.type) {
      case "turn.created":
        turnId = ev.turnId;
        console.log(`[driver] turn ${turnId}`);
        break;
      case "model.message.delta": {
        const text = (ev.delta && (ev.delta.content || ev.delta.text)) || "";
        if (text) { buffer += text; deltas++; if (deltas % 40 === 0) process.stdout.write(`\r[stream] ${buffer.length} chars...`); }
        break;
      }
      case "model.message": {
        if (buffer) { console.log(`\n[assistant] ${buffer.slice(0, 2000)}`); buffer = ""; deltas = 0; }
        else if (ev.content) console.log(`[assistant] ${typeof ev.content === "string" ? ev.content.slice(0, 2000) : JSON.stringify(ev.content).slice(0, 2000)}`);
        if (ev.toolCalls) for (const tc of ev.toolCalls) console.log(`[tool-call] ${tc.toolInfo?.name || tc.name || "?"} args=${JSON.stringify(tc.arguments ?? tc.args ?? {}).slice(0, 300)}`);
        break;
      }
      case "tool.response": {
        const c = typeof ev.content === "string" ? ev.content : JSON.stringify(ev.content || "");
        if (/staged edit #\d+/.test(c)) stagedPending = true;
        if (/^applied \d+ edit/.test(c) || /no staged edits/.test(c) || /^discarded/.test(c)) stagedPending = false;
        console.log(`[tool-response] ${JSON.stringify(ev).slice(0, 400)}`);
        break;
      }
      case "tool.approval_required":
        for (const ref of ev.toolCalls) pendingApprovals.push({ threadId: ev.threadId, toolCallId: ref.id });
        break;
      case "turn.done": {
        sawDone = true;
        const st = ev.state || {};
        console.log(`\n[driver] turn done: status=${st.status} elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`);
        const reqs = st.requiredActions || [];
        for (const ra of reqs) if (ra.type === "tool.approval_required") for (const ref of ra.toolCalls || []) pendingApprovals.push({ threadId: ra.threadId, toolCallId: ref.id });
        if (st.status === "error") {
          console.log(`[driver] ERROR: ${st.message || JSON.stringify(st)}`);
          const transient = /429|rate|timeout|connect|Retry/i.test(String(st.message || ""));
          if (transient && errorResumes < 6) {
            errorResumes++;
            const waitS = 15 * errorResumes;
            console.log(`[driver] transient model error; resuming turn in ${waitS}s (resume ${errorResumes}/6)`);
            log({ type: "driver.error_resume", message: st.message, resume: errorResumes });
            await new Promise((r) => setTimeout(r, waitS * 1000));
            input = [{ type: "user.message", content: "The model call failed transiently. Continue the task from where you stopped; do not redo edits that are already staged." }];
            resumeNext = true;
          } else {
            finished = true;
          }
        }
        break;
      }
    }
  }
  const uniq = [...new Map(pendingApprovals.map((a) => [a.toolCallId, a])).values()];
  if (resumeNext && !finished) {
    // input already set to the resume message
  } else if (uniq.length > 0 && !finished) {
    for (const a of uniq) console.log(`[approval] approving ${a.toolCallId} (thread ${a.threadId})`);
    log({ type: "driver.approvals", approvals: uniq });
    input = uniq.map((a) => ({ type: "user.tool_approval", threadId: a.threadId, toolCallId: a.toolCallId, approval: { status: "allow" } }));
  } else if (stagedPending && !finished) {
    // the user reviewed the staged diff and pressed Accept
    console.log("[driver] staged edits present; sending user accept -> apply");
    log({ type: "driver.accept_staged" });
    input = [{ type: "user.message", content: "I reviewed the staged edits and accept them all. Call apply_staged_edits now." }];
    stagedPending = false;
  } else {
    finished = true;
    if (!sawDone) console.log("[driver] stream ended without turn.done");
  }
}
log({ type: "driver.exit", elapsed_s: (Date.now() - t0) / 1000 });
console.log(`[driver] done in ${((Date.now() - t0) / 1000).toFixed(1)}s; transcript: ${transcript}`);
