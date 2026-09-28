# Copilot 1.0.88 rich ACP capability audit

Audited 2026-09-28 against repository base `c65fc9e3c81c41aafe421aa90a00514b84343285`.
Status: **candidate, not qualified**. No GitHub credential, entitlement, real model,
or Daytona execution has been verified. Real executable offline probes cost $0;
no billable request was made. The allocated live budget remains $25, subject to
the shared $100 hard stop and verifiable spend. Do not expose this profile as
supported until the required local and Daytona qualification passes.

## Evidence and scope

The audit inspected the exact `@github/copilot@1.0.88` platform archives, the
native executable's embedded `app.js`, `schemas/session-events.schema.json`, CLI
help/config/environment output, and real ACP wire traffic. The embedded schema
SHA-256 is `d8cb713c05d5278a68dde5c5d4482574f836e922ae13aa06f82474c209a7c6e9`.
The [complete event/field inventory](../../packages/paperclip-runner/test/fixtures/copilot-event-inventory-1.0.88.json)
contains all 150 native event types and their data field names, including every
event we do not subscribe to. Fields in that file describe the native schema;
they are not a claim that every event was observed on the wire.

Primary external references: [ACP server documentation](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server),
[CLI command reference](https://docs.github.com/en/copilot/reference/cli-command-reference),
[denial bypass report #4537](https://github.com/github/copilot-cli/issues/4537),
and [background completion report #4743](https://github.com/github/copilot-cli/issues/4743).
The exact pinned implementation takes precedence over moving documentation.
The [harness priorities report](https://pages.paperclip.ing/2026-09-25-harness-priorities/)
defines the requested product outcome. Existing Codex app-server contracts and
conformance tests are the comparison baseline, especially `turn/steer`,
`turn/interrupt`, `thread/read`, file changes, user input, and scoped approvals.

## Distribution and authority

Launch the verified platform `copilot` executable directly with `--acp --stdio`.
Do not execute the mutable `npm-loader.js`, install hooks, or an ambient PATH
binary. `materialize-copilot-binary.mjs` validates exact package/version, executable
mode and bytes, then writes a native-closure manifest. Runtime descriptor leases
must independently verify the trusted closure digest before every launch.

| Platform | Executable SHA-256 | Bytes | Closure SHA-256 |
| --- | --- | ---: | --- |
| macOS ARM64 | `a9ff8babb10b7e443182ae96a8bc50a9c826ef1c773e1344c396eb5bf7f512c3` | 152595280 | `fb3b367a45cd76122fe931521fa2a18adf234ba944fc302db9e10e005e57037e` |
| macOS x64 | `85eb919f6b9b9dd833ce5e326cbf974b3ee2d4a9ac525c59d4ec9c9ec085715b` | 165041200 | `05f3497b336b3efdec347beb2e3b80b02cfa95f811fafddc25d0b029ab95d711` |
| Linux x64 | `0059754cf78c3f3bf2c9d4564dfa7e9e25f3a3f8f411f2f0cdad9363f5662748` | 169544512 | `1a675c5b54ae4d94f08718a318451e0499708ded388b4cfd98acec6b4311ccbd` |

All three archives were verified against the npm SHA-512 integrity value before
hashing the executable. Archive pins are retained in the materializer. Only the
ARM64 executable was run. The binary contains its JavaScript/native runtime and
extracts it into `COPILOT_PKG_CACHE_HOME`; this must be a fresh per-spawn private
lease directory, never a writable cache shared across executions. The native
distribution verifier supplied by the foundation owns that isolation boundary.

`copilot-profile.ts` supplies private HOME/XDG directories, COPILOT_HOME,
COPILOT_CACHE_HOME and an extraction-cache binding; update disabling; no built-in
MCP servers; no remote/remote-export or shell startup environment; and secret
environment stripping for child shells/MCP. Only explicitly bound
`COPILOT_GITHUB_TOKEN` may authenticate production use. The offline fixture uses
an intentionally separate, credential-free loopback provider, not this production
credential path. Private configuration disables hooks, memory and automatic IDE
attachment and has no trusted folders.

Never set `COPILOT_ALLOW_ALL=true`: this exact string also trusts workspace
hooks, plugins and MCP configuration. Paperclip's full-auto policy answers the
individual permission callback. It must not grant ambient configuration trust.
Mode/config changes, including autopilot and the provider's `allow_all` option,
must not bypass the admitted Paperclip policy. Slash-command discovery includes
commands capable of changing permissions, cwd, remote/export, MCP and schedules;
these are not authority to offer an unrestricted command UI. Adversarial
workspace/config qualification remains required before release.

The pinned ACP handler maps `allow_always` to native `approve-for-session` for
commands, writes, reads, MCP and other supported tools. Path approval is also
session-scoped; URL approval is session-scoped to an origin pattern. Factory
permissions omit that option and reject fabricated permanent approval. This
scope is confirmed in source, not inferred from the option label. Read/write
session grants are broader than one file and must be described accurately.

## Negotiation and event contract

The observed initialize result advertises protocol 1; `loadSession: true`;
HTTP/SSE MCP; image and embedded-context input; no audio input; and session list
and close. It does not advertise steering, forking, goals, or a question/plan
extension responder. The source adapter supports model/reasoning/config changes,
but the offline session only returns `mode` and `allow_all` options. There is no
verified GitHub model ID from this probe. Require an explicitly selected model
and exact effective-model verification; never silently use the fixture's
`gpt-4.1` or substitute another model. A possible candidate such as
`gpt-5.6-luna` is unverified until authenticated negotiation succeeds.

The native event extension is real and is negotiated with:

```json
{"clientCapabilities":{"_meta":{"github.com/copilot":{"events":["subagent.started","session.workspace_file_changed","assistant.usage"]}}}}
```

The notifications are:

```json
{"method":"github.com/copilot/sessionEvent","params":{"sessionId":"...","type":"subagent.started","timestamp":"...","data":{},"agentId":"..."}}
```

The source caps subscription names at 128, payloads at 32 KiB, and pending
notification sends at 256. Oversized/unserializable payloads carry `dataOmitted`;
backpressure can drop events. There is no event ID or reliable replay contract.
`skill.context_delivered` and `skill.context_delivered_ref` are explicitly blocked
even when subscribed. These are provider restrictions, not missing runner parsing.

`copilot-events.ts` requests 22 event types and projects only bounded declared
fields after matching the active session and turn. It records source method/type,
provider timestamp and subagent identity. Payloads cannot authorize filesystem
reads, workspace rebinding, permission changes, native-input replies or terminal
settlement. Inline binary assets are content-address verified; only metadata is
forwarded until a provider-session artifact resolver can upload them safely.

`copilot-extension-adapter.ts` converts the normalized events into canonical
delegation, compaction and unregistered artifact activity. Every safe projected
field is retained in bounded provider-notice details with method/event/session/
turn provenance. Notices have readable summaries; secret-shaped string values
are scrubbed without erasing numeric token counters. These display events never
create a usage charge, input-resolution acknowledgment, registered artifact, or
turn terminal event. The provider registry installs this factory and initialize
capability metadata in the provider branch.

## Comparison against Codex app-server

“Source” means verified in the pinned implementation; “wire” means observed in
the real ARM64 executable against the deterministic offline model. Product UI and
Daytona claims require the separate live product qualification.

| Capability / Codex benchmark | Copilot native and ACP exposure | Runner and user-visible surface | Evidence / remaining gap |
| --- | --- | --- | --- |
| Active turn steering (`turn/steer`) | Native SDK steering exists. ACP `session/prompt` unconditionally aborts the active session before sending a new prompt. | Unsupported active steering; do not impersonate it with concurrent prompts. | Source; P1 add a versioned upstream ACP steering method. |
| Ordered follow-ups | Native pending-message controls and `pending_messages.modified`; notification has no queue body. | Lifecycle activity only. Scheduler can start a subsequent completed-turn prompt, but that is not native queue delivery. | Source; P1 require queue acknowledgment and ordering contract. |
| Interruption (`turn/interrupt`) | Standard `session/cancel`, active prompt abort and process shutdown. | Shared cancellation and bounded cleanup. | Source; authenticated cancellation/process-tree test pending. |
| Session recovery/history | `session/load`, list and close; native history and rewind richer. | Exact identity/warm continuation through shared ACPX host; never replay approvals or mutations. | Initialize wire; restart/load history and pending-input recovery unqualified. |
| Fork / history paging | Native CLI/SDK capabilities exist; no ACP fork advertised. | Unsupported. | Confirmed absent from initialize advertisement, not proof native harness lacks it; P2 upstream extension. |
| Tools / correlation | Standard `tool_call`/`tool_call_update`; parent identity in `_meta["github.com/copilot"].agentId`. HTTP/SSE MCP supported. | Shared tool activity, authenticated runner-owned MCP bridge. | Real create/bash/read_bash traffic; semantic tools/company boundary live proof pending. |
| Scoped approvals | `session/request_permission`, actual options allow_once/allow_always/reject_once. | Shared durable permissions; only received decisions offered, policy enforced. | Wire ID 0 denied before file creation. Ask-mode recovery and wider tool denial unqualified. |
| Structured questions | Native `ask_user` callback and `user_input.requested`; current ACP adapter does not wire the responder. | Emits capability-gap notice if native notification arrives; cannot claim answer delivery. | Actual agent-mode tool list omits `ask_user` with no suppression flag; other modes unverified. P0 qualify blocking interaction behavior. |
| Plan approval | Native `exit_plan_mode` callback; notification contains plan content/actions but lacks qualified ACP responder. | Capability-gap notice only; never synthesize plan acceptance. | Agent-mode tool list omits exit_plan_mode. Plan mode requires explicit qualification; P0. |
| Plan progress | Standard plan from todos SQL; native `session.plan_changed` has operation only. | Existing ACP plan/activity; native operation preserved, `planContentAvailable:false`. | Source; plan document reads require native interface. P1. |
| Models / reasoning / config | Source `session/set_model`, config options for model, reasoning, mode, custom agents, allow_all. | Explicit model admission. Mode/governance changes must remain policy-gated. | Offline lacks model metadata; GitHub list and entitlement unverified, P0. |
| Usage | Standard prompt usage and context usage; native assistant usage, AI-unit checkpoint. | Token/counter metadata with source; multiplier and nano-AI-units distinct from USD. | Wire usage; real charge measurement unavailable, P0 budget blocker. Never double-count passthrough. |
| Subagent activity | Native started/configured/completed/failed, model and tool IDs, token/call/duration stats. | Bounded structured activity retaining attribution and model-selection details. | Source and unit fixtures; live UI attribution pending. |
| Task file changes / diffs | Standard tools carry locations/diff content for create/edit/str_replace/apply_patch. | Existing ACP activity/diff path, must retain containment checks. | Real denied create diff; successful product edit pending. |
| Provider workspace files | `session.workspace_file_changed.path` is relative to provider session workspace files, not task cwd. | Validated reference tagged `provider_session_workspace`, resolution required. | Source + traversal tests; P1 safe file retrieval/upload. |
| Images / binary artifacts | Prompt image input; native content-addressed binary_asset base64. | Hash/length-validated metadata references; bytes not blindly read from disk or emitted in activity. | Source + unit digest tests; P1 durable artifact storage; >32 KiB payload provider omission remains. |
| Background settlement | Standard prompt waits for idle in tested attached async-shell case; lossy native idle/receipt also exist. | ACP terminal result remains authoritative; raw event cannot end turn. | Offline attached shell wrote marker and read output before end_turn. Detached/live cases unverified; P0 release qualification. |
| Compaction/context | Native compaction lifecycle/token counts/context git metadata. | Safe bounded counters/status, immutable workspace binding. | Source + projection tests; raw summary/private custom instructions omitted. |
| Goals / remote/schedules | Native autopilot/objectives/remote/schedule facilities; no qualified ACP goal protocol. | Unsupported through this profile; remote disabled. | Source; P2 separate governance review before control exposure. |

## Unused event and field accounting

The inventory is exhaustive for the pinned native event schema: 22 selectively
subscribed events, 15 standard-ACP projection events, 111 native passthrough events
not subscribed, and 2 provider-blocked events. Its `fields` array names every
native data field; `fieldCoverage` records each field's disposition and follow-up.
Preserving one standard ACP projection does not imply all native fields survive.

Reasons and priorities are explicit:

| Group | Reason and follow-up |
| --- | --- |
| Standard text/reasoning/tool/plan/config events | Standard ACP already transports the user-facing content. Additional native metadata is not assumed preserved. P2 compare native field inventory against normalization before adding fields; avoid duplicate output and raw reasoning. |
| Native user/plan/elicitation requests and completions | No qualified ACP responder/correlation acknowledgment. P0 prove there is no blocking input before qualification; add an upstream responder or owned wrapper before displaying an answerable UI. |
| Native permission authorization internals, sandbox decisions, recovery | Standard permission callback is the policy decision boundary. P1 collect sanitized denial diagnostics; never let native carried-forward/assent events authorize actions. |
| Native usage diagnostics omitted from subscribed assistant.usage | Quota snapshots, reasoning summaries, fusion/RTE payloads and upstream service/cache diagnostics are not normalized. P2 type/redact useful performance details; quotas and model multipliers cannot substitute for verifiable dollar spend. |
| Native compaction summaries/checkpoint paths/custom instructions | Avoid copying private instruction/summary bodies or treating provider paths as task paths. P2 add explicit safe metadata schema/artifact retrieval where useful. |
| Native model-cache checkpoint data / premium request total | Complex cache state not normalized; premium request totals are not USD. P1 document billing provenance before integration. |
| Native artifact metadata/bytes | Base64 is verified then omitted; arbitrary nested metadata has no current UI contract. P1 safe artifact upload with content type/size/path policy, not a guessed cwd join. |
| Native hook/extension/skill events | Ambient hooks/extensions are disabled and runner-owned skills have their own attribution. P2 typed activity if a verified owned extension needs it. Two context-delivered types are blocked upstream. |
| Native MCP auth, headers, dynamic lists, reconnect and tool events | Only runner-owned bridge is admitted. P1 sanitized bridge availability diagnostics; do not surface OAuth/headers as unrestricted interactions. |
| Native remote/handoff, schedule, canvas, fusion/factory, memory/indexed-search, UI-ephemeral events | No corresponding admitted ACP control/resource or typed product surface. P2 investigate useful artifact/subagent projections separately; disabled remote authority stays disabled. |
| Native raw user/system messages, assistant lifecycle/retries, streaming internals, tool progress | Standard ACP provides primary conversation/tool lifecycle; duplicate/private bodies intentionally not subscribed. P1 audit lost meaningful progress/retry metadata with sanitized bounded samples. |
| Native external-tool/sampling/limits callbacks | No qualified ACP responder. P0 prove no unresolved request on admitted model/tools; otherwise keep release unqualified. |
| Native capability/model/session lifecycle/config notices | Initial handshake and normalized session/config are admission authority. P1 detect capability/model drift and fail closed rather than treat a notice as authorization. |

Subagent subscribed fields are preserved within the declared text bounds;
truncated display strings carry an explicit truncation marker. Empty native
`pending_messages.modified` and `session.background_tasks_changed` events have no
queue/task list to preserve; their projection explicitly says refresh unavailable.
Native context repository/git-root strings, completion receipt finalTool,
compaction summary internals, artifact metadata, nested cache state, and native
question/plan contents are individually marked in the inventory. No exposed
native field should be read as silently supported merely because its event name
appears in the subscription.

## Deterministic verification and retained wire

The reusable `scripts/probe-copilot-acp.py` verifies the pinned executable before
running it with a fresh environment and a deterministic loopback OpenAI-compatible
fixture. `COPILOT_OFFLINE=true`; no credential is inherited. It bounds fake model
calls and process lifetime and removes its owned workspace. The fixture model ID
does not verify any GitHub model's availability.

```sh
python3 packages/paperclip-runner/scripts/probe-copilot-acp.py --package-root /path/to/copilot-darwin-arm64/package --scenario deny-write
python3 packages/paperclip-runner/scripts/probe-copilot-acp.py --package-root /path/to/copilot-darwin-arm64/package --scenario attached-shell
node --test packages/paperclip-runner/scripts/materialize-copilot-binary.test.mjs packages/paperclip-runner/scripts/build-copilot-distribution.test.mjs
pnpm --filter @paperclipai/paperclip-runner exec vitest run src/drivers/acpx/copilot-events.test.ts src/drivers/acpx/copilot-profile.test.ts src/drivers/acpx/copilot-evidence.test.ts
pnpm --filter @paperclipai/paperclip-runner exec vitest run src/drivers/acpx/copilot-extension-adapter.test.ts src/drivers/acpx/copilot-registry.test.ts
```

Retained real-binary evidence:

- [Denial wire](../../packages/paperclip-runner/test/fixtures/copilot-acp-denial-1.0.88.json): request ID 0; reject_once; failed tool update; target file absent after end_turn. This narrow case did not reproduce #4537.
- [Attached-shell settlement wire](../../packages/paperclip-runner/test/fixtures/copilot-acp-settlement-1.0.88.json): two-second async attached command; marker written; output consumed through read_bash; idle followed by end_turn. This narrow case did not reproduce #4743.
- All three materialized platform executables match pinned digests. Only ARM64 wire behavior was exercised.

These are local offline conformance probes, not product E2E or live GitHub
qualification. No screenshots were produced because no product UI was exercised.
Required blockers remain: explicitly bound token, confirmed entitlement and exact
model, measured cost, successful file edit/validation, semantic tools, every
blocking question/plan mode, restrictive permissions across native tools and
configuration, warm/restart input recovery, active cancellation, multi-company
isolation, artifact UI, macOS x64 execution and Linux x64 Daytona E2E. Retry with
another pinned release if a blocking interaction or settlement/denial case fails;
do not suppress the interaction to obtain a pass.

## Build-owned native distribution

`buildPinnedCopilotDistribution({ outputRoot })` in
`scripts/build-copilot-distribution.mjs` downloads the exact platform npm archive
from `registry.npmjs.org`, verifies its pinned SHA-512 integrity, and admits only
the four expected regular tar members. Traversal, links, PAX overrides, duplicate
entries, bad checksums, hidden trailers, and oversized input fail admission. The
binary is independently checked against the pinned SHA-256 and exact size before
it is materialized; no install script, npm launcher, or downloaded executable runs
during this build. `outputRoot` is the selected pack's exact
`provider-assets/copilot/<platform>-<arch>` directory.

The factory resolves those assets from the runner's verified package authority,
including the descriptor-loaded sidecar path, then the native verifier makes a
private executable lease and fresh extraction cache. Callers cannot choose a
runtime binary or distribution root.

On 2026-09-28 the strict archive reader verified the actual pinned archives for
all three platforms. A fresh macOS ARM64 registry download completed the full
builder, returning the profile digest above and closure
`sha256:fb3b367a45cd76122fe931521fa2a18adf234ba944fc302db9e10e005e57037e`.
The temporary output was removed after verification. This packaging proof used
no model credentials, executed no provider turn, and incurred $0 model spend;
it does not qualify either local product behavior or Daytona execution.

The Copilot branch connects all three closed registries: profile installation
selects the pinned native verifier, profile extensions advertise only the 22
selected native event types and create the Copilot adapter, and candidate packs
select the verified archive builder. Registry conformance checks the complete
subagent field projection through the shared turn binder, attribution, canonical
schema validation, meaningful display details, and stale/cross-session rejection.
Admission error classification distinguishes missing authentication, account or
organization denial, and unavailable explicit models using fixed safe messages;
unrelated runner integrity errors keep their original classification.
