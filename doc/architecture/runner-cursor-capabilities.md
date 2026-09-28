# Cursor ACP capability inventory

Evidence date: 2026-09-28. Candidate: `2026.09.26-dd393fe`. This profile is **not live-qualified**. No billable prompt was sent ($0 of the assigned $25 budget); no explicit Cursor credential was available. Local authenticated execution, restrictive permission enforcement, dollar usage, and Daytona execution remain required qualification gates.

The reference is the runner's Codex app-server integration and its closed thread-item inventory in `src/provider-events.ts`. Cursor ACP and its private extension methods are the transport; the legacy Cursor adapter is unchanged.

## Evidence and packaging

- [Cursor's ACP contract](https://cursor.com/docs/cli/acp) describes stdio JSON-RPC, sessions, permissions and five extensions. The pinned binary reveals additional capabilities and one material documentation discrepancy below.
- `packages/paperclip-runner/cursor-distributions.json` pins vendor archive and complete extracted execution-closure SHA256 digests for macOS ARM64/x64 and Linux x64. All three archives were downloaded and independently inventoried (446 files on macOS, 454 on Linux). A real macOS ARM64 installation passed the materializer's full closure check.
- The archive is a complete runtime: bundled `node`, `index.js`, dynamically loaded numbered JavaScript chunks, native addons, workers, and assets. Pinning only the launcher or one executable does not pin its execution dependencies. The materializer rejects links/special files and overwrites, and verifies every file against the pinned closure digest.
- `test/fixtures/cursor-acp/credential-free-probe.json` records an actual macOS ARM64 initialization and nonbillable method probes. `initialize` reports ACP v1, session load/list, HTTP/SSE MCP, image prompts, and opt-in subagent events. Audio and embedded context are false. `session/fork` and `session/resume` return method-not-found. Creating/listing a session requires authentication.
- Static evidence comes from `5672.index.js` (ACP implementation), `8096.index.js` (ACP SDK protocol schemas), `190.index.js` (hook paths) and `index.js` (CLI/configuration), all bound by the archive and closure pins. SDK schema support alone is not counted as implemented harness capability.

## Capability matrix against Codex app-server

“Implemented” below means a tested Cursor boundary implementation; the shared runtime must route its canonical events and durable requests. It is not a claim of authenticated end-to-end qualification.

| Capability | Cursor harness/ACP evidence | Paperclip treatment | Remaining gap or qualification |
|---|---|---|---|
| Streaming assistant/reasoning | `agent_message_chunk`, `agent_thought_chunk` in live and replay presenters | Existing ACP streaming path | Authenticated event capture required |
| Tool lifecycle/input/output | `tool_call` and `tool_call_update`, including raw input/output, locations and content | Existing canonical tool lifecycle; Cursor extensions add semantic activity | Standard content blocks/diffs must survive shared ACPX mapping; evaluate captured field coverage |
| Human questions | `cursor/ask_question`, native single/multiple selections | `normalizeCursorQuestionRequest`: all questions required; opaque UI IDs round-trip native IDs; forged/duplicate/missing selections rejected | Cancellation and skip outcomes must be routed by shared durable request lifecycle |
| Proposed plans and decisions | `cursor/create_plan` with full Markdown, overview, todos, named phases and project flag | `normalizeCursorPlanRequest`: complete presentation; accept/reject/cancel; revision-derived question ID; rejection feedback | Foundation question descriptions allow 100,000 chars; this boundary also enforces the 196 KiB UTF-8 durable payload cap. Oversize rejects; it is never truncated. No generated `planUri`, since no uploaded plan artifact is fabricated |
| Execution checklist | Standard ACP `plan` and `cursor/update_todos` (`merge`) | Per-turn reducer merges by native ID and emits complete snapshots with increasing revisions | Native cancelled status is visible as “Cancelled” with canonical blocked status, since canonical plan schema has no cancelled enum |
| Child activity | Optional `subagent_spawned`, `subagent_state_update`; metadata has tool-call/agent/model identity | Stateful child normalizer emits canonical delegation and retains role/task across state deltas; shared host must validate parent ownership | Requires client `_meta.subagents: true`. Nested transcript routing and child authority need end-to-end evidence |
| Completed subagent tasks | `cursor/task`: description, prompt, subtype, model, ID, duration | Canonical delegation with role, model, task and duration in activity summary | Dedicated numeric duration field absent from canonical delegation schema |
| Subagent questions | Pinned ACP subagent handler explicitly rejects interactive questions | No unsupported affordance advertised | Confirmed harness omission; requires upstream support |
| Generated images | `cursor/generate_image`: description, path and reference-image paths | Canonical generated/viewed artifact events; description notice; realpath/regular-file containment checks; `registered:false` | Paths are references, not automatic uploads. Revalidate before artifact ingestion. No image bytes invented |
| Files and diffs | Tool content/location extraction, native edit output | Existing workspace-diff machinery plus canonical tool events | Need live fixture proving complete before/after content and path attribution; currently unverified |
| True active-turn steering | No `session/steer`; `handlePrompt` cancels its existing pending prompt before starting another | Advertise steering unsupported | Concurrent prompt is interruption/replacement, not Codex-style in-place steering. Do not mislabel it |
| Queued follow-ups | No harness queue method discovered | Control-plane scheduling can send another prompt after settlement | No native queue-management events; do not send concurrently to emulate queueing |
| Cancellation | `session/cancel` calls the active prompt cancellation callback | Existing interruption path | Process/child cleanup and exact terminal settlement require live qualification |
| Turn settlement | Prompt implementation drains background subagent completion and awaits child publishers | Existing prompt result terminal boundary | Background shell commands and child errors need live denial/settlement fixtures |
| Session continuity | `session/new`, `session/load`; load replays historical messages, reasoning, tools, images and children | Existing session load/recovery boundary with identity fencing | Duplicate replay suppression and provider-death recovery need authenticated proof |
| Session discovery | `session/list` implemented, cwd filter absolute; pagination cursor rejected | Discovered and reported | Currently unused: runner recovers only its exact recorded session; arbitrary history browsing needs company-scoped discovery API |
| Fork/resume methods | `session/fork` and `session/resume` absent in agent implementation and return method-not-found | Unsupported | Session load is available; do not infer fork from SDK schema |
| Modes | `agent`, `plan`, `ask`; `session/set_mode` and `current_mode_update` | Existing review/mode activity plumbing can display changes | Generic operator mode-selection surface not implemented in this provider slice |
| Model selection | `session/set_model`, config option `model`, model-parameter options, `config_option_update`; `cursor/list_available_models` extension | Exact requested model must be selected/verified by shared admission | Available-model listing is authenticated; no model ID guessed or silently substituted. Parameterized model UI not added |
| Available commands | `available_commands_update`, including skills/slash commands | Existing ACP runtime event path | Command-specific UI/discovery not implemented; preserve bounded metadata where shared mapping permits |
| Session metadata | `session_info_update` title after automatic naming | Capability documented | Runner owns normalized session identity; provider title is currently not surfaced |
| Prompt media | Image=true, audio=false, embeddedContext=false in observed initialize | Image inputs may be admitted by advertised capability | Product attachment-to-ACP conversion needs qualified test; audio/embedded context unsupported |
| MCP and semantic tools | Session MCP injection supports stdio/HTTP/SSE; user/project config also loaded | Runner-owned authenticated MCP bridge only; fail closed on ambient project MCP | Exact tool discovery and company/token boundary remain live tests |
| Usage/cost | No `usage_update`/token-usage emission found in pinned ACP implementation; prompt result contains stopReason | Must report usage unavailable, never zero or estimates presented as actual | Dollar accounting unavailable without another explicit measured source. Live spend needs a measurable bound before starting |
| Reviews, compaction, hooks, memory | Native mode changes, hooks present internally; no dedicated ACP counterparts to Codex context/hook/memory lifecycle found | No fabricated event families | Distinguish confirmed absence of ACP event mapping from unverified native internals |
| Goal controls / lineage | No ACP goal or fork lineage protocol found | Unsupported | No equivalent of Codex native goals/thread lineage |

## Wire and isolation findings

The documentation calls todo/task/image methods notifications. The pinned presenter actually calls `connection.extMethod(...).catch(...)`: these messages can carry JSON-RPC IDs. They need immediate acknowledgement plus activity normalization. They must never become human input requests or block awaiting an unnecessary decision.

Question and plan requests lack a session ID. The shared hook must bind them to the retained connection, active execution/session/turn and originating request ID; reject stale/duplicate answers; cancel on turn termination; persist requests before exposing them; and acknowledge provider delivery before settlement. The provider module does not substitute a best-guess session.

Fixed launch arguments are `--disable-project-configs --disable-auto-update acp`, using the verified bundled Node and absolute verified `index.js`. Private HOME/XDG roots are required together with CURSOR_CONFIG_DIR, CURSOR_DATA_DIR, a private compile cache, `AGENT_CLI_CREDENTIAL_STORE=memory`, and `NO_OPEN_BROWSER=1`. Only explicitly bound CURSOR_API_KEY or CURSOR_AUTH_TOKEN may enter; never inherit shell credentials. Do not use `--force`, `--trust`, or `--approve-mcps` to paper over governance.

`--disable-project-configs` only suppresses `.cursor/cli.json`. It does not suppress project MCP, Cursor/Claude hooks, or installed plugins. `assertCursorWorkspacePolicy` refuses ambient project execution config from the workspace through its nearest Git root, including symlinks and unreadable configuration. Ordinary Claude settings with neither hooks nor plugins remain admissible. Enterprise system hooks are checked too. The host must protect these config paths during execution and repeat admission checks on recovery. Admission alone cannot prevent a concurrent file mutation. Team-provided remote hooks are another upstream boundary and remain unqualified under restrictive execution.

Artifact paths are never automatically read or uploaded. References require a present regular file under the physical workspace, reject traversal and symbolic links, and retain `registered:false`. Private/outside paths are omitted and produce a visible warning. This is metadata validation, not durable file ownership or a replacement for artifact registration checks.

## Verification and open work

Passed in the provider worktree:

- 10 Cursor Vitest cases: questions, multi-selection, native ID round-trip, invalid answers, exact plan revisions, outcomes, todo delta merging, delegation metadata, path containment/symlink refusal, child identity retention, private launch defaults and project config gates.
- 5 materializer Node tests: platform pins, entire-tree tampering, linked paths, archive tampering before extraction, and overwrite refusal.
- Targeted strict TypeScript compilation for both provider modules and their imported contracts.
- Credential-free wire initialization and auth/method probes, plus real macOS ARM64 materialization and archive/closure inventories for the other two platforms.

The generic native-distribution lease now snapshots the pinned closure, launches Cursor through its verified bundled Node with a closed-module guard, and uses the existing lifetime guardian. A real nonbillable Cursor initialization passed through that lease. Its six focused tests passed, including argument fencing, external module rejection, and native child ownership/exit proof. The existing snapshot suite passed; four legacy installation tests were blocked by the shared installed Claude SDK (0.3.280 versus the pinned 0.3.263), with the remaining legacy tests passing or platform-skipped.

Priority follow-ups before advertising support: (1) shared hook integration with durable response/recovery tests; (2) authenticated native lifetime and cleanup proof; (3) explicit credentials plus exact available model and measured dollar budget; (4) local and Daytona semantic tools, permissions, steering distinction, files/artifacts, questions/plans and settlement proof; (5) field-by-field captured trace audit to identify any additional unconsumed native fields.

Remaining rich capabilities intentionally unused: session discovery, generic mode/config-option UI, provider session titles, command/skill picker metadata, nested child transcripts beyond delegation summaries, native numeric task duration, and optional planUri. They are listed above with reasons; neither “unsupported” nor “complete” should be inferred for unverified live behaviors. The final combined report must update this inventory with integration evidence and include any further events observed during authenticated qualification.
