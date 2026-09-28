import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { COPILOT_ACP_EVENT_METHOD } from "./copilot-events.js";
import { createCopilotProfileExtensionAdapter } from "./copilot-extension-adapter.js";
import { validateAcpxRichEvent } from "./profile-extensions.js";

const context = { workspacePath: "/workspace", sessionId: "session-1", turnId: "turn-1" };
const params = (type: string, data: unknown, extra = {}) => ({ sessionId: context.sessionId, type, data, ...extra });

describe("Copilot display extension adapter", () => {
  it("preserves subagent lifecycle identity and all safe details with canonical provenance", async () => {
    const adapter = createCopilotProfileExtensionAdapter(context);
    const started = await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("subagent.started", { agentName: "review", agentDisplayName: "Reviewer", toolCallId: "tool-1", agentDescription: "Review the change", model: "exact-model", resumable: true }, { agentId: "agent-2" }));
    const completed = await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("subagent.completed", { agentName: "review", toolCallId: "tool-1", model: "exact-model", totalToolCalls: 3, durationMs: 12.5, totalTokens: 40, modelSelectionSource: "agent" }, { agentId: "agent-2", timestamp: "2026-09-28T00:00:00Z" }));
    [...started, ...completed].forEach(validateAcpxRichEvent);
    expect(started[0].eventType).toBe("delegation.started");
    expect(completed[0].eventType).toBe("delegation.completed");
    expect(started[0].itemId).toBe(completed[0].itemId);
    expect(completed[1].payload).toMatchObject({
      provenance: { method: COPILOT_ACP_EVENT_METHOD, eventType: "subagent.completed", agentId: "agent-2", sessionId: "session-1", turnId: "turn-1", timestamp: "2026-09-28T00:00:00Z" },
      details: expect.arrayContaining([{ name: "totalTokens", value: "40" }, { name: "durationMs", value: "12.5" }, { name: "modelSelectionSource", value: "agent" }]),
    });
  });

  it("does not register provider-session paths or binary assets as task artifacts", async () => {
    const adapter = createCopilotProfileExtensionAdapter(context);
    const file = await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("session.workspace_file_changed", { operation: "create", path: "reports/result.md" }));
    file.forEach(validateAcpxRichEvent);
    expect(file[0].payload).toMatchObject({ registered: false, reference: null });
    expect(file[1].payload.details).toEqual(expect.arrayContaining([{ name: "path", value: "reports/result.md" }, { name: "locationKind", value: "provider_session_workspace" }]));
    expect(await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("session.workspace_file_changed", { operation: "create", path: "../../secret" }))).toEqual([]);
    const bytes = Buffer.from("image fixture");
    const asset = await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("session.binary_asset", { assetId: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, type: "image", mimeType: "image/png", byteLength: bytes.length, data: bytes.toString("base64") }));
    asset.forEach(validateAcpxRichEvent);
    expect(asset[0].payload).toMatchObject({ mediaType: "image/png", reference: null, registered: false });
    expect(JSON.stringify(asset)).not.toContain(bytes.toString("base64"));
  });

  it("keeps supplemental non-dollar usage separate from authoritative terminal accounting", async () => {
    const events = await createCopilotProfileExtensionAdapter(context).notification(COPILOT_ACP_EVENT_METHOD, params("assistant.usage", { model: "m", inputTokens: 10, outputTokens: 2, cost: 3, copilotUsage: { totalNanoAiu: 50 }, quotaSnapshots: { private: "secret" } }));
    events.forEach(validateAcpxRichEvent);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("provider.notice.recorded");
    expect(events[0].payload.details).toEqual(expect.arrayContaining([{ name: "modelMultiplier", value: "3" }, { name: "totalNanoAiu", value: "50" }, { name: "inputTokens", value: "10" }, { name: "accounting", value: "supplemental_provider_notice" }]));
    expect(JSON.stringify(events)).not.toMatch(/costUsd|quotaSnapshots|secret/);
  });

  it("redacts credentials in provider strings while preserving numeric token counters", async () => {
    const events = await createCopilotProfileExtensionAdapter(context).notification(COPILOT_ACP_EVENT_METHOD, params("subagent.failed", { agentName: "review", totalTokens: 42, error: "Authorization: Bearer secretsecretsecret", model: "ghp_abcdefghijklmnopqrstuvwxyz" }));
    events.forEach(validateAcpxRichEvent);
    expect(JSON.stringify(events)).not.toMatch(/secretsecretsecret|ghp_abcdefghijklmnopqrstuvwxyz/);
    expect(events[1].payload.details).toContainEqual({ name: "totalTokens", value: "42" });
  });

  it("reports native unsupported input honestly and ignores unrelated or cross-session notifications", async () => {
    const adapter = createCopilotProfileExtensionAdapter(context);
    await expect(adapter.request("user_input.requested", {})).rejects.toThrow("no qualified");
    const events = await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("user_input.requested", { requestId: "q-1", question: "Do not fabricate an input form" }));
    events.forEach(validateAcpxRichEvent);
    expect(events[0].payload).toMatchObject({ severity: "warning", userActionable: false });
    expect(JSON.stringify(events)).not.toContain("Do not fabricate");
    expect(await adapter.notification("unrelated/event", {})).toEqual([]);
    expect(await adapter.notification(COPILOT_ACP_EVENT_METHOD, { ...params("session.idle", {}), sessionId: "another" })).toEqual([]);
  });

  it("emits compaction completion only after provider-reported success and keeps settlement notices nonterminal", async () => {
    const adapter = createCopilotProfileExtensionAdapter(context);
    const success = await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("session.compaction_complete", { success: true, preCompactionTokens: 100, postCompactionTokens: 40, checkpointNumber: 1 }));
    success.forEach(validateAcpxRichEvent);
    expect(success[0]).toMatchObject({ eventType: "context.compacted", payload: { preTokens: 100, postTokens: 40, sameSession: true } });
    const failure = await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("session.compaction_complete", { success: false }));
    expect(failure.map(event => event.eventType)).toEqual(["provider.notice.recorded"]);
    const idle = await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("session.idle", {}));
    expect(idle.map(event => event.eventType)).toEqual(["provider.notice.recorded"]);
    expect(idle[0].payload.details).toContainEqual({ name: "authoritativeTurnCompletion", value: "false" });
  });
});
