# Local SlideStudio incident runbook

## Locate the affected checkout

Check the acceptance URL, checkout path and isolated Harness home. Reuse that
checkout's service. Do not stop another profile or remove user projects to fix a
port collision. Choose unused Hub/editor ports if starting a new checkout.

## Health and change impact

- Editor: `GET /api/health` on its loopback port.
- Host/provider readiness: `GET /slides/health` and `GET /slides/models`.
- Editor operational view: `GET /api/diagnostics`.
- Legacy API operational view: `GET /api/diagnostics` on port 8787 by default.
- Browser operational view: `window.slideStudioDiagnostics.snapshot()`
  on the native Hub/editor. Legacy web's dedicated logger retains the same
  categorical HTTP status/timing fields in memory.
- Plugin: structured `slidestudio-plugin` records in the affected Harness log.
- Build/test impact: `output/quality/build-history.json`,
  `test-health-history.json`, `tests.xml`, and `coverage/index.html`.

These are local operational views, not external deployment dashboards.
Compare request error classes, request duration and release/version metadata
before/after a restart. Counters reset on process restart; preserve only a
reviewed, sanitized snapshot when an incident needs one. No active paging or
central error tracker is currently configured.

## Startup or 502/503

1. Verify the correct `SLIDES_DSH_PORT` / `SLIDES_EDITOR_PORT` pair and isolated
   `.dsh/home`. A stale service path can fail before Node starts.
2. Run `npm run build:native`, and verify the pinned browser with
   `npm run setup:browser`. Do not download an arbitrary browser for evidence.
3. Inspect only the affected service log and request ID. Check the sidecar's
   health independently from the Host. The plugin waits for healthy startup and
   reports bounded failure instead of a blank iframe.
4. Restart only the affected checkout after recording its service identity.
   Leave it available for human acceptance.

## Provider failure or stalled generation

1. Check selected supplier/model readiness and produce gates.
2. Keep original user input and durable checkpoints. Never replace the result
   with a mock, template, old project or host-authored page.
3. Use existing stop/retry and rate-limit recovery. Do not copy OAuth grants or
   perform an external model call without explicit consent.
4. Reproduce HTTP/UI rules with a disposable synthetic project and offline tests.
   This proves the interface, not real provider generation.

## Unexpected 4xx/5xx or private data concern

1. Correlate the same `X-Request-ID` through browser, plugin and editor/Host hops.
2. 400 is invalid input, 403 rejected origin, 415 non-JSON mutation, 421
   unexpected host and 413 excessive body. Do not weaken those guards.
3. Legacy 500 responses expose only a request ID, not provider exception text.
   Use categorical fingerprints and a synthetic failing-adapter test.
4. If private data appears in evidence, stop sharing it and remove the affected
   agent-created evidence copy. Do not erase the original user project.

## Quality failure

Run the narrow affected test, fix the cause and rerun the failing gate. A retry
is tracked as flaky and blocks the quality gate. For inherited vulnerabilities,
review the expiring RC2 compatibility exception and plan a runtime migration.
Never regenerate all baselines merely to clear a failure.

## Profiling

`npm run profile:api` starts and stops its own disposable legacy API on an
ephemeral loopback port and saves a Node CPU profile under `output/profiles`.
It calls only diagnostics, not generation or providers. For native editor
profiling, launch a disposable copy with `node --cpu-prof
--cpu-prof-dir=output/profiles apps/native-web/src/server.mjs`, isolated data
and an unused port. Browser DevTools Performance captures local UI profiles.
CPU profiles may expose paths; review before sharing.
