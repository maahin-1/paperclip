import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import test from "node:test";

// This test runs real pinned Pi RPC without issuing a prompt or loading keys.
const packageRoot = process.env.PAPERCLIP_TEST_PI_RUNTIME_ROOT
  ?? dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const extensionSource = await readFile(new URL("../src/drivers/acpx/pi-runtime-extension.ts", import.meta.url), "utf8");

for (const brokenCatalog of [false, true]) {
  test(`real pinned Pi ${brokenCatalog ? "withholds" : "registers"} readiness after MCP initialization`, { timeout: 20_000 }, async (t) => {
    assert.equal(metadata.version, "0.84.2");
    const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-pi-native-contract-")));
    await mkdir(join(root, "workspace")); await mkdir(join(root, "agent"));
    const extension = join(root, "extension.mjs");
    await writeFile(extension, stripTypeScriptTypes(extensionSource));
    const calls = [];
    const server = createServer(async (request, response) => {
      assert.equal(request.headers.authorization, "Bearer 0123456789abcdef0123456789abcdef");
      let body = ""; for await (const chunk of request) body += chunk;
      const rpc = JSON.parse(body); calls.push(rpc.method);
      response.setHeader("Content-Type", "application/json");
      const result = rpc.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : { tools: [{ name: brokenCatalog ? "invalid/name" : "report_progress", description: "Report progress", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = server.address().port;
    const child = spawn(await realpath(process.execPath), [join(packageRoot, "dist/cli.js"), "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--offline", "-e", extension], {
      cwd: join(root, "workspace"), stdio: "pipe",
      env: {
        PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
        PAPERCLIP_PI_RUNTIME_CONFIGURATION: JSON.stringify({
          workspace: join(root, "workspace"), readOnly: true, readRoots: [], protectedRoots: [join(root, "agent")], instructions: "Use the assigned tools",
          servers: [{ type: "http", name: "paperclip", url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: "Authorization", value: "Bearer 0123456789abcdef0123456789abcdef" }] }],
        }),
      },
    });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
    t.after(async () => {
      child.stdin.end();
      if (child.exitCode === null) { const timer = setTimeout(() => child.kill("SIGKILL"), 2000); await once(child, "exit"); clearTimeout(timer); }
      server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const admission = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Pi RPC admission timed out: ${stderr}`)), 15_000);
      const decoder = new StringDecoder("utf8"); let buffered = "";
      child.stdout.on("data", (chunk) => {
        buffered += decoder.write(chunk);
        for (;;) {
          const at = buffered.indexOf("\n"); if (at < 0) break;
          const line = buffered.slice(0, at); buffered = buffered.slice(at + 1); if (!line.trim()) continue;
          const value = JSON.parse(line);
          if (value.type === "response" && value.id === "admission") { clearTimeout(timer); resolve(value); }
        }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Pi RPC exited before admission: ${stderr}`)); });
      child.stdin.write(JSON.stringify({ type: "get_commands", id: "admission" }) + "\n");
    });
    if (brokenCatalog) {
      await assert.rejects(admission, /Pi RPC exited before admission: Error: Failed to load extension/);
      assert.deepEqual(calls, ["initialize", "tools/list"]);
      return;
    }
    const result = await admission;
    assert.equal(result.success, true);
    assert.deepEqual(calls, ["initialize", "tools/list"]);
    const readiness = result.data.commands.find((command) => command.name === "paperclip-runtime-ready-v1");
    assert.equal(readiness?.description, "Paperclip runtime gate v1");
  });
}
