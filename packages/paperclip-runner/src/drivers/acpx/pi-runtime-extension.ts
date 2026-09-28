/**
 * The only extension admitted to the qualified Pi process. The launcher loads
 * this immutable module explicitly; project/global extension discovery is off.
 * Structural types keep this module independent of Pi's optional UI packages.
 */
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const PI_PERMISSION_TITLE_PREFIX = "paperclip.pi.permission.v1:";
export const PI_PERMISSION_OPTIONS = ["Allow once", "Allow for this session", "Deny"] as const;
const MAX_CONFIGURATION_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TOOLS = 512;

interface PiUi {
  select(title: string, options: string[]): Promise<string | undefined>;
}

export interface PiExtensionContext { cwd: string; ui: PiUi }
export interface PiToolEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: Array<Record<string, unknown>>; details?: unknown }>;
}

export interface PiExtensionApi {
  registerTool(tool: PiToolDefinition): void;
  registerCommand(name: string, command: { description: string; handler(): Promise<void> }): void;
  on(event: "tool_call", handler: (
    event: PiToolEvent, context: PiExtensionContext,
  ) => Promise<{ block: true; reason: string } | undefined>): void;
  on(event: "user_bash", handler: () => { result: { output: string; exitCode: number; cancelled: boolean; truncated: boolean } }): void;
  on(event: "project_trust", handler: () => { trusted: "no"; remember: false }): void;
  on(event: "before_agent_start", handler: (event: { systemPrompt: string }) => { systemPrompt: string } | undefined): void;
}

export interface PiMcpServer {
  type: "http";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export interface PiRuntimeConfiguration {
  servers: PiMcpServer[];
  workspace: string;
  readOnly: boolean;
  readRoots: string[];
  protectedRoots: string[];
  instructions: string;
}

/** This environment is synthesized by the verified wrapper, never the model. */
export function readPiRuntimeConfiguration(environment: NodeJS.ProcessEnv): PiRuntimeConfiguration {
  const raw = environment.PAPERCLIP_PI_RUNTIME_CONFIGURATION;
  if (!raw || Buffer.byteLength(raw) > MAX_CONFIGURATION_BYTES) throw new Error("Pi runtime configuration is missing or oversized");
  const value = asRecord(JSON.parse(raw));
  const workspace = absolutePath(value.workspace, "workspace");
  if (typeof value.readOnly !== "boolean") throw new Error("Pi read-only policy is missing");
  if (!Array.isArray(value.servers) || value.servers.length > 16) throw new Error("Pi MCP configuration is invalid");
  const names = new Set<string>();
  const servers = value.servers.map((entry): PiMcpServer => {
    const server = asRecord(entry);
    if (server.type !== "http" || typeof server.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(server.name) || names.has(server.name)) {
      throw new Error("Pi MCP server identity is invalid");
    }
    names.add(server.name);
    if (typeof server.url !== "string") throw new Error("Pi MCP endpoint is invalid");
    const url = new URL(server.url);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash) {
      throw new Error("Pi MCP endpoint must be a runner-owned loopback endpoint");
    }
    if (!Array.isArray(server.headers) || server.headers.length !== 1) throw new Error("Pi MCP authentication is invalid");
    const header = asRecord(server.headers[0]);
    if (header.name !== "Authorization" || typeof header.value !== "string" || !/^Bearer [A-Za-z0-9._~-]{16,4096}$/.test(header.value)) {
      throw new Error("Pi MCP authentication is invalid");
    }
    return { type: "http", name: server.name, url: url.href, headers: [{ name: "Authorization", value: header.value }] };
  });
  if (typeof value.instructions !== "string" || Buffer.byteLength(value.instructions) > 32 * 1024) throw new Error("Pi runtime instructions are invalid");
  return {
    servers, workspace, readOnly: value.readOnly,
    readRoots: pathList(value.readRoots, "read roots"),
    protectedRoots: pathList(value.protectedRoots, "protected roots"),
    instructions: value.instructions,
  };
}

function pathList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error(`Pi ${label} are invalid`);
  return value.map((path) => absolutePath(path, label));
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/.test(value) || value === "/") throw new Error(`Pi ${label} path is invalid`);
  return resolve(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi runtime record is invalid");
  return value as Record<string, unknown>;
}

