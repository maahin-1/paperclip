// Protocol fixture: no provider network calls and no secrets.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const home = process.env.PI_CODING_AGENT_DIR;
mkdirSync(join(home, "sessions"), { recursive: true });
const sessionFile = join(home, "sessions", "fixture.jsonl");
writeFileSync(sessionFile, JSON.stringify({ type: "session", cwd: process.cwd() }) + "\n");
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let active = false;
let model = "fixture-model";
const compaction = () => ({ firstKeptEntryId: "fixture-entry", tokensBefore: 50, summary: "Fixture compacted", usage: { input: 5, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0.02 } } });
const finish = (answer = "done") => {
  output({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: answer } });
  output({ type: "message_end", message: { role: "assistant", timestamp: Date.now(), stopReason: "stop", usage: { input: 11, output: 3, cacheRead: 2, cacheWrite: 0, cost: { total: 0.01 } } } });
  output({ type: "agent_end" });
  // An agent_end alone must not settle the ACP prompt.
  setTimeout(() => { active = false; output({ type: "agent_settled" }); }, 15);
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const response = (data = {}) => output({ type: "response", id: request.id, command: request.type, success: true, data });
  if (request.type === "extension_ui_response") { finish(JSON.stringify(request)); return; }
  if (request.type === "get_state") { response({ sessionId: "fixture-session", sessionFile, model: { provider: "openrouter", id: model }, thinkingLevel: "off" }); return; }
  if (request.type === "get_available_models") { response({ models: [{ provider: "openrouter", id: "fixture-model", name: "Fixture" }] }); return; }
  if (request.type === "set_model") { model = request.modelId; response({ model: { provider: request.provider, id: model } }); return; }
  if (request.type === "get_messages") { response({ messages: [] }); return; }
  if (request.type === "get_commands") { response({ commands: process.env.PI_FIXTURE_EXTENSION_FAIL ? [] : [{ name: "paperclip-runtime-ready-v1", description: "Paperclip runtime gate v1", source: "extension" }] }); return; }
  if (request.type === "steer") { response(); output({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `steered:${request.message}` } }); return; }
  if (request.type === "follow_up") { response(); finish(`follow-up:${request.message}`); return; }
  if (request.type === "compact") { output({ type: "compaction_start", reason: "manual" }); const result = compaction(); output({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false }); response(result); return; }
  if (request.type === "abort") { response(); if (active) { active = false; output({ type: "agent_settled" }); } return; }
  if (request.type === "prompt") {
    response({ disposition: "started" }); active = true; output({ type: "agent_start" });
    if (request.message === "die") { process.exit(4); }
    if (request.message === "long") return;
    if (request.message === "auto-compact" || request.message === "retry-compact") { output({ type: "compaction_start", reason: "threshold" }); if (request.message === "retry-compact") output({ type: "summarization_retry_scheduled" }); output({ type: "compaction_end", reason: "threshold", result: compaction(), aborted: false, willRetry: true }); finish("compacted"); return; }
    if (request.message === "question") { output({ type: "extension_ui_request", id: "question-id", method: "input", title: "Project name", placeholder: "Name" }); return; }
    if (request.message === "permission") { output({ type: "extension_ui_request", id: "permission-id", method: "select", title: 'paperclip.pi.permission.v1:{"toolCallId":"tool-1","toolName":"bash","input":{"command":"pwd"}}', options: ["Allow once", "Allow for this session", "Deny"] }); return; }
    if (request.message === "failure") {
      output({ type: "message_end", message: { role: "assistant", timestamp: 1, stopReason: "error", usage: { input: 1, output: 0 } } });
      active = false; output({ type: "agent_settled" }); return;
    }
    output({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "fixture reasoning" } });
    finish("hello🌒\u2028world"); return;
  }
  response();
}).on("close", () => process.exit(0));
