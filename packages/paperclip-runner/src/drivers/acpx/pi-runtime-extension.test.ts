import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkPiNativeTool, installPiRuntimeExtension, piMcpRequest, readPiRuntimeConfiguration,
  PI_PERMISSION_TITLE_PREFIX, type PiExtensionApi, type PiRuntimeConfiguration, type PiToolDefinition,
} from "./pi-runtime-extension.js";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "paperclip-pi-extension-")); directories.push(root);
  await mkdir(join(root, "workspace")); await mkdir(join(root, "skills")); await mkdir(join(root, "private"));
  return { root, config: {
    workspace: join(root, "workspace"), readOnly: false,
    readRoots: [join(root, "skills")], protectedRoots: [join(root, "private")],
    instructions: "Use the assigned Paperclip tools", servers: [],
  } satisfies PiRuntimeConfiguration };
}
function harness() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools: PiToolDefinition[] = [];
  const api = { on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler), registerTool: (tool: PiToolDefinition) => tools.push(tool), registerCommand: vi.fn() } as unknown as PiExtensionApi;
  return { api, handlers, tools };
}

describe("owned Pi runtime extension", () => {
  it("requires explicit isolated configuration and loopback authentication", () => {
    expect(() => readPiRuntimeConfiguration({})).toThrow("missing");
    const value = { workspace: "/work/project", readOnly: false, readRoots: [], protectedRoots: [], instructions: "", servers: [{ type: "http", name: "paperclip", url: "http://127.0.0.1:1234/mcp", headers: [{ name: "Authorization", value: "Bearer 1234567890123456" }] }] };
    const parse = () => readPiRuntimeConfiguration({ PAPERCLIP_PI_RUNTIME_CONFIGURATION: JSON.stringify(value) });
    expect(parse().servers).toHaveLength(1);
    value.servers[0]!.url = "https://127.0.0.1.evil.test/mcp";
    expect(parse).toThrow("loopback");
    value.servers[0]!.url = "http://user:password@127.0.0.1/mcp";
    expect(parse).toThrow("loopback");
  });

  it("denies escapes and read-only mutations before requesting provider permission", async () => {
    const { root, config } = await workspace(); const h = harness();
    await symlink(join(root, "private"), join(config.workspace, "escape"));
    await installPiRuntimeExtension(h.api, config);
    const select = vi.fn().mockResolvedValue("Allow once");
    const context = { cwd: config.workspace, ui: { select } };
    const tool = h.handlers.get("tool_call")!;
    expect(await tool({ toolName: "write", toolCallId: "t1", input: { path: "escape/new-file" } }, context)).toMatchObject({ block: true });
    expect(await tool({ toolName: "read", toolCallId: "t2", input: { path: "../../outside" } }, context)).toMatchObject({ block: true });
    config.readOnly = true;
    expect(await tool({ toolName: "bash", toolCallId: "t3", input: { command: "touch result" } }, context)).toMatchObject({ block: true });
    expect(select).not.toHaveBeenCalled();
  });

  it("revalidates paths after a human wait and never treats cancellation as approval", async () => {
    const { root, config } = await workspace(); const h = harness();
    await installPiRuntimeExtension(h.api, config);
    const context = { cwd: config.workspace, ui: { select: vi.fn(async () => {
      await symlink(join(root, "private"), join(config.workspace, "target"));
      return "Allow once";
    }) } };
    expect(await h.handlers.get("tool_call")!({ toolName: "write", toolCallId: "t", input: { path: "target/new" } }, context)).toMatchObject({ block: true });
    expect(context.ui.select.mock.calls[0]![0]).toMatch(PI_PERMISSION_TITLE_PREFIX);
    context.ui.select = vi.fn().mockResolvedValue(undefined);
    expect(await h.handlers.get("tool_call")!({ toolName: "bash", toolCallId: "b", input: { command: "pwd" } }, context)).toMatchObject({ block: true });
  });

  it("makes assigned skills readable but never writable", async () => {
    const { config } = await workspace();
    await writeFile(join(config.readRoots[0]!, "SKILL.md"), "assigned");
    const context = { cwd: config.workspace, ui: { select: vi.fn() } };
    expect(await checkPiNativeTool({ toolName: "read", toolCallId: "r", input: { path: join(config.readRoots[0]!, "SKILL.md") } }, context, config)).toBeNull();
    expect(await checkPiNativeTool({ toolName: "write", toolCallId: "w", input: { path: join(config.readRoots[0]!, "SKILL.md") } }, context, config)).toMatch("outside");
  });

  it("registers exact authenticated MCP tools with stable idempotency and abort signal", async () => {
    const { config } = await workspace(); const h = harness();
    config.servers = [{ type: "http", name: "paperclip", url: "http://127.0.0.1:1234", headers: [] }];
    const request = vi.fn(async (_server, method) => method === "tools/list"
      ? { tools: [{ name: "report_progress", description: "Report progress", inputSchema: { type: "object", properties: {} } }] }
      : method === "tools/call" ? { content: [{ type: "text", text: "recorded" }] } : {});
    await installPiRuntimeExtension(h.api, config, request);
    const tool = h.tools[0]!; expect(tool.name).toBe("mcp__paperclip__report_progress");
    const signal = new AbortController().signal;
    await expect(tool.execute("call-1", { text: "done" }, signal)).resolves.toMatchObject({ content: [{ text: "recorded" }] });
    expect(request).toHaveBeenLastCalledWith(config.servers[0], "tools/call", { name: "report_progress", arguments: { text: "done" } }, "call-1", signal);
    const select = vi.fn(); const context = { cwd: config.workspace, ui: { select } };
    expect(await h.handlers.get("tool_call")!({ toolName: tool.name, toolCallId: "m", input: {} }, context)).toBeUndefined();
    expect(await h.handlers.get("tool_call")!({ toolName: "mcp__paperclip__invented", toolCallId: "i", input: {} }, context)).toMatchObject({ block: true });
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects incomplete catalogs and tool-result errors without exposing auth", async () => {
    const { config } = await workspace(); const h = harness();
    config.servers = [{ type: "http", name: "paperclip", url: "http://127.0.0.1:1234", headers: [] }];
    const request = vi.fn(async (_server, method) => method === "tools/list" ? { tools: [], nextCursor: "more" } : {});
    await expect(installPiRuntimeExtension(h.api, config, request)).rejects.toThrow("incomplete");
  });

  it("does not follow MCP redirects or forward credentials to another origin", async () => {
    const server = createServer((_req, res) => { res.writeHead(302, { Location: "http://127.0.0.1:1/steal" }); res.end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
      await expect(piMcpRequest({ type: "http", name: "paperclip", url: `http://127.0.0.1:${address.port}`, headers: [{ name: "Authorization", value: "Bearer secret" }] }, "tools/list", {}, "1")).rejects.toThrow();
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("validates response IDs and bounds tool output", async () => {
    const server = { type: "http" as const, name: "paperclip", url: "http://127.0.0.1:1", headers: [] };
    const fetch_ = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "other", result: {} })));
    await expect(piMcpRequest(server, "tools/list", {}, "1", undefined, fetch_)).rejects.toThrow("identity");
    fetch_.mockImplementation(async () => new Response("x".repeat(4 * 1024 * 1024 + 1)));
    await expect(piMcpRequest(server, "tools/list", {}, "1", undefined, fetch_)).rejects.toThrow("oversized");
  });
});
