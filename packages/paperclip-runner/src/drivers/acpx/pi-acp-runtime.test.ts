import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiLaunchSpec, PiRpcFrames, PiTurnUsage, PiUiBridge } from "./pi-acp-runtime.js";

const temporary: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
function fixture() {
  const connection = { requestPermission: vi.fn(), unstable_createElicitation: vi.fn() };
  const process = { sendExtensionUiResponse: vi.fn().mockResolvedValue(undefined) };
  return { connection, process, bridge: new PiUiBridge("session-a", connection, process) };
}

describe("Pi ACP bridge", () => {
  it.each([
    ["select", { options: ["Red", "Blue"] }, "Blue", { value: "Blue" }],
    ["confirm", { message: "Proceed?" }, false, { confirmed: false }],
    ["input", { placeholder: "Name" }, "Ada", { value: "Ada" }],
    ["editor", { prefill: "Old\nText" }, "New\nText", { value: "New\nText" }],
  ])("round-trips %s as questions independently of permission auto-approval", async (method, extra, answer, expected) => {
    const f = fixture(); f.connection.unstable_createElicitation.mockResolvedValue({ action: "accept", content: { answer } });
    await f.bridge.handle({ id: "q1", method, title: "Choice", ...extra });
    expect(f.connection.requestPermission).not.toHaveBeenCalled();
    expect(f.connection.unstable_createElicitation).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-a", mode: "form", requestedSchema: expect.objectContaining({ required: ["answer"] }) }));
    expect(f.process.sendExtensionUiResponse).toHaveBeenCalledExactlyOnceWith({ id: "q1", ...expected });
  });

  it("sends only offered native permission choices and keeps questions separate", async () => {
    const f = fixture(); f.connection.requestPermission.mockResolvedValue({ outcome: { outcome: "selected", optionId: "allow_always" } });
    const event = { id: "p1", method: "select", title: 'paperclip.pi.permission.v1:{"toolCallId":"tool-a","toolName":"bash","input":{"command":"pwd"}}' };
    await f.bridge.handle(event);
    expect(f.connection.unstable_createElicitation).not.toHaveBeenCalled();
    expect(f.process.sendExtensionUiResponse).toHaveBeenCalledExactlyOnceWith({ id: "p1", value: "Allow for this session" });
    expect(f.connection.requestPermission.mock.calls[0]![0]).toMatchObject({ toolCall: { toolCallId: "tool-a", kind: "execute" }, options: [{ kind: "allow_once" }, { kind: "allow_always" }, { kind: "reject_once" }] });
    await f.bridge.handle(event); expect(f.connection.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("expires pending requests and discards a late answer exactly once", async () => {
    const f = fixture(); let answer!: (value: unknown) => void;
    f.connection.unstable_createElicitation.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const request = f.bridge.handle({ id: "q", method: "input", title: "Question" });
    f.bridge.cancelAll(); f.bridge.cancelAll();
    answer({ action: "accept", content: { answer: "stale" } }); await request;
    expect(f.process.sendExtensionUiResponse).toHaveBeenCalledExactlyOnceWith({ id: "q", cancelled: true });
  });

  it("honors Pi dialog deadlines and rejects invalid answers", async () => {
    vi.useFakeTimers(); const f = fixture(); let answer!: (value: unknown) => void;
    f.connection.unstable_createElicitation.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const request = f.bridge.handle({ id: "q", method: "select", title: "Question", options: ["A"], timeout: 100 });
    await vi.advanceTimersByTimeAsync(100);
    answer({ action: "accept", content: { answer: "A" } }); await request;
    expect(f.process.sendExtensionUiResponse).toHaveBeenCalledExactlyOnceWith({ id: "q", cancelled: true });
    f.connection.unstable_createElicitation.mockResolvedValue({ action: "accept", content: { answer: "other" } });
    await f.bridge.handle({ id: "q2", method: "select", title: "Question", options: ["A"] });
    expect(f.process.sendExtensionUiResponse).toHaveBeenLastCalledWith({ id: "q2", cancelled: true });
  });

  it("uses LF framing across UTF-8 chunks without splitting Unicode separators", () => {
    const seen: unknown[] = []; const frames = new PiRpcFrames((value) => seen.push(value));
    const bytes = Buffer.from(JSON.stringify({ text: "🌒\u2028\u2029" }) + "\r\n");
    for (const byte of bytes) frames.write(Uint8Array.of(byte)); frames.end();
    expect(seen).toEqual([{ text: "🌒\u2028\u2029" }]);
    expect(() => new PiRpcFrames(() => {}, 2).write(Buffer.from("xxx"))).toThrow("bound");
    const truncated = new PiRpcFrames(() => {}); truncated.write(Buffer.from('{"x":1}'));
    expect(() => truncated.end()).toThrow("inside");
  });

  it("reports actual incremental usage and resets the failure after a successful retry", () => {
    const usage = new PiTurnUsage(); const failed = { role: "assistant", timestamp: 1, stopReason: "error", usage: { input: 4, output: 1, cacheRead: 2, cacheWrite: 3, cost: { total: 0.01 } } };
    usage.accept(failed); usage.accept(failed);
    expect(usage.response()).toMatchObject({ usage: { totalTokens: 10 }, _meta: { jetbrains: { air: { sessionFailure: { severity: "error" } } } } });
    usage.accept({ ...failed, timestamp: 2, stopReason: "stop" });
    expect(usage.response()).toMatchObject({ usage: { inputTokens: 8, totalTokens: 20 } });
    usage.accept(failed); // A duplicate old failure cannot undo a successful retry.
    expect(usage.response()._meta).toBeUndefined();
    expect(usage.response()).toMatchObject({ usage: { _meta: { paperclipPi: { costUsd: 0.02, costSource: "pi_pricing_estimate" } } } });
    usage.reset(); expect(usage.response()).toEqual({});
  });

  it("does not invent missing cache totals or zero cost", () => {
    const usage = new PiTurnUsage();
    usage.accept({ role: "assistant", timestamp: 1, stopReason: "stop", usage: { input: 4, output: 2 } });
    expect(usage.response()).toEqual({ usage: {
      inputTokens: 4, outputTokens: 2, _meta: { paperclipPi: { provenance: "assistant_message_receipts" } },
    } });
    usage.accept({ role: "assistant", timestamp: 2, stopReason: "stop", usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } });
    expect(usage.response()).toEqual({ usage: {
      inputTokens: 8, outputTokens: 4, _meta: { paperclipPi: { provenance: "assistant_message_receipts" } },
    } });
  });

  it("accounts compaction receipts once and does not fabricate partial coverage", () => {
    const usage = new PiTurnUsage();
    usage.accept({ role: "assistant", timestamp: 1, stopReason: "error", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } });
    const compacted = { firstKeptEntryId: "entry-2", tokensBefore: 100, summary: "Context summary", usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, cost: { total: 0.02 } } };
    usage.acceptCompaction(compacted); usage.acceptCompaction(compacted);
    expect(usage.response()).toMatchObject({ usage: { inputTokens: 11, outputTokens: 6, totalTokens: 19, _meta: { paperclipPi: { provenance: "assistant_message_and_compaction_receipts", costUsd: 0.03 } } }, _meta: { jetbrains: { air: { sessionFailure: { severity: "error" } } } } });
    usage.acceptCompaction({ summary: "Missing usage" });
    expect(usage.response().usage).toEqual({ _meta: { paperclipPi: { provenance: "assistant_message_and_compaction_receipts" } } });
  });

  it("launches verified paths only and rejects session escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-pi-launch-")); temporary.push(root);
    await mkdir(join(root, "sessions"));
    for (const name of ["node", "cli.js", "extension.js"]) await writeFile(join(root, name), "verified");
    const environment = {
      PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1", PAPERCLIP_PI_READ_ONLY: "0",
      PAPERCLIP_PI_NODE_EXECUTABLE: join(root, "node"), PAPERCLIP_PI_ENTRYPOINT: join(root, "cli.js"), PAPERCLIP_PI_EXTENSION_PATH: join(root, "extension.js"),
      PI_CODING_AGENT_DIR: root,
    };
    const launch = createPiLaunchSpec({ cwd: root, mcpServers: [] }, environment);
    expect(launch.command).toBe(join(root, "node"));
    expect(launch.args).toEqual(expect.arrayContaining(["--no-extensions", "--no-approve", "--no-skills", "--offline"]));
    expect(() => createPiLaunchSpec({ cwd: root }, { ...environment, PAPERCLIP_PI_NODE_EXECUTABLE: "pi" })).toThrow("binding");
    await symlink(join(root, "cli.js"), join(root, "sessions", "escape.jsonl"));
    expect(() => createPiLaunchSpec({ cwd: root, sessionPath: join(root, "sessions", "escape.jsonl") }, environment)).toThrow("escaped");
  });
});
