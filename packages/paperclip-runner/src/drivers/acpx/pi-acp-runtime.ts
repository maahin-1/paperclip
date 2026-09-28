/** Source for the helper embedded in patches/pi-acp@0.0.33.patch. */
import { StringDecoder } from "node:string_decoder";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";

const PERMISSION_PREFIX = "paperclip.pi.permission.v1:";
const PERMISSION_CHOICES = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Allow for this session", kind: "allow_always" },
  { optionId: "reject_once", name: "Deny", kind: "reject_once" },
];
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Pi runtime record");
  return value as RecordValue;
}
function text(value: unknown, max = 16_384): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max) throw new Error("Invalid Pi runtime text");
  return value;
}

export const PI_ACP_FEATURES = Object.freeze({
  version: 1, steering: true, queuedFollowUp: true,
  questions: ["select", "confirm", "input", "editor"],
  nativePermissions: true, promptUsage: true, nativePlan: false,
  pendingRequestRecovery: "live-process-only",
});

/** Strict LF framing: Unicode line separators inside JSON are ordinary text. */
export class PiRpcFrames {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private readonly receive: (value: RecordValue) => void;
  private readonly limit: number;
  constructor(receive: (value: RecordValue) => void, limit = 4 * 1024 * 1024) { this.receive = receive; this.limit = limit; }
  write(chunk: Uint8Array): void {
    this.pending += this.decoder.write(Buffer.from(chunk));
    for (;;) {
      const index = this.pending.indexOf("\n");
      if (index < 0) break;
      const line = this.pending.slice(0, index).replace(/\r$/, "");
      this.pending = this.pending.slice(index + 1);
      if (Buffer.byteLength(line) > this.limit) throw new Error("Pi RPC frame exceeds its bound");
      if (line.trim()) this.receive(record(JSON.parse(line)));
    }
    if (Buffer.byteLength(this.pending) > this.limit) throw new Error("Pi RPC frame exceeds its bound");
  }
  end(): void {
    this.pending += this.decoder.end();
    if (this.pending.trim()) throw new Error("Pi RPC stream ended inside a frame");
  }
}

function requiredFile(environment: NodeJS.ProcessEnv, name: string): string {
  const path = environment[name];
  if (!path || !isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error(`Missing verified Pi launch binding: ${name}`);
  // This checks the handoff shape. The runner command lease verifies all bytes,
  // retains their directory identity, and owns the subprocess lifetime.
  if (!lstatSync(path).isFile()) throw new Error(`Invalid verified Pi launch binding: ${name}`);
  return path;
}
function pathArray(raw: string | undefined): string[] {
  const paths: unknown = JSON.parse(raw ?? "[]");
  if (!Array.isArray(paths) || paths.length > 128 || paths.some((p) => typeof p !== "string" || !isAbsolute(p) || /[\0\r\n]/.test(p))) throw new Error("Invalid Pi runtime paths");
  return paths;
}

/** Provider tool events are untrusted; diff projection cannot read host files. */
export function snapshotPiWorkspaceFile(cwd: string, path: string, environment: NodeJS.ProcessEnv = process.env): string {
  const root = realpathSync(cwd);
  const logical = resolve(root, path);
  const physical = realpathSync(logical);
  const within = (base: string, target: string): boolean => {
    const suffix = relative(base, target);
    return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
  };
  if (!within(root, logical) || !within(root, physical)) throw new Error("Pi diff escaped its workspace");
  for (const protectedPath of pathArray(environment.PAPERCLIP_PI_PROTECTED_ROOTS)) {
    if (within(protectedPath, logical)) throw new Error("Pi diff targets protected state");
    let protectedPhysical: string;
    try { protectedPhysical = realpathSync(protectedPath); } catch { continue; }
    if (within(protectedPhysical, physical)) throw new Error("Pi diff targets protected state");
  }
  const fd = openSync(physical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 4n * 1024n * 1024n) throw new Error("Pi diff file is unsupported");
    const result = readFileSync(fd, "utf8");
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(physical, { bigint: true });
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.ctimeNs !== after.ctimeNs || named.ino !== before.ino || named.dev !== before.dev || realpathSync(logical) !== physical) throw new Error("Pi diff file changed during capture");
    return result;
  } finally { closeSync(fd); }
}

