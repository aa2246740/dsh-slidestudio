# Slides MCP server (`@open-slidestudio/slides-mcp`)

`packages/slides-mcp` exposes the canonical slide tools from
[`@open-slidestudio/slides-tools`](slides-tools.md) to any MCP host (Claude Code,
Codex, Antigravity, DSH). It adds no second tool contract: `tools/list` returns
`createSlideTools(...)` unchanged plus three MCP-only tools. Runtime dependencies are
Node built-ins and the core workspace packages `pptd-v2`, `presentation-run` and
`slides-tools`; a unit test fails on any `@deepseek-ai/*` or native image codec
reference in `src/**` or `package.json`.

External agents follow [`skills/slidestudio/SKILL.md`](../../skills/slidestudio/SKILL.md).

## Modules

| Module                   | Role                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `jsonrpc.ts`             | JSON-RPC 2.0 classification, error codes, wire parsing                                 |
| `session.ts`             | `initialize` / `ping` / `tools/list` / `tools/call`, notifications, lease lifecycle    |
| `server.ts`              | shared presentation runtime and session registry (`createSlidesMcpServer`)             |
| `schema-validator.ts`    | zero-dependency JSON Schema validator passed as `SlideToolRuntimeDeps.validateSchema`  |
| `project-port.ts`        | `SlideProjectPort` for `open_project`, `bind_project` resolution, run binding          |
| `import-material.ts`     | `import_material` path policy and materialization                                      |
| `material-derivative.ts` | pure-JS `material-derivative/v1` builders (text, csv/tsv, PNG/JPEG)                    |
| `mcp-tools.ts`           | `bind_project`, `reacquire_lease`                                                      |
| `content.ts`             | `SlideToolResult` → `CallToolResult` (text, `ImageContent`, `--no-images` degradation) |
| `instructions.ts`        | `initialize.instructions` derived from `SLIDES_DIRECTOR_PERSONA_LINES`                 |
| `transport-stdio.ts`     | newline-delimited JSON-RPC over stdin/stdout                                           |
| `transport-http.ts`      | loopback Streamable HTTP (`POST`/`DELETE /mcp`)                                        |
| `cli.ts`, `config.ts`    | `slides-mcp` binary and argument parsing                                               |

## Protocol

- Protocol versions `2025-03-26` and `2024-11-05`: a supported requested version is
  echoed, anything else gets `2025-03-26`. Capabilities: `{ tools: { listChanged: false } }`.
- `instructions` are the director persona with the DSH-only `ask_user_question`
  lines replaced: an external agent asks its user directly in the host conversation.
- Notifications never get a response; `notifications/cancelled` aborts the call's signal.
- Argument violations (`SlideToolArgsError`, from the shared validator) return a tool
  result with `isError: true` and `{ error: "invalid_arguments", violations }`; an
  unknown tool or non-object arguments is JSON-RPC `-32602`. A project tool called
  before `open_project`/`bind_project` returns `project_not_bound`.
- The validator words violations like the DSH validator so the shared localizers
  (`localizePlanArgIssues`) apply unchanged. `minItems`/`maxItems` stay annotations,
  as for DSH, so every host accepts the same arguments.

## Projects

Every session is one caller `{ kind: "mcp", id: "mcp:<sessionId>", label }`; the label
is `initialize.clientInfo` (`name@version`) unless `--client-label` fixes it.

- `open_project` stages a fresh project in a hidden sibling directory
  (`<dataRoot>/output/dsh-slices/.staging-mcp-*`), runs `createEmptyProject`,
  writes `_agent/presentation-run.v1.json`
  (`provider: { providerId: "mcp", modelId: <label>, ready: true, modelInputModalities }`,
  `["text","image"]` or `["text"]` with `--no-images`), acquires this session's
  writer lease, and initializes `_agent/runtime.json` and the run ledger before
  atomically renaming the directory to `mcp-<10 hex>/` and hydrating the run. A
  failed setup removes the hidden staging directory; rollback of a published
  directory checks the lease lock first and never deletes a project already held
  by an active foreign writer. The result adds `projectId` and `editorUrl`.
- `bind_project { projectId }` accepts only a folder name below `output/dsh-slices/`
  whose canonical path stays there and that loads as PPTD. The lease is taken first;
  on `lease-conflict` nothing on disk changes. It then records the MCP provider on the
  run binding (creating one if missing) and keeps the binding's `sessionId`, so
  receipts and context epochs continue the project's run.
- `ctx.projectId` is the data-root-relative path (`output/dsh-slices/<id>`), the value
  the native editor accepts as `?project=`.

## Writer lease

Mutating canonical tools take the lease through the shared upfront gate and
re-verify ownership inside the project write lock (`<projectRoot>/.pptd-write.lock`)
and inner lease lock (`<projectRoot>/_agent/.pptd-write.lock`) around each disk
commit: presentation-run domain mutations (including `render_page` raster PNG and
ledger writes, `search_image`/`generate_image` media saves, `export_deck` publish,
and `_mark_image_emitted` image-delivery ledger writes via
`CommandContext.runAuthorizedWrite`), post-commit tool receipts and component-use
facts, `batch_remove_footers`, and `import_material` manifest/file writes
(`bind_project` acquires the lease and updates `_agent/presentation-run.v1.json`
under the lease lock).
Each locked commit re-checks the lease atomically. If `editor-human` preempts
the session before a primary locked commit begins or while it waits for the
lock, that primary commit fails closed and returns `lease-preempted-by-editor`
without writing further files or ledger entries; earlier locked commits in a
multi-step tool (such as a `render_page` PNG written before its ledger commit)
remain on disk. If preemption happens after a primary commit already succeeded
and before a post-commit side effect (the `dsh-tool-receipts.v1.json` tool
receipt or `recordComponentUses`), that side effect is skipped silently without
writing while the already-committed primary outcome (for example `write_page`
returning `written`) is still returned. The session records every root it holds;
stdio EOF, broken-pipe exit, SIGINT/SIGTERM, HTTP `DELETE /mcp` and HTTP server
`close()` release them with `releaseProjectLease(root, ownerId)`, which never
removes another owner's lease. After preemption, `reacquire_lease` calls
`acquireProjectLease(..., { reacquire: true })`, fails closed while the editor
still holds the project, and tells the agent to `read_page` before editing.

