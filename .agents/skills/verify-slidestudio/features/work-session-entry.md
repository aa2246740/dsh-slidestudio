# PPT generation history in Work

New generation sessions use the stable slides data directory and the public Workspace registry.
In the Host's grouped sidebar, users can collapse “演示文稿 · SlideStudio”. Clicking a PPT session
shows its history and a single “在演示文稿中继续” action instead of the Work composer. That action
opens the session's bound project in Personal, or in the standalone slides panel when Personal
is absent. Ordinary Work sessions remain editable.

## Source

- `packages/dsh-slides-host/src/session-workspace.ts`: adopt only bound slides sessions at each
  immutable original cwd, reuse existing workspaces, continue when a legacy directory is missing.
- `packages/dsh-slides-host/src/plugin.ts`: register legacy sessions and attach each new session
  to the stable data workspace before its first model request.
- `packages/dsh-slides-host/src/agent-plane.ts`: refuse ordinary Work RPC input before the model;
  inspect only the newest user message so a later editor instruction still works.
- `dsh-slidestudio/src/client/index.tsx`: public `conversation.composer` chain and
  `SliceSessionSnapshot.binding.projectRoot` navigation, with optional `personal.open()`.

## Automated proof

```sh
npm run test -w @open-slidestudio/dsh-slides-host
npm run build --prefix dsh-slidestudio
npm run test:client --prefix dsh-slidestudio
```

The client test imports a real `SliceSessionStore` to create the response shape, then drives the
built bundle with mocked Host services in the shared pinned Chromium. It checks both destinations,
the exact project/session query, absence of a PPT Work text box, and an ordinary editable session.
Server tests exercise scoped Cordis input guards and workspace selection/failure handling. These
tests do not prove that an already running Host has loaded the updated server module.

## Native acceptance recipe

1. Record the running Host, installed versions, current workspace records and existing projects.
2. Install the package through the official manager. If it requires the next launch, complete
   the authorized original-launcher restart before claiming the backend migration passed.
3. Select “视图选项 → 按工作区分组”; inspect the PPT groups and confirm existing unrelated groups
   remain intact. Old immutable cwds may produce several groups; do not rewrite session logs.
4. Open a PPT history row: verify no ordinary composer and follow the action into the matching
   deck, checking title and page count. Open a normal Work session and verify its input remains.
5. Create a small real PPT through the installed plugin. Confirm its new session is attached to
   the stable data group, then follow its history action back into the same running/completed deck.
6. Save native screenshots and structured observations. Distinguish live model generation from
   the mocked client fixture and scoped server guard tests.

## Limits

The current public Host API has no per-plugin hidden-session switch. Flat view and search still
show these records. Workspace membership uses immutable cwd; old groups cannot be merged by
rewriting history. Older Personal releases without `open()` use the standalone panel fallback.
