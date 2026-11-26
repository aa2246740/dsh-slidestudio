# Canonical slide tools (`@open-slidestudio/slides-tools`)

`packages/slides-tools` is the single, host-agnostic definition of every DSH
SlideStudio product tool. The DSH Hub run consumes it now; the MCP server
(Phase 2C-2) and the core agent loop (Phase 3A) consume the same definitions.
The package has **no host SDK dependency**: a unit test fails on any
`@deepseek-ai/*` reference in `src/**` or `package.json`.

## Contract

| Type                  | Meaning                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `SlideCaller`         | `{ kind: "hub-run" \| "mcp" \| "editor-human", id, label? }`                                                   |
| `SlideToolContext`    | `{ projectId, projectRoot, callId, signal?, caller, sessionId?, acceptsImageContent? }`                        |
| `SlideContentBlock`   | text, or a neutral image `{ data: Uint8Array, mediaType, width?, height?, name? }`                             |
| `SlideToolResult`     | `{ data, content?, isError?, onContentDelivered? }`                                                            |
| `SlideToolDefinition` | `{ name, description, inputSchema (JSON Schema), readOnly, render, validate?, execute(args, ctx) }`            |
| `PostTurnHook`        | optional overlay seam run after a host turn; core registers none and `runPostTurnHooks` contains hook failures |

`createSlideTools(deps)` builds the 29 canonical tools (the 28 product tools
plus `open_in_editor`). `listCanonicalSlideTools()` and `toolSchemasSnapshot()`
expose the contract for inspection; `fixtures/tool-schemas.v1.json` freezes it.
Hosts inject ports through `SlideToolRuntimeDeps`: the presentation-run domain,
a JSON Schema validator, a capability snapshot, a project port for
`open_project`, and an optional media-credential refresher.

Images never leave a tool as host attachments. A tool returns neutral image
blocks; the DSH adapter saves them with `attachments.saveImage`, the MCP server
encodes them as `ImageContent`, and the core loop passes them to its LLM port.
`sharp` is optional and loaded lazily (`image-codec.ts`); without it the image
overview and template-photo paths return a typed `image_codec_unavailable`
refusal instead of failing startup.

## Single-writer lease

`project-lease.ts` persists `<projectRoot>/_agent/writer-lease.v1.json` under a
dedicated cross-process lock (`<projectRoot>/_agent/.pptd-write.lock`), so lease
heartbeats and releases never stall behind multi-file PPTD saves. Every mutating
tool (`readOnly: false`) acquires or renews the lease for `ctx.caller` after
argument validation and before any disk change; read-only tools never touch it.

- Another active owner → `{ outcome: "lease-conflict", holder }`, no mutation.
- TTL expiry, or a dead same-host process, lets the next owner take over.
- `editor-human` preempts an active `mcp` holder. The MCP owner then fails
  closed with `lease-preempted-by-editor` until the editor releases **and** it
  re-acquires explicitly (`reacquire: true`), so it re-reads the human's edits.
- `editor-human` and `hub-run` never preempt each other.

## DSH wrapper

`packages/dsh-slides-host/src/tools.ts` is a thin bridge. It maps
`exec.agent.id` to `SlideToolContext` (`caller: { kind: "hub-run", id:
"hub-run:<session>" }`), validates with the DSH JSON Schema validator before
resolving the project binding, converts `SlideToolArgsError` to DSH
`ToolArgsError`, and delivers neutral images through the attachments service.
The rc.2/rc.5 compatibility layer (`registerToolWithWhen`, step visibility,
`restrictGlobalToolsCompat`, produce-header patching) is unchanged. The Hub
embeds the editor, so `open_in_editor` is not registered for Hub runs.
Moved host modules (`write-page`, `edit-elements`, `runtime`, `receipts`, …)
remain as re-export shims so existing imports keep working.
