// Gavel model gateway - OpenAI-compatible proxy in front of Groq free tier.
// TrueForge talks to this as a custom provider; it never talks to Groq directly.
// - strips reasoning_content from request messages (Groq rejects it with 400)
// - hides TrueForge wrapper tools from the model (tools are preloaded instead)
// - TPM pacing: rolling 60s per-model token reservations so a burst of agentic
//   calls never triggers the 429 fall-through storm that triple-burns daily
//   budgets. Requests that cannot be admitted within HOLD_MAX_MS get a local
//   429 with Retry-After; TrueForge polls until a slot opens. No upstream call
//   is made unless the model's minute has room.
// - retries upstream 429 honoring Retry-After, then falls back along the chain
// - counts every upstream call to logs/gateway-calls.jsonl
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 8792);
const HOST = "127.0.0.1";
const UPSTREAM = process.env.GAVEL_UPSTREAM || "https://api.groq.com/openai/v1/chat/completions";
const KEY_FILE = process.env.GROQ_KEY_FILE;
const LOG_DIR = process.env.GAVEL_LOGS || path.resolve(process.cwd(), "logs");
const CALLS_LOG = path.join(LOG_DIR, "gateway-calls.jsonl");

const PRIMARY = process.env.GAVEL_PRIMARY || "openai/gpt-oss-120b";
const FALLBACK = process.env.GAVEL_FALLBACK || "qwen/qwen3.8-27b";
// GAVEL_PREFER: force every request to start at this model (per-model pins upstream
// can strand a session on a day-capped model; the fallback chain still applies).
const PREFER = process.env.GAVEL_PREFER || null;
// Ordered fallback chain after the preferred/mapped model (comma-separated).
const CHAIN = (process.env.GAVEL_CHAIN || "qwen/qwen3.8-27b,openai/gpt-oss-20b,openai/gpt-oss-120b").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_429_RETRIES = 1;
// TrueForge's model client needs response headers within 20s per attempt and
// itself retries 429s (honoring Retry-After up to 5s). Wait briefly here, then
// hand the 429 back with a small Retry-After so TrueForge's retry does the rest.
const MAX_TOTAL_WAIT_MS = 10_000;

// TPM pacing. Groq free tier: ~8000 tokens/min per model (prompt+completion).
// Reserve est tokens per admitted request in a rolling 60s window; hold up to
// HOLD_MAX_MS for a slot, else answer 429 locally (upstream never sees it).
const TPM_LIMIT = Number(process.env.GAVEL_TPM || 7000);
const HOLD_MAX_MS = Number(process.env.GAVEL_HOLD_MAX_MS || 18_000);
const tpmWindows = new Map(); // model -> [{t, tokens}] (reservations, 60s rolling)

function estTokens(body) {
  let c = 0;
  for (const m of body.messages || []) {
    if (!m) continue;
    c += (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content || "").length);
    c += JSON.stringify(m.tool_calls || "").length;
  }
  c += JSON.stringify(body.tools || []).length;
  return Math.ceil(c / 3.5) + 200; // chars->tokens estimate, conservative
}

function pruneWindow(arr) {
  const cutoff = Date.now() - 60_000;
  return arr.filter((e) => e.t > cutoff);
}

// Returns ms to wait for a slot (reservation made), or -1 if no slot within HOLD_MAX_MS.
function reserveTpm(model, est) {
  const now = Date.now();
  let arr = pruneWindow(tpmWindows.get(model) || []);
  const used = () => arr.reduce((s, e) => s + e.tokens, 0);
  if (used() + est <= TPM_LIMIT) {
    arr.push({ t: now, tokens: est });
    tpmWindows.set(model, arr);
    return 0;
  }
  // Find when enough budget frees: entries expire oldest-first.
  const sorted = [...arr].sort((a, b) => a.t - b.t);
  let acc = used();
  for (const e of sorted) {
    acc -= e.tokens;
    if (acc + est <= TPM_LIMIT) {
      const wait = e.t + 60_000 - now;
      if (wait > HOLD_MAX_MS) { tpmWindows.set(model, arr); return -1; }
      // Reserve at the future slot so concurrent requests queue behind us.
      arr.push({ t: e.t + 60_000, tokens: est });
      tpmWindows.set(model, arr);
      return wait;
    }
  }
  tpmWindows.set(model, arr);
  return -1;
}

