# Quality and readiness workflow

## Fast feedback

After editing, run `npm run quality:fast`, `npm run docs:check`, and the affected
Vitest project (`npm run test:quality -- --project <native-web|server|web|plugin>`).
The original Node tests remain authoritative for the existing product surface.
New code uses `*.spec.ts` / `*.spec.mjs` for Vitest; never import a `node:test`
file into Vitest.
Native Vitest files live in `apps/native-web/tests/`, outside the directory
copied by the protected release packager.

`npm run test:list` uses runner-native collection. It imports declarations but
does not execute test bodies, start test HTTP servers, or generate presentations.
Tests create listeners and fixtures inside hooks/test bodies. Tests use ephemeral
loopback ports and their own temporary directories.

`npm run test:coverage` gates each explicitly listed critical interface at 80%
lines, statements, functions and branches. The include list is in
`vitest.config.mjs`. This is **not** whole-product coverage. Expand the include
list when adding a new critical module; do not lower thresholds to pass a change.
The original native editor has much broader Node/browser regression suites.

## Visible historical debt

`config/*-baseline.json` records existing debt rather than excluding entire
directories or disabling rules. Source quality blocks files above 500 nonblank
lines and functions above complexity 20 unless that exact historical exception
exists. Historical exceptions may shrink but not grow. Duplication gates the
absolute cloned line count independently for each of four apps. Dependency use
is measured by Knip; known dynamic-loading false positives are retained in the
report. New findings fail.

Version drift compares dependency declarations across root, all packages, all
apps and the standalone plugin. Existing React 18/19, TypeScript 5/6 and Harness
adapter constraints remain explicit exceptions. Do not flatten incompatible
client dependencies to make a report look clean.

TODO/FIXME/HACK additions must link a ticket, for example
`TODO(OOP-123): ...` or `TODO(https://...): ...`. Existing markers are inventoried.
The label taxonomy is in `config/issue-labels.json`; it is a local specification,
not a claim that remote Feishu/GitHub labels or backlog have been changed.

For a justified baseline change: identify the findings, explain why the change
is unavoidable, get reviewer agreement and edit only those entries. The
`--record-baseline` switches are bootstrap/measurement tools, **not** the normal
fix for a failed gate. Include the debt/exception diff in review.

## Builds, bundles and docs

`npm run build:tracked` builds native and legacy workspaces, retains the last 30
stage timings and uses TypeScript incremental build state. Add `-- --with-plugin`
only when the external Harness client-build adapter is available. The root
lockfile supports `npm ci`; the standalone plugin remains outside npm workspaces.

`npm run quality:bundles` measures gzip bytes for built legacy web and standalone
plugin JS/CSS, reports largest assets and enforces `config/bundle-budgets.json`.
Use `-- --web-only` in a portable environment without the Harness client adapter.
Missing outputs fail rather than silently passing.

`npm run docs:generate` writes the three OpenAPI documents and route tables from
`scripts/quality/api-contracts.mjs`; `npm run docs:check` rejects stale output.
Legacy coverage includes all five documented routes; native and Host cover the
listed critical interfaces, not every internal route. Change the contract with
the handler, and verify actual request/response shapes.

`npm run release:notes -- <base-ref> <head-ref>` writes a local draft from commit
subjects to `output/release-notes.md`. Review it before publishing. It neither
changes release CI nor creates a remote release.

## Security and CI

`npm run quality:security` asks npm's advisory service about dependency metadata.
It sends package names/versions, not credentials or presentation content. New
advisories, critical findings and expired security exceptions fail. The temporary
30-day RC2 compatibility exception does not mean inherited vulnerabilities are
fixed; see `config/security-baseline.json`.

Renovate is configured to wait seven days before normal dependency updates,
without automerge. Harness/workspace releases require an explicit compatibility
review. Activation and actual update PRs require the maintainer to enable
Renovate. A config file alone is not evidence that update PRs are being created.

The separate `Readiness quality` workflow retains JUnit, duration/retry history,
coverage, advisory, duplication, dependency and bundle reports for 14 days.
Retries are measured, and any retried test makes the quality gate fail even if
the second attempt passes. No blanket quarantine or silent flaky pass is used.
Native/legacy product CI and release CI are unchanged. New workflow/config files
remain local until the maintainer publishes them; remote CI activation and
branch protection need separate authorization.
