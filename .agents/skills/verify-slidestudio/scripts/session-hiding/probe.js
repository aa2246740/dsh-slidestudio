// Session-hiding probe: exercises the Work-sidebar hiding path against a real
// Host's workspaceRegistry and sessionQuery. Injected into the boot patch by
// run.mjs; reads OPEN_SLIDESTUDIO_ROOT for the built host module and PROBE_CWD
// for a writable pool directory. No model calls — sessions are created and
// disposed, never stepped.
export const name = "dps-probe-sessions";
export const inject = ["agents", "workspaceRegistry", "sessionQuery"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);

export async function apply(ctx) {
  const mod = await import(
    `file://${process.env.OPEN_SLIDESTUDIO_ROOT}/packages/dsh-slides-host/dist/session-workspace.js`
  );
  const { slidesSessionMeta, hideSlidesSessions, LegacySessionHider, SLIDES_WORKSPACE_TITLE } = mod;
  const poolCwd = `${process.env.PROBE_CWD}/output/dsh-slices`;
  ctx.effect(() => {
    const run = async () => {
      await sleep(4000); // let the plugin's startup sweep finish on the fresh home
      const registry = ctx.get("workspaceRegistry");
      const query = ctx.get("sessionQuery");
      console.log(
        `[probe] services: registry=${typeof registry?.archiveSession} query=${typeof query?.listSessions}`,
      );
      const headers = async () => (await query.listSessions()).map((row) => row.header);

      const subId = `probe-sub-${RUN}`;
      const legacyId = `probe-legacy-${RUN}`;
      const agents = [];
      try {
        agents.push(await ctx.agents.create({ sessionId: subId, meta: slidesSessionMeta(poolCwd) }));
      } catch (e) {
        console.log(`[probe] subagent create failed: ${e?.message}`);
      }
      try {
        agents.push(
          await ctx.agents.create({ sessionId: legacyId, meta: { agentPreset: "slides", cwd: poolCwd } }),
        );
      } catch (e) {
        console.log(`[probe] legacy create failed: ${e?.message}`);
      }
      const subHeader = (await headers()).find((h) => h.id === subId);
      console.log(
        `[probe] subagent header origin=${subHeader?.origin} preset=${subHeader?.agentPreset}`,
      );

      // A legacy workspace registration holding only slides sessions must be removed by the sweep.
      try {
        const ws = await registry.create(poolCwd, SLIDES_WORKSPACE_TITLE);
        await ws.attachSession(legacyId);
      } catch (e) {
        console.log(`[probe] workspace seed failed: ${e?.message}`);
      }
      for (const handle of agents) await handle.dispose().catch(() => undefined);

      const res = await hideSlidesSessions(registry, await headers(), new Set(), new Set());
      console.log(
        `[probe] sweep archived=${res.archived} removedWorkspaces=${res.removedWorkspaces} failures=${res.failures.length}`,
      );
      const archived = () => registry.archivedSessionIds;
      console.log(
        `[probe] after sweep: legacy archived=${archived().includes(legacyId)} sub archived=${archived().includes(subId)}`,
      );
      console.log(
        `[probe] slides workspace gone=${!registry.list().some((w) => w.title === SLIDES_WORKSPACE_TITLE)}`,
      );

      const busy = new Set();
      const hider = new LegacySessionHider(registry ? () => registry : () => undefined, (id) =>
        busy.has(id));
      await hider.ensureRunnable(legacyId);
      console.log(`[probe] after ensureRunnable archived=${archived().includes(legacyId)}`);
      hider.onSettled(legacyId);
      await sleep(400);
      console.log(`[probe] after settle archived=${archived().includes(legacyId)}`);
      console.log("[probe] done");
    };
    run().catch((e) => console.log("[probe] fatal:", e?.message, e?.stack));
  });
}
