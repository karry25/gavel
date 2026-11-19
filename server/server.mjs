// Gavel MCP file server - exposes editor-style file tools over MCP (StreamableHTTP).
// Every read is capped; every write is staged in memory until apply_staged_edits.
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.env.GAVEL_ROOT || process.cwd());
const PORT = Number(process.env.PORT || 8791);
const HOST = "127.0.0.1";
const READ_CAP = 120; // lines per read_file call
const CTX_BUDGET = 3500; // chars per find_context call
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", "site-packages"]);
const MAX_FILE_BYTES = 256 * 1024;

function safeResolve(p) {
  const abs = path.resolve(ROOT, p || ".");
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    throw new Error(`path escapes workspace root: ${p}`);
  }
  return abs;
}

function rel(abs) { return path.relative(ROOT, abs) || "."; }

function walk(dir, out, cap = 20000) {
  if (out.length >= cap) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= cap) return;
    if (e.name.startsWith(".") && e.name !== ".") { if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue; }
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, out, cap); }
    else if (e.isFile()) out.push(full);
  }
}

function isTextFile(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_FILE_BYTES) return false;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(2048, st.size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return !buf.includes(0);
  } catch { return false; }
}

function readLines(abs) {
  return fs.readFileSync(abs, "utf8").split("\n");
}

const ok = (text) => ({ content: [{ type: "text", text }] });
const okJson = (obj) => ok(JSON.stringify(obj, null, 2));

// ---------- find_context index ----------
let ctxIndex = null;
function buildIndex() {
  const files = [];
  walk(ROOT, files);
  const docs = [];
  for (const f of files) {
    if (!isTextFile(f)) continue;
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    docs.push({ path: rel(f), text, lower: text.toLowerCase() });
  }
  ctxIndex = { docs, df: new Map() };
}
function docFreq(term) {
  if (!ctxIndex.df.has(term)) {
    let n = 0;
    for (const d of ctxIndex.docs) if (d.lower.includes(term)) n++;
    ctxIndex.df.set(term, n);
  }
  return ctxIndex.df.get(term);
}

function findContext(query, maxChars) {
  if (!ctxIndex) buildIndex();
  const N = ctxIndex.docs.length;
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length >= 3))];
  const termInfo = terms.map((t) => {
    const df = docFreq(t);
    const idf = Math.log(1 + N / (1 + df));
    return { term: t, df, idf: Number(idf.toFixed(3)) };
  }).filter((t) => t.df > 0);
  const scored = [];
  for (const d of ctxIndex.docs) {
    let score = 0; const matched = [];
    for (const t of termInfo) {
      if (d.lower.includes(t.term)) { score += t.idf; matched.push(t.term); }
    }
    const stem = path.basename(d.path).replace(/\.[^.]+$/, "").toLowerCase();
    let bonus = false;
    for (const t of termInfo) if (stem === t.term) { score += 3; bonus = true; }
    if (score > 0) scored.push({ path: d.path, score: Number(score.toFixed(3)), matched, filename_bonus: bonus, doc: d });
  }
  scored.sort((a, b) => b.score - a.score);
  const chosen = [];
  let used = 0;
  for (const s of scored) {
    if (used >= maxChars) break;
    const lines = s.doc.text.split("\n");
    const lowerLines = s.doc.lower.split("\n");
    const hitIdx = [];
    for (let i = 0; i < lowerLines.length; i++) {
      if (s.matched.some((t) => lowerLines[i].includes(t))) hitIdx.push(i);
      if (hitIdx.length >= 12) break;
    }
    const keep = new Set();
    for (const i of hitIdx) for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j);
    let excerpt = [...keep].sort((a, b) => a - b).map((i) => `${i + 1}: ${lines[i]}`).join("\n");
    const room = maxChars - used;
    if (excerpt.length > room) excerpt = excerpt.slice(0, room);
    if (excerpt.trim().length === 0) continue;
    used += excerpt.length;
    chosen.push({ path: s.path, score: s.score, matched_terms: s.matched, filename_bonus: s.filename_bonus, chars: excerpt.length, excerpt });
    if (chosen.length >= 8) break;
  }
  return {
    query,
    budget_chars: maxChars,
    used_chars: used,
    files_indexed: N,
    terms: termInfo,
    chosen_files: chosen.map(({ doc, ...rest }) => rest),
    trace: `scored ${scored.length} files with ${termInfo.length} rare-enough terms; returned top ${chosen.length} within ${maxChars}-char budget`,
  };
}

