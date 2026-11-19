// Gavel VS Code extension (M6: per-hunk review).
// Talks to a running TrueForge instance (default http://localhost:8790) and the
// gavel-files MCP server (:8791). Every edit is staged; the user reviews each
// staged hunk in VS Code's native diff editor before anything touches disk.
import * as vscode from "vscode";
import { TrueForge } from "@truefoundry/trueforge-sdk";

const BASE_URL = process.env.TRUEFORGE_URL || "http://localhost:8790";
const MCP_URL = process.env.GAVEL_MCP_URL || "http://localhost:8791";
const MODEL = process.env.GAVEL_MODEL || "gavel/gpt-oss-120b";
const MCP_NAME = "gavel-files";

let client: TrueForge;
let sessionId: string | undefined;

type Approval = { threadId: string; toolCallId: string; name?: string };
type StagedEdit = { n: number; path: string; old_string: string; new_string: string };

// The agent definition. Keep in sync with driver/run.mjs INSTRUCTIONS.
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

async function ensureSession(channel: vscode.OutputChannel): Promise<string> {
  if (sessionId) {
    return sessionId;
  }
  const session = await client.sessions.create({
    agent: {
      spec: {
        model: { name: MODEL },
        instructions: INSTRUCTIONS,
        mcpServers: [
          {
            name: MCP_NAME,
            preload: true,
            // Edits always go through approval: the user reviews each staged
            // edit before anything touches disk.
            requireApprovalForTools: [
              "stage_edit",
              "apply_staged_edits",
              "apply_staged_edit",
              "discard_staged_edits",
            ],
          },
        ],
        config: {
          dynamicSubAgents: { enabled: false },
          generativeUi: { enabled: false },
          askUserQuestions: { enabled: false },
          contextManagement: {
            compaction: { enabled: true, trigger: { type: "input_tokens", value: 5500 } },
          },
        },
      },
    },
  } as any);
  sessionId = String((session as any).data.id);
  channel.appendLine(`[gavel] session ${sessionId} (model ${MODEL})`);
  return sessionId;
}

async function fetchStaged(): Promise<StagedEdit[]> {
  const res = await fetch(`${MCP_URL}/staged`);
  const body = (await res.json()) as { staged: StagedEdit[] };
  return body.staged ?? [];
}

// Show one staged hunk as a native side-by-side diff: current file on the
// left, the file with this hunk applied on the right.
async function showHunkDiff(edit: StagedEdit): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const uri = vscode.Uri.file(root ? `${root}/${edit.path}` : edit.path);
  const current = await vscode.workspace.fs.readFile(uri);
  const before = Buffer.from(current).toString("utf8");
  const after = before.split(edit.old_string).join(edit.new_string);
  const left = await vscode.workspace.openTextDocument({ content: before, language: "python" });
  const right = await vscode.workspace.openTextDocument({ content: after, language: "python" });
  await vscode.commands.executeCommand(
    "vscode.diff",
    left.uri,
    right.uri,
    `Gavel staged edit #${edit.n}: ${edit.path}`
  );
}

// Ask the user about one pending tool approval. Returns "allow" or "deny".
async function reviewApproval(approval: Approval, channel: vscode.OutputChannel): Promise<string> {
  for (;;) {
    const isEditTool = (approval.name ?? "").includes("staged") || (approval.name ?? "") === "stage_edit";
    const options = isEditTool ? ["Allow", "Deny", "Show staged diffs"] : ["Allow", "Deny"];
    const pick = await vscode.window.showInformationMessage(
      `Gavel wants to run ${approval.name ?? "a tool"}. Review before allowing.`,
      { modal: true },
      ...options
    );
    if (pick === "Show staged diffs") {
      const staged = await fetchStaged();
      channel.appendLine(`[gavel] ${staged.length} staged edit(s)`);
      for (const edit of staged) {
        await showHunkDiff(edit);
      }
      continue; // ask again after review
    }
    return pick === "Allow" ? "allow" : "deny";
  }
}

async function ask(channel: vscode.OutputChannel): Promise<void> {
  const prompt = await vscode.window.showInputBox({
    prompt: "What should Gavel do?",
    placeHolder: "e.g. add --version to the CLI",
  });
  if (!prompt) {
    return;
  }
  channel.show(true);
  channel.appendLine(`\n> ${prompt}`);
  const id = await ensureSession(channel);

  let input: any[] = [{ type: "user.message", content: prompt }];
  for (let round = 0; round < 25; round++) {
    const pending: Approval[] = [];
    let done = false;
    const stream = await client.sessions.createTurnStream(id, { input } as any);
    for await (const event of stream as any) {
      const e = event as any;
      if (e.type === "content.delta" && e.delta) {
        channel.append(e.delta);
      } else if (e.type === "tool.call") {
        channel.appendLine(`\n[tool] ${e.name ?? e.toolName ?? "call"}`);
      } else if (e.type === "tool.approval_required") {
        for (const ref of e.toolCalls ?? []) {
          pending.push({ threadId: e.threadId, toolCallId: ref.id, name: ref.name });
        }
      } else if (e.type === "turn.done") {
        done = true;
        const st = e.state ?? {};
        channel.appendLine(`\n[done] status=${st.status ?? "unknown"}`);
        for (const ra of st.requiredActions ?? []) {
          if (ra.type === "tool.approval_required") {
            for (const ref of ra.toolCalls ?? []) {
              pending.push({ threadId: ra.threadId, toolCallId: ref.id, name: ref.name });
            }
          }
        }
        if (st.status === "error") {
          channel.appendLine(`[error] ${st.message ?? "unknown error"}`);
          return;
        }
      }
    }
    if (pending.length === 0 || !done) {
      return; // turn finished with nothing left to approve
    }
    const uniq = [...new Map(pending.map((a) => [a.toolCallId, a])).values()];
    input = [];
    for (const a of uniq) {
      const verdict = await reviewApproval(a, channel);
      channel.appendLine(`[approval] ${verdict} ${a.name ?? a.toolCallId}`);
      input.push({
        type: "user.tool_approval",
        threadId: a.threadId,
        toolCallId: a.toolCallId,
        approval: { status: verdict },
      });
    }
  }
}

async function inlineEdit(channel: vscode.OutputChannel): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Gavel: open a file first");
    return;
  }
  const selection = editor.selection;
  const text = editor.document.getText(selection);
  // TODO (M7): run a scoped edit turn over the selection, then review hunks
  // with the same approval + diff flow as gavel.ask.
  channel.show(true);
  channel.appendLine(
    `[gavel] inline edit stub: ${text.length} chars selected in ${editor.document.fileName}`
  );
  vscode.window.showInformationMessage("Gavel: inline edit is stubbed (scoped turns in M7)");
}

export function activate(context: vscode.ExtensionContext): void {
  client = new TrueForge({ baseUrl: BASE_URL } as any);
  const channel = vscode.window.createOutputChannel("Gavel");
  context.subscriptions.push(
    channel,
    vscode.commands.registerCommand("gavel.ask", () => ask(channel)),
    vscode.commands.registerCommand("gavel.inlineEdit", () => inlineEdit(channel))
  );
}

export function deactivate(): void {
  // TODO: cancel any live session server-side so nothing half-runs.
}