## `import_material`

Disabled unless the operator passes `--allow-import-root <dir>` (repeatable) or
`SLIDESTUDIO_MCP_IMPORT_ROOTS` (path-delimiter list); otherwise
`import_roots_not_configured`. Validation and commit run in three stages:

- **Before acquiring the writer lease** (`resolveImportPath`): path must be
  absolute, is canonicalized with `realpath` and must stay strictly inside a
  canonical allowed root (refusing `..` and symlink escapes), must stat as a
  regular file `<= MATERIAL_MAX_ORIGINAL_BYTES`, and must have a supported
  extension. Failures return immediately without touching the project or
  acquiring/renewing the writer lease.
- **After the upfront lease gate, outside the project locks**: `resolveImportPath`
  is re-checked, then the file is opened through a single descriptor
  (`O_NOFOLLOW`), re-checked for regular-file type, size, UTF-8/JSON/CSV/PNG/JPEG
  format validity, and image size limit (images over 70 % of
  `MATERIAL_MAX_ORIGINAL_BYTES` are refused because the derivative embeds the
  normalized copy as base64), and the derivative is prepared in memory.
- **Inside `withProjectWriteLock` + `withProjectLeaseLock`**: the writer lease is
  re-verified before committing the material files and
  `_agent/materials/manifest.json`, so editor preemption during file reading
  leaves the project's material files and `_agent/materials/manifest.json`
  unchanged (only `_agent/writer-lease.v1.json` reflects the earlier upfront
  renewal and the editor's preemption record).

Accepted formats build a `PreparedMaterial` that `writeSessionMaterials` writes exactly
like an editor upload: `_agent/materials/<id>/original.*`, `derivative.json`
(`material-derivative/v1`), `receipt.json`, the manifest entry, and for images
`media/` plus `normalized.jpg`. The id is `mcp-<first 16 hex of the sha256>`, so a
re-import of the same bytes replaces the entry. `.txt`/`.md`/`.json` are UTF-8 text
(JSON must parse), `.csv`/`.tsv` are `csv-v1` tables re-read from the original, and
`.png`/`.jpg`/`.jpeg` record their measured size. No codec runs: an image's normalized
copy is the verified original (a PNG stays PNG), and `ImageContent.mimeType` is taken
from the bytes. The result is verified with `verifyMaterial` before it returns.

## Images

`SlideImageBlock`s become `{ type: "image", data: <base64>, mimeType }`. A result's
`onContentDelivered` is handed to the transport and runs only after the response was
written (stdio write callback, HTTP `finish`). With `--no-images` images are dropped
with a text note, the hook never runs, and the project route is text-only, so
`view_material` refuses with `vision_unavailable`.

## Transports

- stdio: one session; partial lines are buffered, several lines per chunk are handled
  in order, lines over 4 MiB are refused, and stdout carries only JSON-RPC.
- HTTP: binds only to `127.0.0.1`, `localhost` or `::1`. `Host` must be loopback and a
  present `Origin` a loopback origin (403 otherwise). An optional bearer token is
  compared with `crypto.timingSafeEqual` (401). Bodies over 4 MiB get 413. `initialize`
  must be sent alone and returns `Mcp-Session-Id`; later requests need a live id (400
  missing, 404 unknown). Notification-only posts get 202, batches are answered in
  order, `GET` is 405 (no SSE stream), other paths 404.

## DSH registration

With the `mcp_register` flag (default off) the DSH plugin calls
`ctx.get("mcpManager").register("slidestudio", { transport: "stdio", command:
process.execPath, args: [cli, "--data-root", dataRoot, "--editor-url", editorOrigin],
cwd: repoRoot })` inside `ctx.effect`, preferring the bundled
`node_modules/@open-slidestudio/slides-mcp/dist/cli.js`. Because DSH rc.5 parses
`${...}` in stdio strings as credential templates, `dataRoot`/`editorOrigin`/`repoRoot`
paths containing `${...}` are passed via base64url `--config-b64` with `cwd` omitted;
if `command` or `cli` itself contains `${...}`, registration fails closed
(`mcp_register_template_path_refused`) so no credential template is ever expanded.
DSH rc.2 (no manager or no `register`) logs `mcp_manager_unavailable`; a missing CLI
logs `slides_mcp_cli_missing`; a register failure (for example a user server with the
same name) logs `mcp_register_failed`. None of them blocks the plugin. The effect
disposer removes the registration.

## Tests

`npm test -w @open-slidestudio/slides-mcp` runs offline: purity and SKILL.md sync,
protocol and content mapping, a child-process stdio session (imports, fail-closed
paths, framing, EOF and SIGTERM lease release), loopback HTTP (sessions, images,
`--no-images`, Host/Origin, token, bind host, 413, `DELETE`), editor preemption
recovery, and the full offline chain through `export_deck` with synthetic rasters
standing in for the editor render (`SLIDESTUDIO_PLAYWRIGHT_RUNTIME` points at a
missing runtime so no browser starts).
