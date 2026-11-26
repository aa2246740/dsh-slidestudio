---
name: slidestudio
description: Build and edit editable PPTX slide decks with the DSH SlideStudio MCP server (slides-mcp). Use when the user asks an agent in Claude Code, Codex or Antigravity to create, continue, review or export a presentation through the slidestudio MCP tools.
---

# DSH SlideStudio over MCP

`slides-mcp` exposes the canonical DSH SlideStudio slide tools to any MCP host. Every
deck is a PPTD project on disk (`<data root>/output/dsh-slices/<projectId>/`) that the
native editor opens and `export_deck` turns into an editable PPTX. The server is the same
tool contract the DSH Hub uses; only project binding, file import and the writer lease
differ.

## Connect the server

Build once from the repository root (`npm run build:native`), then point your host at
`packages/slides-mcp/dist/cli.js`. `--data-root` is required and must be absolute.
`import_material` stays disabled until you allow at least one import directory.

### Claude Code (stdio)

```sh
claude mcp add slidestudio -- node /path/to/repo/packages/slides-mcp/dist/cli.js \
  --data-root /path/to/slidestudio-data --editor-url http://127.0.0.1:55200 \
  --allow-import-root /path/to/allowed/inputs
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "slidestudio": {
      "command": "node",
      "args": [
        "/path/to/repo/packages/slides-mcp/dist/cli.js",
        "--data-root",
        "/path/to/slidestudio-data",
        "--allow-import-root",
        "/path/to/allowed/inputs"
      ]
    }
  }
}
```

### Codex (`~/.codex/config.toml`, stdio)

```toml
[mcp_servers.slidestudio]
command = "node"
args = ["/path/to/repo/packages/slides-mcp/dist/cli.js", "--data-root", "/path/to/slidestudio-data"]
```

### Antigravity (`mcp_config.json`, stdio)

```json
{
  "mcpServers": {
    "slidestudio": {
      "command": "node",
      "args": ["/path/to/repo/packages/slides-mcp/dist/cli.js", "--data-root", "/path/to/slidestudio-data"]
    }
  }
}
```

### Loopback HTTP (any host that speaks Streamable HTTP)

```sh
node packages/slides-mcp/dist/cli.js --transport http --port 8765 \
  --data-root /path/to/slidestudio-data --auth-token "$SLIDESTUDIO_MCP_AUTH_TOKEN"
```

Connect to `http://127.0.0.1:8765/mcp` with `Authorization: Bearer <token>`. The server
binds only to `127.0.0.1`, `localhost` or `::1` and refuses requests whose `Host` or
`Origin` is not loopback. Use `--no-images` for hosts or models that cannot take image
content: images are then omitted with a text note and the project is marked text-only.

## Workflow

Follow this order; skip steps that do not apply.

1. `open_project` — create a new deck for this session, or `bind_project` with a
   `projectId` (folder name below `output/dsh-slices/`) to continue an existing one.
2. `inspect_capabilities` — use only the capabilities it reports.
3. `list_references` / `read_reference` — read every required chunk before planning.
4. `import_material` / `list_materials` / `read_material` (`view_material` when the
   model accepts images) — import the user's files, then read every part you rely on.
5. `commit_design` — commit the design and slide plan.
6. `write_todo` — list every pageId before writing it.
7. `write_page` — write each page.
8. `render_page` / `review_page` / `review_pages` — check what you wrote.
9. `compose_deck` — seal the deck in plan order.
10. `export_deck` — produce the editable PPTX.
11. `open_in_editor` — hand the user the native editor link.

## Rules (from the SlideStudio director persona)

- Write user-facing progress and explanations in the language of the user brief.
- Treat clear user instructions as authorization; do not ask for a second confirmation
  for a whole-deck edit or a reversible styling change.
- Never write YAML except through write_page.
- Pass every tool's declared fields directly at the top level; never wrap them in an
  arguments object.
- write_page elements use elementId, elementType, bounds [x,y,w,h], and content.text.
  Put fontSize, fontFamily, color, and align directly on content; content.style is only
  a string theme reference such as $title. Put layoutRole on the element.
- Charts are data.cols + data.rows and series[].type/encode.
- Never omit shape fill expecting a default; set an explicit fill.
- Use inspect_capabilities and the tools actually supplied for this session. Provider-hosted
  search or image tools are available only when explicitly supplied; do not infer them from
  a model name.
- Splitting a section into more pages is fine: update write_todo with the new pageIds
  before writing them; a page not in the todo is refused.
- Do not reuse one src as another page's full-bleed.
- Never invent numbers or text a material did not return; compute table figures with
  query_material.

## Asking the user

There is no `ask_user_question` tool over MCP. When a missing preference materially
affects the result, ask the user directly in your own conversation with concise options,
wait for the answer, then continue the same task. Never invent an answer or repeat a
cancelled question.

## Single-writer lease

Every write takes this session's writer lease on the project.

- `lease-conflict`: another writer (a Hub run or another MCP session) holds the project.
  Stop and tell the user.
- `lease-preempted-by-editor`: a human took the deck over in the native editor. Wait until
  they finish, call `reacquire_lease`, then `read_page` for every page you will touch
  before writing again. Plain writes keep failing until you re-acquire explicitly.
- Closing the session (stdin EOF, signal, HTTP `DELETE /mcp`) releases the lease.

## Importing files

`import_material` takes an absolute `path` inside a directory the operator allowed
(`--allow-import-root`, repeatable, or `SLIDESTUDIO_MCP_IMPORT_ROOTS`). Without one it
refuses with `import_roots_not_configured`. Symlinks and `..` are resolved before the check,
directories and oversized files are refused, and only `.txt`, `.md`, `.json`, `.csv`,
`.tsv`, `.png`, `.jpg` and `.jpeg` are accepted.
