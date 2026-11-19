// Headless runtime proof for the Gavel extension: activates it inside a real
// VS Code extension host and runs a scripted turn against the live
// TrueForge + gateway + MCP stack.
const vscode = require("vscode");
const fs = require("fs");

module.exports.run = async () => {
  const ext = vscode.extensions.getExtension("gavel.gavel");
  if (!ext) throw new Error("gavel extension not found");
  await ext.activate();
  fs.writeFileSync("/tmp/gavel-runtime-test.txt", "activated\n");
  const result = await vscode.commands.executeCommand("gavel.runPrompt", {
    prompt: "Reply with exactly this token and nothing else: GAVEL_RUNTIME_OK. Do not call any tools.",
    approveAll: true,
  });
  const text = String(result ?? "");
  fs.writeFileSync("/tmp/gavel-runtime-test.txt", `activated\nresult:${text}\n`);
  if (!text.includes("GAVEL_RUNTIME_OK")) {
    throw new Error(`runtime marker missing, got: ${text.slice(0, 400)}`);
  }
};
