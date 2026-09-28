import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PAPERCLIP_QUESTION_RESPONSE_SCHEMA } from "../../contracts/question-set.js";
import {
  createCursorNotificationNormalizer, createCursorProfileExtensionAdapter, createCursorSubagentNormalizer, cursorWorkspaceArtifactReference,
  normalizeCursorPlanRequest, normalizeCursorQuestionRequest, normalizeCursorSubagentUpdate,
} from "./cursor-extensions.js";

const response = (answers: Record<string, unknown>) => ({ schema: PAPERCLIP_QUESTION_RESPONSE_SCHEMA, answers });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function workspace() { const root = await mkdtemp(join(tmpdir(), "cursor-extension-")); roots.push(root); return root; }

describe("Cursor blocking extension normalization", () => {
  const question = { toolCallId: "call-1", title: "Choose scope", questions: [
    { id: "__proto__", prompt: "Which?", options: [{ id: "constructor", label: "A" }, { id: "second", label: "B" }] },
    { id: "many", prompt: "Select all", allowMultiple: true, options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] },
  ] };
  it("preserves native question/option identity and multi-select without exposing unsafe keys", () => {
    const normalized = normalizeCursorQuestionRequest(question);
    expect(normalized.accept(response({ "question-1": { selectedOptionIds: ["option-1"] }, "question-2": { selectedOptionIds: ["option-2", "option-1"] } }))).toEqual({ outcome: { outcome: "answered", answers: [
      { questionId: "__proto__", selectedOptionIds: ["constructor"] }, { questionId: "many", selectedOptionIds: ["y", "x"] },
    ] } });
    expect(normalized.cancel()).toEqual({ outcome: { outcome: "cancelled" } });
    expect(normalized.skip("not applicable")).toEqual({ outcome: { outcome: "skipped", reason: "not applicable" } });
  });
  it("rejects incomplete, forged, duplicate and multi-selected single answers", () => {
    const normalized = normalizeCursorQuestionRequest(question);
    expect(() => normalized.accept(response({}))).toThrow();
    for (const selectedOptionIds of [["forged"], ["option-1", "option-2"], ["option-1", "option-1"]]) {
      expect(() => normalized.accept(response({ "question-1": { selectedOptionIds }, "question-2": { selectedOptionIds: ["option-1"] } }))).toThrow();
    }
    expect(() => normalizeCursorQuestionRequest({ ...question, questions: [question.questions[0], question.questions[0]] })).toThrow("Duplicate");
    expect(() => normalizeCursorQuestionRequest({ ...question, questions: [{ ...question.questions[0], allowMultiple: "false" }] })).toThrow("boolean");
  });
  it("binds decisions to the full plan revision including phases and todos", () => {
    const native = { toolCallId: "plan-1", name: "Migrate", overview: "Two steps", plan: "# Plan\n\nRead, then migrate.", todos: [{ id: "1", content: "Read", status: "pending" }], phases: [{ name: "Delivery", todos: [{ id: "2", content: "Migrate", status: "pending" }] }], isProject: true };
    const first = normalizeCursorPlanRequest(native);
    const next = normalizeCursorPlanRequest({ ...native, plan: "# Plan\n\nDelete production data." });
    expect(first.questionSet.description).toContain(native.plan);
    expect(first.questionSet.description).toContain("Phase: Delivery");
    expect(first.questionSet.description).toContain("[pending] Migrate");
    expect(first.revision).not.toBe(next.revision);
    const accept = response({ [first.questionSet.questions[0]!.id]: { selectedOptionIds: ["accept"] } });
    expect(first.resolve(accept)).toEqual({ outcome: { outcome: "accepted" } });
    expect(() => next.resolve(accept)).toThrow();
    expect(first.resolve(response({ [first.questionSet.questions[0]!.id]: { selectedOptionIds: ["reject"] }, reason: { text: "Too broad" } }))).toEqual({ outcome: { outcome: "rejected", reason: "Too broad" } });
    expect(first.resolve(response({ [first.questionSet.questions[0]!.id]: { selectedOptionIds: ["cancel"] } }))).toEqual(first.cancel());
  });
  it("never truncates or fabricates approval of an oversized plan", () => {
    expect(() => normalizeCursorPlanRequest({ toolCallId: "plan", plan: "x".repeat(100_001), todos: [] })).toThrow();
    expect(() => normalizeCursorPlanRequest({ toolCallId: "plan", plan: "x", todos: [{ id: "1", content: "x", status: "mystery" }] })).toThrow();
    const full = "Details\n".repeat(1_000);
    expect(normalizeCursorPlanRequest({ toolCallId: "plan", plan: full, todos: [] }).questionSet.description).toBe(full);
    expect(() => normalizeCursorPlanRequest({ toolCallId: "plan", plan: "漢".repeat(90_000), todos: [] })).toThrow("byte bound");
  });
});

