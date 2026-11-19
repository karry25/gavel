// Gavel smoke tests - exercises the MCP server end to end against a temp repo.
// Run: node tests/smoke.mjs   (spawns its own server on :8795, no other services needed)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8795;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-smoke-"));
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "hello.py"), "def greet():\n    return 'hi'\n\nprint(greet())\n");
fs.writeFileSync(path.join(root, "README.md"), "# smoke repo\n");

const server = spawn("node", ["server/server.mjs"], {
  env: { ...process.env, GAVEL_ROOT: root, PORT: String(PORT) },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 1200));

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name} ${detail}`); }
}

try {
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
  const call = async (tool, args = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    return r.content.map((c) => c.text).join("\n");
  };

  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ["list_files", "read_file", "search", "find_context", "stage_edit", "list_staged_edits", "apply_staged_edits", "apply_staged_edit", "reject_staged_edit", "discard_staged_edits"])
    check(`tool registered: ${t}`, tools.includes(t));

  const list = await call("list_files");
  check("list_files finds files", list.includes("src/hello.py") && list.includes("README.md"));

  const read = await call("read_file", { path: "src/hello.py" });
  check("read_file returns numbered lines", read.includes("1: def greet():"));

  const esc = await call("read_file", { path: "../outside.txt" }).catch((e) => String(e));
  check("path traversal blocked", /escapes|error/i.test(esc), esc.slice(0, 80));

  const bad = await call("stage_edit", { path: "src/hello.py", old_string: "nope", new_string: "x" });
  check("stage_edit rejects missing old_string", bad.includes("ERROR"), bad.slice(0, 60));

  const st1 = await call("stage_edit", { path: "src/hello.py", old_string: "return 'hi'", new_string: "return 'hello'" });
  check("stage_edit stages", st1.includes("staged edit #1"), st1.slice(0, 60));
  check("staged edit NOT on disk yet", fs.readFileSync(path.join(root, "src", "hello.py"), "utf8").includes("return 'hi'"));

  const st2 = await call("stage_edit", { path: "README.md", old_string: "# smoke repo", new_string: "# smoke repo v2" });
  check("second stage_edit stages", st2.includes("staged edit #2"), st2.slice(0, 60));

  const stagedList = await call("list_staged_edits");
  check("list_staged_edits shows 2", stagedList.includes("src/hello.py") && stagedList.includes("README.md"));

  const side = await (await fetch(`http://127.0.0.1:${PORT}/staged`)).json();
  check("/staged side channel returns full edits", side.staged.length === 2 && side.staged[0].new_string === "return 'hello'");

  const rej = await call("reject_staged_edit", { n: 2 });
  check("reject_staged_edit drops one", rej.includes("rejected staged edit #2"), rej.slice(0, 60));

  const ap1 = await call("apply_staged_edit", { n: 1 });
  check("apply_staged_edit writes one", ap1.includes("applied staged edit #1"), ap1.slice(0, 60));
  check("edit landed on disk", fs.readFileSync(path.join(root, "src", "hello.py"), "utf8").includes("return 'hello'"));
  check("rejected edit NOT on disk", fs.readFileSync(path.join(root, "README.md"), "utf8").includes("# smoke repo\n"));

  const apAll = await call("apply_staged_edits");
  check("apply_staged_edits with empty list is safe", apAll.includes("no staged edits"));

  const ctx = await call("find_context", { query: "greet function" });
  check("find_context returns results + trace", ctx.includes("hello.py") && ctx.includes("files_indexed"));

  await client.close();
} finally {
  server.kill();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