// TrueForge wrapper tools the model must not see (we preload MCP tools directly).
const HIDDEN_TOOLS = new Set(["call_tool", "list_tools", "get_tool_info", "get_tool_output_schema", "get_current_datetime"]);

let apiKey = null;
function key() {
  if (!apiKey) apiKey = fs.readFileSync(KEY_FILE, "utf8").trim();
  return apiKey;
}

// Models that told us their daily (TPD) budget is exhausted, with the time they
// gave us ("try again in ..."). Skipped as candidates until then so a day-capped
// fallback never stalls a run whose primary still has budget.
const tpdBlocked = new Map(); // model -> unblockAt epoch ms
function markTpd(model, text) {
  if (!/tokens per day/i.test(String(text || ""))) return;
  const m = /try again in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)?s?/i.exec(String(text));
  let waitS = 3600;
  if (m) waitS = (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Math.ceil(Number(m[3] || 0));
  tpdBlocked.set(model, Date.now() + waitS * 1000);
  logCall({ model, status: 429, attempt: 0, ms: 0, tpd_blocked_seconds: waitS });
}

let counters = { total_requests: 0, by_model: {}, retries_429: 0, fallbacks: 0, paced_429: 0, held_requests: 0, started_at: new Date().toISOString() };

function logCall(rec) {
  counters.total_requests++;
  counters.by_model[rec.model] = (counters.by_model[rec.model] || 0) + 1;
  if (rec.status === 429) counters.retries_429++;
  if (rec.fallback) counters.fallbacks++;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(CALLS_LOG, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n");
}

function mapModel(requested) {
  if (PREFER) return PREFER;
  const r = String(requested || "");
  if (r.includes("gpt-oss")) return PRIMARY;
  if (r.includes("qwen")) return FALLBACK;
  return PRIMARY;
}

function cleanBody(body, model) {
  const b = { ...body, model };
  // Groq free per-minute output caps: qwen 1k OTPM, gpt-oss generous. Clamp so
  // a single request never asks for more than the fallback can emit.
  const outCap = model === FALLBACK ? 950 : model.includes("gpt-oss-20b") ? 2500 : 4000;
  // gpt-oss-20b burns output budget on reasoning; keep it low so content fits.
  if (model.includes("gpt-oss-20b") && !b.reasoning_effort) b.reasoning_effort = "low";
  if (!b.max_tokens || b.max_tokens > outCap) b.max_tokens = outCap;
  if (b.max_completion_tokens && b.max_completion_tokens > outCap) b.max_completion_tokens = outCap;
  if (Array.isArray(b.messages)) {
    b.messages = b.messages.map((m) => {
      if (!m || typeof m !== "object") return m;
      const { reasoning_content, reasoning, ...rest } = m;
      return rest;
    });
  }
  if (Array.isArray(b.tools)) {
    b.tools = b.tools.filter((t) => !(t && t.function && HIDDEN_TOOLS.has(t.function.name)));
    if (b.tools.length === 0) { delete b.tools; delete b.tool_choice; }
  }
  return b;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callUpstream(body, model, isFallback) {
  let attempt = 0;
  let totalWaited = 0;
  for (;;) {
    attempt++;
    const started = Date.now();
    let res;
    try {
      res = await fetch(UPSTREAM, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key()}` },
        body: JSON.stringify(cleanBody(body, model)),
        signal: AbortSignal.timeout(75_000),
      });
    } catch (e) {
      logCall({ model, status: 0, attempt, ms: Date.now() - started, fallback: !!isFallback, error: String(e && e.name || e) });
      return { ok: false, status: 504, text: async () => JSON.stringify({ error: `gateway upstream timeout: ${e && e.name || e}` }), headers: new Headers() };
    }
    logCall({ model, status: res.status, attempt, ms: Date.now() - started, fallback: !!isFallback, stream: !!body.stream });
    if (res.status === 429 && attempt <= MAX_429_RETRIES) {
      const ra = Number(res.headers.get("retry-after") || "10");
      const waitMs = Math.min(MAX_TOTAL_WAIT_MS - totalWaited, Math.max(1000, ra * 1000));
      await res.arrayBuffer().catch(() => {});
      if (waitMs < 1000) return res; // budget exhausted: hand the 429 back to TrueForge
      totalWaited += waitMs;
      await sleep(waitMs);
      continue;
    }
    return res;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [PRIMARY, FALLBACK].map((id) => ({ id, object: "model", created: 0, owned_by: "gavel-gateway" })) }));
      return;
    }
    if (req.method === "GET" && req.url === "/stats") {
      const windows = {};
      for (const [m, arr0] of tpmWindows) {
        const arr = pruneWindow(arr0);
        tpmWindows.set(m, arr);
        windows[m] = { used_in_window: arr.reduce((s, e) => s + e.tokens, 0), limit: TPM_LIMIT };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...counters, tpm_windows: windows }, null, 2));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch { res.writeHead(400).end('{"error":"bad json"}'); return; }
      const model = mapModel(body.model);
      const est = estTokens(body);
      // Fallback chain: preferred/mapped model first, then the rest of CHAIN.
      const ordered = [model, ...CHAIN.filter((m) => m !== model)];
      const candidates = ordered.filter((m) => (tpdBlocked.get(m) || 0) <= Date.now());
      if (candidates.length === 0) {
        const waitS = Math.ceil(Math.min(...ordered.map((m) => (tpdBlocked.get(m) || Date.now()) - Date.now())) / 1000);
        res.writeHead(429, { "content-type": "application/json", "retry-after": "5" });
        res.end(JSON.stringify({ error: `gavel gateway: all models daily-capped, earliest retry ~${waitS}s` }));
        return;
      }
      // TPM admission: poll for a chain model with a slot, holding the HTTP
      // request up to HOLD_MAX_MS (TrueForge's per-attempt header budget is
      // ~20s, and it retries 429s a few times - so a 60s TPM window is bridged
      // by 2-3 held attempts instead of aborting the turn).
      const deadline = Date.now() + HOLD_MAX_MS;
      let picked = -1;
      let waitMs = 0;
      for (;;) {
        for (let i = 0; i < candidates.length; i++) {
          const w = reserveTpm(candidates[i], est);
          if (w === 0) { picked = i; waitMs = 0; break; }
          if (w > 0 && Date.now() + w <= deadline) { picked = i; waitMs = w; break; }
        }
        if (picked >= 0 || Date.now() + 1000 > deadline) break;
        await sleep(1000);
      }
      if (picked === -1) {
        counters.paced_429++;
        res.writeHead(429, { "content-type": "application/json", "retry-after": "4" });
        res.end(JSON.stringify({ error: "gavel gateway: TPM pacing, every model's minute is full; retry in ~4s", paced: true }));
        return;
      }
      if (waitMs > 0) { counters.held_requests++; await sleep(waitMs); }
      const served = [candidates[picked], ...candidates.filter((_, i) => i !== picked)];
      let upstream = await callUpstream(body, served[0], picked > 0);
      let ci = 0;
      while (!upstream.ok && upstream.status !== 400 && ci + 1 < served.length) {
        // fall through the chain once per model; admit the fallback only if its
        // minute has room right now (no holding on a fallback).
        const drained = await upstream.text().catch(() => "");
        markTpd(served[ci], drained);
        ci++;
        if (reserveTpm(served[ci], est) !== 0) {
          logCall({ model: served[ci], status: 429, attempt: 0, ms: 0, fallback: true, paced_skip: true });
          continue;
        }
        upstream = await callUpstream(body, served[ci], true);
      }
      if (!upstream.ok && ci > 0) {
        const t = await upstream.text().catch(() => "");
        markTpd(served[ci], t);
        res.writeHead(upstream.status, { "content-type": "application/json" });
        res.end(t || `{"error":"upstream ${upstream.status}"}`);
        return;
      }
      // stream or buffer through
      const upstreamHeaders = {
        "content-type": upstream.headers.get("content-type") || "application/json",
        ...(body.stream ? { "cache-control": "no-cache", connection: "keep-alive" } : {}),
      };
      if (upstream.status === 429) upstreamHeaders["retry-after"] = "4";
      res.writeHead(upstream.status, upstreamHeaders);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) await new Promise((r) => res.once("drain", r));
        }
      }
      res.end();
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not found"}');
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
});

server.listen(PORT, HOST, () => console.log(`gavel-gateway on http://${HOST}:${PORT}/v1 primary=${PRIMARY} fallback=${FALLBACK} tpm_limit=${TPM_LIMIT}`));
