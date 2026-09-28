# Pi rich ACP runtime

Status: implementation candidate, 2026-09-28. Deterministic protocol tests and an
uncredentialed admission probe pass. Paid local inference and Linux x64 Daytona
qualification are pending; this document does not promote the candidate to a
qualified production runtime.

The runner pins `pi-acp@0.0.33` and
`@earendil-works/pi-coding-agent@0.84.2`. The candidate model is
`openrouter/deepseek/deepseek-v4-flash-0731`; only an explicitly bound OpenRouter
credential may reach this profile. `patches/pi-acp@0.0.33.patch` repairs the ACP
wrapper. `pi-runtime-extension.ts` supplies the runner-owned semantic bridge and
pre-execution native tool policy. This keeps the upstream session, model,
streaming, diff, retry, and compaction implementation while making its missing
boundaries explicit.

## Capabilities and differences from Codex app-server

| Surface | Pi implementation and boundary |
| --- | --- |
| Sessions | Native Pi JSONL create/load; resume is confined to the execution's private session home and original workspace. Cold `prompt` cannot implicitly load an arbitrary session. |
| Text and reasoning | Upstream streams text and thought chunks. The common runner's private reasoning policy still applies; provider support does not authorize retention or display. |
| Native tools | `read`, `grep`, `find`, `ls`, `write`, `edit`, and `bash` pass the immutable extension gate before execution. File roots and read-only mode are checked before and after a permission wait. The host sandbox remains authoritative for shell commands and races. |
| Permissions | Native tool approval uses ACP `session/request_permission`, with allow once, allow for the session, and deny. Only offered options are accepted. Session grants cover an identical operation and still revalidate paths. Questions never become approvals. |
| Questions | Pi `select`, `confirm`, `input`, and `editor` map to ACP form elicitation with typed schemas. Decline, cancellation, timeout, malformed replies, and duplicate/late replies cannot become accepted answers. |
| Semantic tools | Runner-owned loopback HTTP MCP catalogs register under exact `mcp__<server>__<tool>` names. Calls retain the native tool call ID and cancellation signal. Authenticated PRP tool handling owns semantic authorization and durable interactions. Ambient MCP and external MCP servers are not admitted. |
| Plans and artifacts | Pi has no native structured plan or artifact channel. Paperclip plan and artifact semantic tools remain available through the MCP bridge; native file edits retain bounded, workspace-confined ACP diff projection. Tool text/image results are preserved, and resource blocks are recorded without following URLs. |
| Steering | Capability-negotiated `pi/steer` issues native RPC `steer` during an active turn. `pi/follow_up` explicitly queues native RPC `follow_up`. Neither is inferred from a second ACP prompt. Each takes `{sessionId, message}` and returns `{accepted: true}`. |
| Usage | Prompt results sum actual assistant message usage receipts across continuations. Input, output, cache reads/writes, total tokens and provider-reported cost have provenance. Context-window occupancy is not billed usage. No receipt means no usage assertion. |
| Retry and compaction | Upstream retry/compaction notices are retained. `agent_settled`, rather than a transient `agent_end`, settles a prompt. A final provider error remains a failed prompt and does not become successful completion. |
| Images | Upstream ACP image prompt blocks are passed to native Pi RPC. Model-specific image support still requires live qualification. |
| Cancellation and death | Cancellation expires live UI waits and calls native abort. Pi process exit rejects pending RPC requests and all active/queued turns. Partial RPC frames, oversized frames, and malformed JSON fail closed. |
| Fork, durable goal, native plan | Unavailable. Do not advertise Codex parity for these features. |

`initialize` advertises `_meta.paperclipPi.version = 1`, `steering`,
`queuedFollowUp`, the four question methods, `nativePermissions`, `promptUsage`,
`nativePlan: false`, and `pendingRequestRecovery: "live-process-only"`. The common
host must inspect this advertisement before sending provider extension requests.

## Lifetime and recovery

A provider UI request is a live Pi RPC promise. Paperclip's durable interaction
can survive a control-plane connection loss while the runner, wrapper, and Pi
process remain alive. A response is forwarded once to that exact pending request.
If Pi or the wrapper dies, the interaction must expire; neither a new process nor
a loaded JSONL session has the original promise. Do not replay an approval into a
replacement process. Normal conversation continuation can load the private JSONL
session after a separately admitted restart.

The wrapper attaches a per-turn generation to settlement work, fails queued
turns on provider death, and bounds RPC request waits. This does not constitute a
claim of generic provider-process handoff or exactly-once external side effects.

## Verified launch and packaging contract

The wrapper rejects ambient launch unless `PAPERCLIP_ACPX_ISOLATED_CONTEXT=1`.
It executes an absolute bound Node executable with an absolute bound Pi CLI path,
without a shell or PATH lookup. The common command lease must supply:

- `PAPERCLIP_PI_NODE_EXECUTABLE`, `PAPERCLIP_PI_ENTRYPOINT`, and
  `PAPERCLIP_PI_EXTENSION_PATH`: files in the immutable private provider snapshot.
- `PI_CODING_AGENT_DIR`: isolated persisted session/auth/settings home.
- `PAPERCLIP_PI_READ_ONLY`: exactly `0` or `1`.
- `PAPERCLIP_PI_READ_ROOTS` and `PAPERCLIP_PI_PROTECTED_ROOTS`: JSON arrays of
  absolute allowed skill/read roots and protected runtime/config roots. Assigned
  skills must use a separate immutable lease outside the protected runtime and
  executable roots; overlapping roots fail admission. Skill roots are always
  immutable, even when nested inside a writable workspace.
- `PAPERCLIP_PI_SYSTEM_INSTRUCTIONS`: admitted instructions, bounded to 32 KiB.

The wrapper synthesizes `PAPERCLIP_PI_RUNTIME_CONFIGURATION` for its child,
including only session-bound MCP servers. The owned extension captures and deletes
this configuration environment variable before model shell execution. Credentials
remain accessible only through the deliberately admitted runtime mechanisms.

Pi starts with `--no-extensions --no-skills --no-prompt-templates --no-themes
--no-approve --offline`, followed by the explicit immutable extension and admitted
skill paths. Project trust is denied; user-bash RPC and terminal login are disabled.
Only the controlled `/compact`, `/session`, and `/autocompact` slash commands are
accepted. Startup package update checks are disabled.

Pi can continue after a broken extension. Therefore the wrapper probes
`get_commands` and requires the exact readiness sentinel
`paperclip-runtime-ready-v1` / `Paperclip runtime gate v1`. The extension registers
this command only after gates and every MCP catalog finish initialization. A
missing sentinel kills the subprocess before the first model prompt.

`pi-verified-runtime.ts` inventories and checks the complete graph, including
Node, wrapper helper, extension, package metadata, native libraries, WASM and
resources. The manifest schema is `paperclip.pi-runtime-files.v1`, with relative
`node`, `piEntrypoint`, `extension`, `wrapperEntrypoint` fields and a complete
`files` array of SHA-256-bound regular files or contained relative symlinks.
Hardlinked files, escaping links, changed files, and undeclared files fail
admission. Its verifier returns the three launch environment bindings and a
manifest digest. Admission verification alone is not a command lease: the shared
host must retain its immutable snapshot and process guardian through termination.

The published Pi package has a shrinkwrap and a nested dependency graph. Provider
pack creation must copy the complete installed graph and use the same pinned Pi
family dependencies, rather than reconstructing the graph from `cli.js` imports.
The emitted `dist/drivers/acpx/pi-runtime-extension.js` must be included in every
macOS arm64/x64 and Linux x64 pack. The wrapper's `dist/paperclip-runtime.js` is
part of its verified package and must never be omitted from a copy or hash.

## Verification and maintenance

The three colocated Vitest suites exercise questions, permissions, timeouts,
framing, usage, file policies, MCP behavior, and graph verification. The Node test
`test/pi-acp-package-contract.test.mjs` launches the actual patched npm wrapper
against a deterministic RPC fixture. It proves initialization, streaming,
terminal usage, question versus permission routing, explicit steering, provider
exit, required sentinel, and typed failure settlement. It requires the exact
installed pinned package; an absent or unpatched dependency is a failure.
`PAPERCLIP_TEST_PI_ACP_PACKAGE` can select a separately installed pinned fixture.
These fixtures invoke no model or paid API.

A no-key probe against the real Pi 0.84.2 CLI loaded the compiled owned extension
and returned the exact readiness command. This checks the extension ABI and
explicit loading path. It does not prove authenticated inference, native tool
execution, MCP model invocation, credential renewal, or remote sandbox behavior.
Those remain required local and Daytona qualification evidence under the shared
live-spend cap. No live inference spend was incurred by these deterministic tests.

The helper in `patches/pi-acp@0.0.33.patch` is generated from
`src/drivers/acpx/pi-acp-runtime.ts` with Node `stripTypeScriptTypes`, trimming
trailing whitespace. The package contract checks that these bytes match. When
updating the upstream version, rebase the wrapper patch and rerun the actual
package tests; do not preserve an old qualified command hash after changing bytes.

Primary references reviewed:

- [Harness priorities report](https://pages.paperclip.ing/2026-09-25-harness-priorities/report.md)
- [pi-acp source](https://github.com/svkozak/pi-acp)
- [Pi RPC protocol](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md)
- [Pi extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [ACP protocol and SDK](https://github.com/agentclientprotocol/typescript-sdk)