describe("Cursor rich notifications", () => {
  it("merges todos into complete snapshots with increasing revisions and visible cancellation", async () => {
    const normalize = createCursorNotificationNormalizer({ workspacePath: await workspace(), turnId: "turn-1" });
    const first = await normalize("cursor/update_todos", { toolCallId: "a", merge: false, todos: [{ id: "a", content: "Build", status: "pending" }] });
    const second = await normalize("cursor/update_todos", { toolCallId: "b", merge: true, todos: [{ id: "b", content: "Ship", status: "cancelled" }] });
    expect(second[0]?.payload).toMatchObject({ planId: first[0]?.payload.planId, revision: 2, complete: false, steps: [{ body: "Build", status: "pending" }, { body: "Ship\n(Cancelled)", status: "blocked" }] });
    const final = await normalize("cursor/update_todos", { toolCallId: "c", merge: false, todos: [{ id: "a", content: "Build", status: "completed" }] });
    expect(final[0]?.payload).toMatchObject({ revision: 3, complete: true, steps: [{ body: "Build", status: "completed" }] });
  });
  it("preserves delegation role/model/task and native duration", async () => {
    const normalize = createCursorNotificationNormalizer({ workspacePath: await workspace(), turnId: "turn" });
    const [event] = await normalize("cursor/task", { toolCallId: "call", description: "Find references", prompt: "Search src", subagentType: { custom: "research" }, model: "model-1", agentId: "child-1", durationMs: 312 });
    expect(event).toMatchObject({ eventType: "delegation.completed", payload: { children: [{ role: "research", model: "model-1", summary: "Find references", activitySummary: "Search src\nDuration: 312 ms" }] } });
  });
  it("verifies generated image references and refuses symlinks, escapes, directories and missing files", async () => {
    const root = await workspace();
    const inside = join(root, "workspace"); await mkdir(inside); await mkdir(join(inside, "outputs"));
    await writeFile(join(inside, "outputs", "image.png"), "image"); await writeFile(join(root, "secret"), "private");
    await symlink(join(root, "secret"), join(inside, "link"));
    await symlink(join(inside, "outputs"), join(inside, "linked-dir"));
    expect(await cursorWorkspaceArtifactReference(inside, join(inside, "outputs", "image.png"))).toBe("outputs/image.png");
    for (const path of ["../secret", join(root, "secret"), "link", "linked-dir/image.png", "missing", "outputs", "outputs/evil\u0000.png", "C:\\secret"]) expect(await cursorWorkspaceArtifactReference(inside, path)).toBeNull();
    const normalize = createCursorNotificationNormalizer({ workspacePath: inside, turnId: "turn" });
    expect(await normalize("cursor/generate_image", { toolCallId: "image", description: "A diagram", filePath: "outputs/image.png" })).toMatchObject([{ eventType: "artifact.generated", payload: { reference: "outputs/image.png", registered: false } }, { eventType: "provider.notice.recorded", payload: { summary: "A diagram" } }]);
    expect(await normalize("cursor/generate_image", { toolCallId: "image", description: "A diagram", filePath: "../secret" })).toMatchObject([{ payload: { reference: null } }, {}, { payload: { category: "cursor_artifact_path_rejected" } }]);
  });
  it("maps opt-in subagent lifecycle without treating cancellation as completion", () => {
    const base = { subagentSessionId: "child.2", _meta: { cursor: { toolCallId: "task-1", agentId: "child", model: "small" } } };
    expect(normalizeCursorSubagentUpdate({ ...base, sessionUpdate: "subagent_spawned", name: "Explore", task: "Find tests" })).toMatchObject({ eventType: "delegation.started", payload: { status: "running", children: [{ role: "Explore", model: "small", summary: "Find tests" }] } });
    expect(normalizeCursorSubagentUpdate({ ...base, sessionUpdate: "subagent_state_update", state: "cancelled" })).toMatchObject({ eventType: "delegation.completed", payload: { status: "interrupted" } });
    expect(normalizeCursorSubagentUpdate({ sessionUpdate: "agent_message_chunk" })).toBeNull();
    const normalize = createCursorSubagentNormalizer();
    normalize({ ...base, sessionUpdate: "subagent_spawned", name: "Explore", task: "Find tests" });
    expect(normalize({ ...base, sessionUpdate: "subagent_state_update", state: "completed" })).toMatchObject({ payload: { children: [{ role: "Explore", model: "small", summary: "Find tests", status: "completed" }] } });
  });
});

