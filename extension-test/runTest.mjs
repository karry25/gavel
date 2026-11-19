import { runTests } from "@vscode/test-electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
await runTests({
  vscodeExecutablePath: "/usr/bin/code",
  extensionDevelopmentPath: path.resolve(here, "../extension"),
  extensionTestsPath: path.resolve(here, "suite/index.js"),
  extensionTestsEnv: { TRUEFORGE_URL: "http://localhost:8790", GAVEL_MCP_URL: "http://127.0.0.1:8791" },
  launchArgs: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "/home/sandbox/gavel/flask-fixture"],
});
console.log("RUNTIME-TEST-PASS");
