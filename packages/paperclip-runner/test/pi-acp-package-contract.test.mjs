import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Optional test-only package location permits the isolated Pi branch to test
// before the integration owner updates package.json and the shared lockfile.
const packageJson = process.env.PAPERCLIP_TEST_PI_ACP_PACKAGE
  ?? createRequire(import.meta.url).resolve("pi-acp/package.json");
const packageRoot = dirname(packageJson);
const packageMetadata = JSON.parse(await readFile(packageJson, "utf8"));
const packageSource = await readFile(join(packageRoot, "dist/index.js"), "utf8");
const helperSource = await readFile(join(packageRoot, "dist/paperclip-runtime.js"), "utf8");
const localHelper = await readFile(new URL("../src/drivers/acpx/pi-acp-runtime.ts", import.meta.url), "utf8");
const normalize = (source) => source.split("\n").map((line) => line.trimEnd()).join("\n");

test("Pi patch embeds the reviewed helper and pins exact upstream version", () => {
  assert.equal(packageMetadata.version, "0.0.33");
  assert.equal(normalize(helperSource), normalize(stripTypeScriptTypes(localHelper)));
  assert.match(packageSource, /createPiLaunchSpec\(params, process\.env\)/);
  assert.match(packageSource, /shell: false/);
  assert.match(packageSource, /snapshotPiWorkspaceFile\(this\.cwd, abs\)/);
});

async function fixture(t, extra = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-pi-acp-contract-")));
  await mkdir(join(root, "workspace")); await mkdir(join(root, "agent"));
  await writeFile(join(root, "extension.js"), "export default function() {}\n");
  const fakePi = fileURLToPath(new URL("../test-fixtures/pi-acp/fake-pi.mjs", import.meta.url));
  const child = spawn(process.execPath, [join(packageRoot, "dist/index.js")], {
    cwd: join(root, "workspace"), stdio: "pipe",
    env: {
      PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"),
      PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1", PAPERCLIP_PI_READ_ONLY: "0",
      PAPERCLIP_PI_NODE_EXECUTABLE: await realpath(process.execPath),
      PAPERCLIP_PI_ENTRYPOINT: fakePi, PAPERCLIP_PI_EXTENSION_PATH: join(root, "extension.js"),
      ...extra,
    },
  });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = new Map(); const notifications = []; const requests = [];
  let id = 0; let answer = async (request) => request.method === "session/request_permission"
    ? { outcome: { outcome: "selected", optionId: "allow_once" } }
    : { action: "accept", content: { answer: "Paperclip" } };
  const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
  const receive = (line) => {
    const message = JSON.parse(line);
    if (message.method && Object.hasOwn(message, "id")) {
      requests.push(message);
      void answer(message).then((result) => send({ jsonrpc: "2.0", id: message.id, result }));
    } else if (Object.hasOwn(message, "id")) {
      const waiter = pending.get(message.id); pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(JSON.stringify(message.error))); else waiter?.resolve(message.result);
    } else notifications.push(message);
  };
  const decoder = new StringDecoder("utf8"); let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += decoder.write(chunk);
    for (;;) { const at = buffered.indexOf("\n"); if (at < 0) break; const line = buffered.slice(0, at); buffered = buffered.slice(at + 1); if (line.trim()) receive(line); }
  });
  child.once("exit", () => { for (const waiter of pending.values()) waiter.reject(new Error(`wrapper exited: ${stderr}`)); pending.clear(); });
  const call = (method, params) => new Promise((resolve_, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`timeout: ${method}: ${stderr}`)); }, 5000);
    pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve_(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    send({ jsonrpc: "2.0", id: requestId, method, params });
  });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) { const timer = setTimeout(() => child.kill("SIGKILL"), 3000); await once(child, "exit"); clearTimeout(timer); }
    await rm(root, { recursive: true, force: true });
  });
  const initialized = await call("initialize", { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
  return { call, initialized, root, notifications, requests, setAnswer(value) { answer = value; } };
}

test("actual patched ACP process streams thinking and waits for settlement with usage", async (t) => {
  const f = await fixture(t);
  assert.equal(f.initialized.agentCapabilities._meta.paperclipPi.steering, true);
  const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  const result = await f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
  assert.equal(result.stopReason, "end_turn"); assert.equal(result.usage.inputTokens, 11); assert.equal(result.usage.totalTokens, 16);
  assert.ok(f.notifications.some((event) => event.params?.update?.sessionUpdate === "agent_thought_chunk"));
  assert.ok(f.notifications.some((event) => event.params?.update?.content?.text === "hello🌒\u2028world"));
});

test("actual patched ACP process keeps text questions separate from native permissions", async (t) => {
  const f = await fixture(t); const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  await f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "question" }] });
  assert.equal(f.requests.length, 1); assert.notEqual(f.requests[0].method, "session/request_permission");
  await f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "permission" }] });
  assert.equal(f.requests[1].method, "session/request_permission");
  assert.equal(f.requests[1].params.options[1].kind, "allow_always");
});

test("native steering is explicit and does not replace the active ACP turn", async (t) => {
  const f = await fixture(t); const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  const prompt = f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "long" }] });
  await f.call("pi/steer", { sessionId: session.sessionId, message: "focus" });
  await f.call("pi/follow_up", { sessionId: session.sessionId, message: "then finish" });
  assert.equal((await prompt).stopReason, "end_turn");
  await assert.rejects(f.call("pi/steer", { sessionId: session.sessionId, message: "too late" }), /active turn/);
});

test("provider exit fails promptly and missing owned extension fails admission", async (t) => {
  const f = await fixture(t); const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  await assert.rejects(f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "die" }] }), /exited/);
  const missing = await fixture(t, { PI_FIXTURE_EXTENSION_FAIL: "1" });
  await assert.rejects(missing.call("session/new", { cwd: join(missing.root, "workspace"), mcpServers: [] }), /failed admission/);
});

test("provider failure is typed and unadmitted slash commands cannot bypass controls", async (t) => {
  const f = await fixture(t); const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  const result = await f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "failure" }] });
  assert.equal(result._meta.jetbrains.air.sessionFailure.severity, "error");
  await assert.rejects(f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "/export /outside/report.html" }] }), /not admitted/);
});