describe("Cursor active-turn extension adapter", () => {
  it("roundtrips canonical answers and plan decisions while rejecting implicit acceptance", async () => {
    const adapter = createCursorProfileExtensionAdapter({ workspacePath: await workspace(), sessionId: "parent", turnId: "turn" });
    const question = await adapter.request("cursor/ask_question", { sessionId: "parent", toolCallId: "ask", questions: [
      { id: "native", prompt: "Choose", options: [{ id: "native-option", label: "One" }] },
    ] });
    if (!("input" in question)) throw new Error("question was not blocking");
    expect(question.input.resolve({ action: "submit", response: response({ "question-1": { selectedOptionIds: ["option-1"] } }) })).toEqual({ outcome: { outcome: "answered", answers: [{ questionId: "native", selectedOptionIds: ["native-option"] }] } });
    expect(question.input.resolve({ action: "decline" })).toEqual({ outcome: { outcome: "skipped" } });
    expect(question.input.resolve({ action: "cancel" })).toEqual(question.input.cancel());
    expect(() => question.input.resolve({ action: "accept" })).toThrow();
    expect(() => question.input.resolve({ action: "submit", answers: { "question-1": { answers: ["option-1"] } } })).toThrow();

    const plan = await adapter.request("cursor/create_plan", { sessionId: "parent", toolCallId: "plan", plan: "# Complete plan\n".repeat(1_000), todos: [] });
    if (!("input" in plan)) throw new Error("plan was not blocking");
    expect(plan.input.details.revision).toMatch(/^[a-f0-9]{64}$/);
    const id = plan.input.questionSet.questions[0]!.id;
    expect(plan.input.resolve({ action: "submit", response: response({ [id]: { selectedOptionIds: ["accept"] } }) })).toEqual({ outcome: { outcome: "accepted" } });
    expect(() => plan.input.resolve({ action: "accept" })).toThrow("displayed revision");
    expect(plan.input.resolve({ action: "decline" })).toEqual({ outcome: { outcome: "rejected" } });
    expect(plan.input.cancel()).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("acknowledges native request-shaped activity and preserves its reducer order", async () => {
    const adapter = createCursorProfileExtensionAdapter({ workspacePath: await workspace(), sessionId: "parent", turnId: "turn" });
    const first = await adapter.request("cursor/update_todos", { sessionId: "parent", toolCallId: "a", merge: false, todos: [{ id: "a", content: "Read", status: "pending" }] });
    expect(first).toMatchObject({ response: {}, events: [{ eventType: "plan.updated", payload: { revision: 1 } }] });
    const second = await adapter.notification("cursor/update_todos", { sessionId: "parent", toolCallId: "b", merge: true, todos: [{ id: "b", content: "Write", status: "pending" }] });
    expect(second).toMatchObject([{ payload: { revision: 2, steps: [{ body: "Read" }, { body: "Write" }] } }]);
    await expect(adapter.request("cursor/update_todos", { sessionId: "other" })).rejects.toThrow("stale parent");
    await expect(adapter.notification("cursor/task", { sessionId: "other" })).rejects.toThrow("stale parent");
    await expect(adapter.request("cursor/unknown", { sessionId: "parent" })).rejects.toThrow("Unsupported");
  });

  it("requires a known child spawn and immutable origin within the active parent", async () => {
    const context = { workspacePath: await workspace(), sessionId: "parent", turnId: "turn" };
    const adapter = createCursorProfileExtensionAdapter(context);
    const update = { subagentSessionId: "child", _meta: { cursor: { toolCallId: "task", agentId: "native-child", model: "small" } } };
    const state = { ...update, sessionUpdate: "subagent_state_update", state: "completed" };
    await expect(adapter.notification("cursor/subagent_update", { sessionId: "parent", update: state })).rejects.toThrow("no spawn");
    const spawned = { ...update, sessionUpdate: "subagent_spawned", name: "Research", task: "Inspect source" };
    expect(await adapter.notification("cursor/subagent_update", { sessionId: "parent", update: spawned })).toMatchObject([{ eventType: "delegation.started", payload: { children: [{ role: "Research", model: "small" }] } }]);
    expect(await adapter.notification("cursor/subagent_update", { sessionId: "parent", update: state })).toMatchObject([{ eventType: "delegation.completed", payload: { children: [{ role: "Research", summary: "Inspect source" }] } }]);
    await expect(adapter.notification("cursor/subagent_update", { sessionId: "other", update: state })).rejects.toThrow("stale parent");
    await expect(adapter.notification("cursor/subagent_update", { sessionId: "parent", update: { ...state, _meta: { cursor: { ...update._meta.cursor, toolCallId: "forged" } } } })).rejects.toThrow("origin identity");
    await expect(adapter.notification("cursor/subagent_update", { sessionId: "parent", update: spawned })).rejects.toThrow("duplicated");
    await expect(createCursorProfileExtensionAdapter({ ...context, turnId: "next" }).notification("cursor/subagent_update", { sessionId: "parent", update: state })).rejects.toThrow("no spawn");
  });

  it("attributes nested child transcripts, reports partial tool detail, and settles disconnected children honestly", async () => {
    const adapter = createCursorProfileExtensionAdapter({ workspacePath: await workspace(), sessionId: "parent", turnId: "turn" });
    const child = { sessionUpdate: "subagent_spawned", subagentSessionId: "child", name: "Explore", task: "", _meta: { cursor: { toolCallId: "task", agentId: "agent" } } };
    await adapter.notification("cursor/subagent_update", { sessionId: "parent", update: child });
    const grandchild = { ...child, subagentSessionId: "grandchild", _meta: { cursor: { toolCallId: "task-2", agentId: "agent-2" } } };
    expect(await adapter.notification("cursor/subagent_update", { sessionId: "parent", parentSessionId: "child", update: grandchild })).toMatchObject([{ payload: { children: [{ activitySummary: expect.stringContaining("Parent child:") }] } }]);
    const text = await adapter.notification("cursor/subagent_update", { sessionId: "parent", childSessionId: "grandchild", parentSessionId: "child", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "漢".repeat(5_000) } } });
    expect(text[0]?.payload).toMatchObject({ children: [{ activitySummary: expect.stringContaining("Earlier child activity omitted") }] });
    const tool = await adapter.notification("cursor/subagent_update", { sessionId: "parent", childSessionId: "child", update: { sessionUpdate: "tool_call", toolCallId: "read", title: "Read src", status: "completed", rawInput: { path: "src/index.ts" } } });
    expect(tool).toMatchObject([{ eventType: "delegation.updated", payload: { children: [{ activitySummary: "Tool Read src: completed" }] } }, { eventType: "provider.notice.recorded", payload: { category: "cursor_child_detail_partial" } }]);
    const disconnected = await adapter.notification("cursor/subagent_update", { sessionId: "parent", update: { ...child, sessionUpdate: "subagent_state_update", state: "disconnected" } });
    expect(disconnected).toMatchObject([{ payload: { status: "failed", children: [{ status: "failed", activitySummary: expect.stringContaining("disconnected before settling") }] } }]);
    await expect(adapter.notification("cursor/subagent_update", { sessionId: "parent", childSessionId: "grandchild", parentSessionId: "wrong", update: {} })).rejects.toThrow("unknown parent");
  });
});