function inside(root: string, target: string): boolean {
  const suffix = relative(root, target);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

/** Resolve every existing ancestor, including symlinks, before creating files. */
async function physicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return resolve(await physicalPath(dirname(path)), relative(dirname(path), path));
  }
}

export async function checkPiNativeTool(
  event: PiToolEvent, context: PiExtensionContext, config: PiRuntimeConfiguration,
): Promise<string | null> {
  if (await realpath(context.cwd) !== await realpath(config.workspace)) return "Pi workspace changed after admission";
  const readTools = new Set(["read", "grep", "find", "ls"]);
  const fileTools = new Set([...readTools, "edit", "write"]);
  if (!fileTools.has(event.toolName) && event.toolName !== "bash") return "Unregistered Pi tool is not admitted";
  if (config.readOnly && !readTools.has(event.toolName)) return "This execution permits reading only";
  // Shell syntax is not a filesystem authorization language. The host sandbox
  // remains authoritative for commands; every command still crosses ACP policy.
  if (event.toolName === "bash") return null;
  const pathValue = event.input.path ?? (readTools.has(event.toolName) ? "." : undefined);
  if (typeof pathValue !== "string" || /[\0\r\n]/.test(pathValue)) return "Pi tool path is invalid";
  const logical = resolve(config.workspace, pathValue);
  const target = await physicalPath(logical);
  if (!readTools.has(event.toolName)) {
    for (const root of config.readRoots) {
      if (inside(root, logical) || inside(await realpath(root), target)) return "Assigned Pi skills are read-only";
    }
  }
  for (const root of config.protectedRoots) {
    if (inside(root, logical) || inside(await physicalPath(root), target)) return "Pi tool targets protected runtime state";
  }
  const roots = readTools.has(event.toolName) ? [config.workspace, ...config.readRoots] : [config.workspace];
  for (const root of roots) {
    if (inside(root, logical) && inside(await realpath(root), target)) return null;
  }
  return "Pi tool path is outside its assigned workspace";
}