// ---------- staged edits ----------
const staged = []; // {path, old_string, new_string}

// ---------- server factory (stateless: one per request) ----------
function makeServer() {
  const server = new McpServer({ name: "gavel-files", version: "0.1.0" });

  server.registerTool("list_files", {
    title: "List files",
    description: "List files in the workspace (optionally under a subdirectory and/or matching a substring). Paths are relative to the repo root.",
    inputSchema: { dir: z.string().optional(), contains: z.string().optional(), limit: z.number().int().min(1).max(2000).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ dir = ".", contains, limit = 400 }) => {
    const base = safeResolve(dir);
    const out = [];
    walk(base, out, 20000);
    let files = out.map(rel);
    if (contains) files = files.filter((f) => f.toLowerCase().includes(contains.toLowerCase()));
    const total = files.length;
    files = files.slice(0, limit);
    return ok(files.join("\n") + `\n(${files.length} of ${total} shown)`);
  });

  server.registerTool("read_file", {
    title: "Read file",
    description: `Read up to ${READ_CAP} lines of a file with line numbers. Use start_line to page through long files.`,
    inputSchema: { path: z.string(), start_line: z.number().int().min(1).optional(), num_lines: z.number().int().min(1).max(READ_CAP).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ path: p, start_line = 1, num_lines = READ_CAP }) => {
    const lines = readLines(safeResolve(p));
    const start = start_line - 1;
    const slice = lines.slice(start, start + Math.min(num_lines, READ_CAP));
    const text = slice.map((l, i) => `${start + i + 1}: ${l}`).join("\n");
    return ok(text + `\n(lines ${start + 1}-${start + slice.length} of ${lines.length})`);
  });

  server.registerTool("read_symbol", {
    title: "Read symbol",
    description: "Extract one function or class definition (Python/JS/TS) by name from a file, with line numbers.",
    inputSchema: { path: z.string(), symbol: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ path: p, symbol }) => {
    const lines = readLines(safeResolve(p));
    const defRe = new RegExp(`^(\\s*)(async\\s+def|def|class|export\\s+function|export\\s+async\\s+function|function|const|let|var)\\s+${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    let idx = -1;
    for (let i = 0; i < lines.length; i++) if (defRe.test(lines[i])) { idx = i; break; }
    if (idx === -1) return ok(`symbol not found: ${symbol} in ${p}`);
    const indent = (lines[idx].match(/^\s*/) || [""])[0].length;
    let end = lines.length - 1;
    for (let i = idx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === "") continue;
      const ind = (l.match(/^\s*/) || [""])[0].length;
      if (ind <= indent) { end = i - 1; break; }
    }
    if (end - idx > READ_CAP) end = idx + READ_CAP - 1;
    return ok(lines.slice(idx, end + 1).map((l, i) => `${idx + i + 1}: ${l}`).join("\n"));
  });

  server.registerTool("search", {
    title: "Search",
    description: "Search file contents for a substring or regex. Returns file:line: text matches.",
    inputSchema: { query: z.string(), is_regex: z.boolean().optional(), max_results: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ query, is_regex = false, max_results = 50 }) => {
    if (!ctxIndex) buildIndex();
    let re = null;
    if (is_regex) { try { re = new RegExp(query, "i"); } catch (e) { return ok(`bad regex: ${e.message}`); } }
    const q = query.toLowerCase();
    const hits = [];
    outer: for (const d of ctxIndex.docs) {
      const lines = d.text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(q);
        if (m) {
          hits.push(`${d.path}:${i + 1}: ${lines[i].slice(0, 200)}`);
          if (hits.length >= max_results) break outer;
        }
      }
    }
    return ok(hits.join("\n") || "no matches");
  });

  server.registerTool("find_context", {
    title: "Find context",
    description: "Automatic retrieval: rarity-weighted keyword search over the whole repo with an exact-filename bonus. Returns the most relevant excerpts within a character budget plus a JSON trace of which files were chosen and why.",
    inputSchema: { query: z.string(), max_chars: z.number().int().min(500).max(10000).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ query, max_chars = CTX_BUDGET }) => okJson(findContext(query, max_chars)));

  server.registerTool("stage_edit", {
    title: "Stage edit",
    description: "Stage an exact-string replacement for one file. The old_string must match the file exactly once. Nothing is written to disk until apply_staged_edits is called - the user reviews staged edits first.",
    inputSchema: { path: z.string(), old_string: z.string(), new_string: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ path: p, old_string, new_string }) => {
    const abs = safeResolve(p);
    const text = fs.readFileSync(abs, "utf8");
    const count = text.split(old_string).length - 1;
    if (count === 0) return ok(`ERROR: old_string not found in ${p}. Read the file again and copy the exact text.`);
    if (count > 1) return ok(`ERROR: old_string matches ${count} times in ${p}; include more surrounding context so it matches exactly once.`);
    staged.push({ path: rel(abs), old_string, new_string });
    return ok(`staged edit #${staged.length} for ${p} (not yet on disk)`);
  });

  server.registerTool("list_staged_edits", {
    title: "List staged edits",
    description: "Show all staged (not yet applied) edits.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => okJson(staged.map((s, i) => ({ n: i + 1, path: s.path, old: s.old_string.slice(0, 120), new: s.new_string.slice(0, 120) }))));

  server.registerTool("apply_staged_edits", {
    title: "Apply staged edits",
    description: "Write every staged edit to disk, then clear the staging list. Call this only after the user has reviewed the staged edits.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async () => {
    if (staged.length === 0) return ok("no staged edits");
    const applied = [];
    for (const s of staged) {
      const abs = safeResolve(s.path);
      const text = fs.readFileSync(abs, "utf8");
      if (text.split(s.old_string).length - 1 !== 1) {
        return ok(`ERROR applying ${s.path}: old_string no longer matches exactly once. No further edits applied. Applied so far: ${applied.length}`);
      }
      fs.writeFileSync(abs, text.replace(s.old_string, s.new_string));
      applied.push(s.path);
    }
    staged.length = 0;
    return ok(`applied ${applied.length} edit(s): ${applied.join(", ")}`);
  });

  server.registerTool("apply_staged_edit", {
    title: "Apply one staged edit",
    description: "Write a single staged edit (by number from list_staged_edits) to disk and remove it from the staging list. Use when the user accepts some edits but not all.",
    inputSchema: { n: z.number().int().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ n }) => {
    const s = staged[n - 1];
    if (!s) return ok(`ERROR: no staged edit #${n}`);
    const abs = safeResolve(s.path);
    const text = fs.readFileSync(abs, "utf8");
    if (text.split(s.old_string).length - 1 !== 1) return ok(`ERROR applying ${s.path}: old_string no longer matches exactly once. Edit left staged.`);
    fs.writeFileSync(abs, text.replace(s.old_string, s.new_string));
    staged.splice(n - 1, 1);
    return ok(`applied staged edit #${n} for ${s.path}`);
  });

  server.registerTool("reject_staged_edit", {
    title: "Reject one staged edit",
    description: "Drop a single staged edit (by number) without writing it. Use when the user rejects one edit but wants to keep reviewing the rest.",
    inputSchema: { n: z.number().int().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ n }) => {
    const s = staged[n - 1];
    if (!s) return ok(`ERROR: no staged edit #${n}`);
    staged.splice(n - 1, 1);
    return ok(`rejected staged edit #${n} for ${s.path}`);
  });

  server.registerTool("discard_staged_edits", {
    title: "Discard staged edits",
    description: "Throw away all staged edits without writing anything.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async () => { const n = staged.length; staged.length = 0; return ok(`discarded ${n} staged edit(s)`); });

  return server;
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = makeServer();
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.get("/mcp", (_req, res) => res.status(405).json({ error: "stateless server: POST only" }));
app.get("/health", (_req, res) => res.json({ ok: true, root: ROOT }));
// Side channel for the VS Code extension: full staged edits for diff review.
// Localhost-only, read-only; the MCP tools remain the write path.
app.get("/staged", (_req, res) =>
  res.json({ staged: staged.map((s, i) => ({ n: i + 1, path: s.path, old_string: s.old_string, new_string: s.new_string })) }));

app.listen(PORT, HOST, () => console.log(`gavel-files MCP server on http://${HOST}:${PORT}/mcp root=${ROOT}`));
