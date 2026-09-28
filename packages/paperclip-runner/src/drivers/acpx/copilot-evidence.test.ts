import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COPILOT_ACP_EVENT_TYPES } from "./copilot-events.js";

function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url), "utf8"));
}

describe("Copilot pinned executable evidence", () => {
  it("retains a complete packaged native launch without promoting offline proof to qualification", () => {
    const evidence = fixture("copilot-provider-pack-darwin-arm64-1.0.88.json");
    expect(evidence.sourceRevision).toMatch(/^[a-f0-9]{40}$/);
    expect(evidence.providerPackDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(evidence.candidate).toMatchObject({ version: "1.0.88", qualification: "pending" });
    expect(evidence.initialize).toMatchObject({ protocolVersion: 1, agentInfo: { version: "1.0.88" } });
    expect(evidence).toMatchObject({ initializeRequestId: 0, cleanExit: true, inheritedCredentials: false,
      promptSent: false, fixtureRequests: [], costUsd: 0, missingCredentialPreflight: "COPILOT_AUTH_REQUIRED" });
    expect(JSON.stringify(evidence)).not.toMatch(/\/Users\/|\/private\/var\/|\/tmp\/paperclip-/);
  });
  it("accounts for every inventoried event and field without pretending all were observed", () => {
    const inventory = fixture("copilot-event-inventory-1.0.88.json");
    expect(inventory.events).toHaveLength(150);
    const subscribed = inventory.events.filter((event: { paperclipDisposition: string }) => event.paperclipDisposition === "subscribed_and_projected").map((event: { event: string }) => event.event);
    expect(subscribed.sort()).toEqual([...COPILOT_ACP_EVENT_TYPES].sort());
    for (const event of inventory.events) {
      expect(Object.keys(event.fieldCoverage).sort()).toEqual(event.fields);
      expect(event.gapReason).toBeTruthy();
      expect(event.followUpPriority).toBeTruthy();
    }
  });

  it("retains a real numeric-zero permission denial with no filesystem side effect", () => {
    const evidence = fixture("copilot-acp-denial-1.0.88.json");
    expect(evidence.costUsd).toBe(0);
    expect(evidence.executableSha256).toBe("a9ff8babb10b7e443182ae96a8bc50a9c826ef1c773e1344c396eb5bf7f512c3");
    expect(evidence.permissionResponses).toEqual([{ id: 0, outcome: { outcome: "selected", optionId: "reject_once" } }]);
    expect(evidence.filesystemMarkerExistedAfterPrompt).toBe(false);
    expect(evidence.filesystemMarkerExistedAtPromptResult).toBe(false);
    const permission = evidence.wire.find((message: { method?: string }) => message.method === "session/request_permission");
    expect(permission.id).toBe(0);
    expect(permission.params.options.map((option: { kind: string }) => option.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
    expect(evidence.modelToolNames).not.toContain("ask_user");
    expect(evidence.modelToolNames).not.toContain("exit_plan_mode");
  });

  it("retains attached background command completion before ACP turn settlement", () => {
    const evidence = fixture("copilot-acp-settlement-1.0.88.json");
    expect(evidence.costUsd).toBe(0);
    expect(evidence.filesystemMarkerExistedAfterPrompt).toBe(true);
    expect(evidence.filesystemMarkerExistedAtPromptResult).toBe(true);
    const end = evidence.wire.findIndex((message: { result?: { stopReason?: string } }) => message.result?.stopReason === "end_turn");
    const idle = evidence.wire.findIndex((message: { method?: string; params?: { type?: string } }) => message.method === "github.com/copilot/sessionEvent" && message.params?.type === "session.idle");
    expect(idle).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(idle);
    const transcript = JSON.stringify(evidence.wire.slice(0, end));
    expect(transcript).toContain("Reading shell output");
    expect(transcript).toContain("completed with exit code 0");
    expect(transcript).toContain("ACP_SHELL_DONE");
    expect(evidence.modelSource).toContain("not a live model qualification");
  });
});