/** Bounded JSON MCP client for runner-owned HTTP bridges. No redirects or files. */
export async function piMcpRequest(
  server: PiMcpServer,
  method: string,
  params: Record<string, unknown>,
  id: string,
  signal?: AbortSignal,
  fetch_: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const request = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  if (Buffer.byteLength(request) > 1_048_576) throw new Error("Pi MCP request is oversized");
  const timeout = AbortSignal.timeout(method === "tools/call" ? 24 * 60 * 60 * 1000 : 30_000);
  const response = await fetch_(server.url, {
    method: "POST", redirect: "error",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...Object.fromEntries(server.headers.map((h) => [h.name, h.value])) },
    body: request, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok || !response.body) throw new Error(`Pi MCP ${method} failed (HTTP ${response.status})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error("Pi MCP response is oversized");
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const message = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (message.jsonrpc !== "2.0" || message.id !== id) throw new Error("Pi MCP response identity mismatch");
  if (message.error) throw new Error(`Pi MCP ${method} was rejected`);
  return asRecord(message.result);
}

export async function installPiRuntimeExtension(
  pi: PiExtensionApi,
  config: PiRuntimeConfiguration,
  request: typeof piMcpRequest = piMcpRequest,
): Promise<void> {
  // Registered names are held in this closure; provider-originated metadata
  // cannot promote a tool to the authenticated Paperclip bridge.
  const bridgeTools = new Set<string>();
  const permissionGrants = new Set<string>();
  // Assigned skills are a separate immutable lease. A config or executable
  // directory must never gain readability by being presented as a skill root.
  for (const root of config.readRoots) {
    const physicalRoot = await realpath(root);
    for (const protectedRoot of config.protectedRoots) {
      const physicalProtected = await physicalPath(protectedRoot);
      if (inside(protectedRoot, root) || inside(root, protectedRoot) || inside(physicalProtected, physicalRoot) || inside(physicalRoot, physicalProtected)) {
        throw new Error("Pi assigned skills overlap protected runtime state");
      }
    }
  }
  pi.on("project_trust", () => ({ trusted: "no", remember: false }));
  pi.on("user_bash", () => ({ result: { output: "Interactive shell commands are disabled in Paperclip Runner", exitCode: 1, cancelled: false, truncated: false } }));
  pi.on("before_agent_start", (event) => config.instructions
    ? { systemPrompt: `${event.systemPrompt}\n\n${config.instructions}` } : undefined);
  pi.on("tool_call", async (event, context) => {
    if (bridgeTools.has(event.toolName)) return;
    try {
      const denial = await checkPiNativeTool(event, context, config);
      if (denial) return { block: true, reason: denial };
      const detail = JSON.stringify({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input });
      if (Buffer.byteLength(detail) > 48 * 1024) return { block: true, reason: "Pi permission request is oversized" };
      // A session grant covers only the identical operation, never a whole
      // tool class or a subsequent path. Paths are still revalidated each time.
      const grantKey = JSON.stringify([event.toolName, event.input]);
      const selection = permissionGrants.has(grantKey) ? "Allow for this session"
        : await context.ui.select(`${PI_PERMISSION_TITLE_PREFIX}${detail}`, [...PI_PERMISSION_OPTIONS]);
      if (selection !== "Allow once" && selection !== "Allow for this session") return { block: true, reason: "Pi operation was denied or cancelled" };
      // Re-check file bindings after a human wait; approval never freezes paths.
      const changed = await checkPiNativeTool(event, context, config);
      if (!changed && selection === "Allow for this session" && permissionGrants.size < 4096) permissionGrants.add(grantKey);
      return changed ? { block: true, reason: changed } : undefined;
    } catch { return { block: true, reason: "Pi permission boundary is unavailable" }; }
  });
  let count = 0;
  for (const server of config.servers) {
    await request(server, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "paperclip-pi", version: "1" } }, `pi-init-${server.name}`);
    const catalog = await request(server, "tools/list", {}, `pi-tools-${server.name}`);
    if (!Array.isArray(catalog.tools) || catalog.nextCursor) throw new Error("Pi MCP catalog is incomplete");
    for (const rawTool of catalog.tools) {
      const tool = asRecord(rawTool);
      if (typeof tool.name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) throw new Error("Pi MCP tool name is invalid");
      const nativeName = `mcp__${server.name}__${tool.name}`;
      if (bridgeTools.has(nativeName) || ++count > MAX_TOOLS) throw new Error("Pi MCP catalog is ambiguous or oversized");
      const schema = asRecord(tool.inputSchema);
      if (schema.type !== "object") throw new Error("Pi MCP tool parameters must be an object");
      const sourceName = tool.name;
      const definition: PiToolDefinition = {
        name: nativeName, label: `${server.name}: ${sourceName}`,
        description: typeof tool.description === "string" ? tool.description : sourceName,
        parameters: structuredClone(schema),
        async execute(callId, arguments_, signal) {
          const result = await request(server, "tools/call", { name: sourceName, arguments: arguments_ }, callId, signal);
          if (result.isError === true) throw new Error("Paperclip tool request was rejected");
          if (!Array.isArray(result.content)) throw new Error("Pi MCP tool result is invalid");
          const content = result.content.map((item) => {
            const block = asRecord(item);
            if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
            if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") return { type: "image", data: block.data, mimeType: block.mimeType };
            // Resource links and structured outputs stay visible as data. They
            // never cause the extension to fetch a URL or open a returned path.
            return { type: "text", text: JSON.stringify(block) };
          });
          return { content, ...(result.structuredContent === undefined ? {} : { details: result.structuredContent }) };
        },
      };
      pi.registerTool(definition);
      bridgeTools.add(nativeName);
    }
  }
  // Pi reports extension-load failures and may continue. The wrapper requires
  // this exact sentinel before admitting prompts, so a failed extension cannot
  // silently leave native tools unguarded. Register only after every MCP binds.
  pi.registerCommand("paperclip-runtime-ready-v1", {
    description: "Paperclip runtime gate v1",
    async handler() {},
  });
}

export default async function paperclipPiExtension(pi: PiExtensionApi): Promise<void> {
  const configuration = readPiRuntimeConfiguration(process.env);
  // Do not let the model's shell tool inherit authenticated MCP credentials.
  delete process.env.PAPERCLIP_PI_RUNTIME_CONFIGURATION;
  await installPiRuntimeExtension(pi, configuration);
}