export function createPiLaunchSpec(
  params: { cwd: string; mcpServers?: unknown[]; sessionPath?: string },
  environment: NodeJS.ProcessEnv,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (environment.PAPERCLIP_ACPX_ISOLATED_CONTEXT !== "1") throw new Error("Pi requires an isolated runner launch");
  const command = requiredFile(environment, "PAPERCLIP_PI_NODE_EXECUTABLE");
  const entrypoint = requiredFile(environment, "PAPERCLIP_PI_ENTRYPOINT");
  const extension = requiredFile(environment, "PAPERCLIP_PI_EXTENSION_PATH");
  if (environment.PAPERCLIP_PI_READ_ONLY !== "0" && environment.PAPERCLIP_PI_READ_ONLY !== "1") throw new Error("Pi requires an explicit read-only policy");
  const readRoots = pathArray(environment.PAPERCLIP_PI_READ_ROOTS);
  const protectedRoots = pathArray(environment.PAPERCLIP_PI_PROTECTED_ROOTS);
  const workspace = realpathSync(params.cwd);
  const configuration = JSON.stringify({
    workspace, servers: params.mcpServers ?? [],
    readOnly: environment.PAPERCLIP_PI_READ_ONLY === "1",
    readRoots, protectedRoots,
    instructions: environment.PAPERCLIP_PI_SYSTEM_INSTRUCTIONS ?? "",
  });
  if (Buffer.byteLength(configuration) > 64 * 1024) throw new Error("Pi launch configuration exceeds its bound");
  const args = [entrypoint, "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--offline", "-e", extension];
  for (const root of readRoots) args.push("--skill", root);
  if (params.sessionPath) {
    const home = environment.PI_CODING_AGENT_DIR;
    if (!home) throw new Error("Pi session home is missing");
    const sessionRoot = realpathSync(resolve(home, "sessions"));
    const sessionPath = realpathSync(params.sessionPath);
    const suffix = relative(sessionRoot, sessionPath);
    if (!suffix || isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`) || !lstatSync(params.sessionPath).isFile()) throw new Error("Pi session escaped its private home");
    args.push("--session", sessionPath);
  }
  return { command, args, env: { ...environment, PAPERCLIP_PI_RUNTIME_CONFIGURATION: configuration } };
}

interface UiConnection {
  requestPermission(params: RecordValue): Promise<unknown>;
  unstable_createElicitation(params: RecordValue): Promise<unknown>;
}
interface UiProcess { sendExtensionUiResponse(response: RecordValue): Promise<unknown> }

/** Live promises never become authority to replay an answer after provider death. */
export class PiUiBridge {
  private readonly pending = new Map<string, { cancel(): void }>();
  private readonly seen = new Set<string>();
  private readonly sessionId: string;
  private readonly connection: UiConnection;
  private readonly process: UiProcess;
  constructor(sessionId: string, connection: UiConnection, process: UiProcess) { this.sessionId = sessionId; this.connection = connection; this.process = process; }

  cancelAll(): void { for (const value of this.pending.values()) value.cancel(); }

  async handle(event: RecordValue): Promise<void> {
    const id = text(event.id, 256);
    const method = text(event.method, 64);
    if (!["select", "confirm", "input", "editor"].includes(method)) return;
    if (this.seen.has(id)) return;
    if (this.seen.size >= 4096) throw new Error("Pi UI request history exceeds its bound");
    this.seen.add(id);
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = async (response: RecordValue): Promise<void> => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      this.pending.delete(id);
      await this.process.sendExtensionUiResponse({ id, ...response });
    };
    this.pending.set(id, { cancel: () => { void finish({ cancelled: true }).catch(() => {}); } });
    if (typeof event.timeout === "number" && Number.isFinite(event.timeout)) {
      timeout = setTimeout(() => { void finish({ cancelled: true }).catch(() => {}); }, Math.max(0, Math.min(event.timeout, 2_147_483_647)));
      timeout.unref?.();
    }
    try {
      const title = text(event.title ?? "Additional information needed", 65_536);
      if (method === "select" && title.startsWith(PERMISSION_PREFIX)) {
        const permission = record(JSON.parse(title.slice(PERMISSION_PREFIX.length)));
        const toolCallId = text(permission.toolCallId, 256);
        const toolName = text(permission.toolName, 128);
        const input = record(permission.input);
        const result = record(await this.connection.requestPermission({
          sessionId: this.sessionId,
          toolCall: { toolCallId, title: `Pi ${toolName}`, kind: toolName === "bash" ? "execute" : ["write", "edit"].includes(toolName) ? "edit" : "read", status: "pending", rawInput: input },
          options: PERMISSION_CHOICES,
        }));
        const outcome = record(result.outcome);
        const selected = outcome.outcome === "selected" ? PERMISSION_CHOICES.find((option) => option.optionId === outcome.optionId) : undefined;
        await finish(selected ? { value: selected.name } : { cancelled: true });
        return;
      }
      const property: RecordValue = { type: method === "confirm" ? "boolean" : "string", title };
      if (method === "select") {
        if (!Array.isArray(event.options) || event.options.length < 1 || event.options.length > 128) throw new Error("Invalid Pi question options");
        property.enum = event.options.map((option) => text(option, 4096));
        if (new Set(property.enum as string[]).size !== event.options.length) throw new Error("Ambiguous Pi question options");
      }
      if (method === "input" && typeof event.placeholder === "string") property.description = text(event.placeholder);
      if (method === "editor" && typeof event.prefill === "string") property.default = text(event.prefill);
      const result = record(await this.connection.unstable_createElicitation({
        sessionId: this.sessionId, mode: "form", message: typeof event.message === "string" ? text(event.message) : title,
        requestedSchema: { type: "object", title, properties: { answer: property }, required: ["answer"] },
        _meta: { paperclipPi: { version: 1, requestId: id, method } },
      }));
      if (result.action !== "accept") { await finish({ cancelled: true }); return; }
      const answer = record(result.content).answer;
      if (method === "confirm") {
        if (typeof answer !== "boolean") throw new Error("Invalid Pi confirmation response");
        await finish({ confirmed: answer });
      } else {
        const value = text(answer, 65_536);
        if (method === "select" && !(property.enum as string[]).includes(value)) throw new Error("Invalid Pi question response");
        await finish({ value });
      }
    } catch { await finish({ cancelled: true }).catch(() => {}); }
  }
}

/** Sum actual assistant receipts, never context occupancy or estimated cost. */
export class PiTurnUsage {
  private seen = new Set<string>();
  private total = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 0 };
  private cost = 0;
  private unknown = new Set<keyof typeof this.total>();
  private costObserved = false;
  private costIncomplete = false;
  private failed = false;
  private observed = false;
  reset(): void { this.seen.clear(); this.total = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 0 }; this.cost = 0; this.unknown.clear(); this.costObserved = false; this.costIncomplete = false; this.failed = false; this.observed = false; }
  accept(value: unknown): void {
    const message = record(value);
    if (message.role !== "assistant") return;
    if (!message.usage || typeof message.usage !== "object") {
      this.failed = message.stopReason === "error";
      return;
    }
    const key = JSON.stringify([message.timestamp, message.id, message.usage, message.content]);
    if (this.seen.has(key)) return;
    if (this.seen.size >= 8192) throw new Error("Pi usage receipts exceed their bound");
    this.seen.add(key);
    this.failed = message.stopReason === "error";
    const usage = record(message.usage);
    const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    const fields = ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens"] as const;
    const numbers = ["input", "output", "cacheRead", "cacheWrite"].map((name) => usage[name]);
    for (const [index, name] of fields.entries()) {
      const value = numbers[index];
      if (valid(value)) { this.total[name] += value; this.observed = true; }
      else this.unknown.add(name);
    }
    const total = valid(usage.totalTokens) ? usage.totalTokens
      : numbers.every(valid) ? (numbers as number[]).reduce((sum, value) => sum + value, 0) : undefined;
    if (valid(total)) this.total.totalTokens += total;
    else this.unknown.add("totalTokens");
    const cost = usage.cost && typeof usage.cost === "object" ? record(usage.cost).total : undefined;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
      this.cost += cost; this.costObserved = true;
    } else this.costIncomplete = true;
  }

  response(): RecordValue {
    return {
      ...(this.observed ? { usage: { ...Object.fromEntries(Object.entries(this.total).filter(([name]) => !this.unknown.has(name as keyof typeof this.total))), _meta: { paperclipPi: { provenance: "assistant_message_receipts", ...(this.costObserved && !this.costIncomplete ? { costUsd: this.cost, costSource: "pi_pricing_estimate" } : {}) } } } } : {}),
      ...(this.failed ? { _meta: { jetbrains: { air: { version: 1, sessionFailure: { severity: "error", category: "service", title: "Pi provider request failed" } } } } } : {}),
    };
  }
}
