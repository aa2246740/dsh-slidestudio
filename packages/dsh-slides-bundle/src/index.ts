import fs from "node:fs";
import path from "node:path";
import { OFFICIAL_VISUAL_ROW_IDS, KEPT_SHELL_ROW_IDS } from "./visual-rows.js";

export { OFFICIAL_VISUAL_ROW_IDS, KEPT_SHELL_ROW_IDS } from "./visual-rows.js";

export const DSH_PIN = {
  version: "0.2.0-rc.2",
  tag: "dsh-v0.2.0-rc.2",
  /** Upstream tag dsh-v0.2.0-rc.2 in github.com/deepseek-ai/deepseek-harness (git ls-remote). */
  commit: "639ed015397290b3745d163aafe02ffee4aa3f84",
  /** Registry pin evidence: package-lock `integrity` for the tarball below. */
  integrity: "sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==",
  tarball: "https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.0-rc.2.tgz",
} as const;

export const OAUTH_LOGIN_NOTE = {
  npmVersion: "0.1.9",
  localTree: "dirty",
  pin: false,
} as const;

export const SLIDES_PROFILE_BUNDLES = [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@open-slidestudio/dsh-slides-bundle",
] as const;

export type EntryLike = {
  readonly id?: string;
  readonly name?: string;
  readonly disabled?: boolean;
  readonly config?: Record<string, unknown>;
};

export class SlidesRowLawError extends Error {
  override readonly name = "SlidesRowLawError";
  constructor(
    readonly clause: string,
    detail: string,
  ) {
    super(`${clause}: ${detail}`);
  }
}

export function assertSlidesRowLaw(entries: readonly EntryLike[]): void {
  const byId = new Map<string, EntryLike>();
  for (const entry of entries) {
    if (entry.id) byId.set(entry.id, entry);
  }
  for (const id of OFFICIAL_VISUAL_ROW_IDS) {
    const row = byId.get(id);
    if (!row) {
      throw new SlidesRowLawError("visual-disabled", `${id} is missing from the composed tree`);
    }
    if (row.disabled !== true) {
      throw new SlidesRowLawError("visual-disabled", `${id} must be disabled`);
    }
  }
  for (const id of KEPT_SHELL_ROW_IDS) {
    const row = byId.get(id);
    if (!row) {
      throw new SlidesRowLawError("shell-kept", `${id} is missing`);
    }
    if (row.disabled === true) {
      throw new SlidesRowLawError("shell-kept", `${id} must stay enabled`);
    }
  }
  const host = byId.get("slides-host");
  if (host?.name !== "@open-slidestudio/dsh-slides-host") {
    throw new SlidesRowLawError("product-host", "slides-host row is missing");
  }
  const client = byId.get("slides-client");
  if (client?.name !== "@open-slidestudio/dsh-slides-client") {
    throw new SlidesRowLawError("unique-root", "slides-client row is missing");
  }
  if (client.disabled === true) {
    throw new SlidesRowLawError("unique-root", "slides-client must be enabled");
  }
  const model = byId.get("agent-default-model")?.config ?? {};
  const defaultProvider = typeof model.provider === "string" ? model.provider : "";
  const defaultModel = typeof model.model === "string" ? model.model : "";
  if (/antigravity|\bagy-/i.test(`${defaultProvider} ${defaultModel}`)) {
    throw new SlidesRowLawError("antigravity", "agent-default-model must not be Antigravity");
  }
  const providers = (byId.get("llm-pi-ai")?.config?.providers ?? {}) as Record<string, { apiKeyEnv?: string }>;
  for (const id of Object.keys(providers)) {
    if (/antigravity|\bagy-/i.test(id)) {
      throw new SlidesRowLawError("antigravity", `llm-pi-ai must not configure ${id}`);
    }
  }
  if (providers["minimax-cn"]?.apiKeyEnv !== "MINIMAX_CN_API_KEY") {
    throw new SlidesRowLawError("minimax-cn-route", "llm-pi-ai minimax-cn.apiKeyEnv must be MINIMAX_CN_API_KEY");
  }
  const presets = byId.get("agent-preset-registry")?.config ?? {};
  if (presets.default !== "slides") {
    throw new SlidesRowLawError("preset", "agent-preset-registry.default must be slides");
  }
  const presetRow = byId.get("preset-slides");
  if (presetRow?.name !== "@deepseek-ai/dsh-agent-preset") {
    throw new SlidesRowLawError("preset", "preset-slides declaration row is missing");
  }
  if (presetRow.config?.id !== "slides") {
    throw new SlidesRowLawError("preset", "preset-slides config.id must be slides");
  }
}

const UNPUBLISHED_WORKSPACE_PACKAGES = [
  "dsh-slides-bundle",
  "dsh-slides-host",
  "dsh-slides-client",
  "oss-oauth-login",
  "presentation-run",
  "slides-tools",
  "slides-runtime",
  "pptd-v2",
  "project-store",
  "exporter-native",
] as const;

export function writeSlidesProfile(home: string, repoRoot: string): string {
  const dir = path.join(home, "profiles", "slides");
  fs.mkdirSync(dir, { recursive: true });
  const fileDep = (pkg: string) => `file:${path.resolve(repoRoot, "packages", pkg)}`;
  const unpublishedDeps = Object.fromEntries(
    UNPUBLISHED_WORKSPACE_PACKAGES.map((pkg) => [`@open-slidestudio/${pkg}`, fileDep(pkg)]),
  );
  const manifest = {
    name: "dsh-profile-slides",
    private: true,
    type: "module",
    dependencies: {
      // The vendored pi-ai adapter carries the replay/completion patches the
      // OAuth login routes need; installing it inside this profile puts it
      // ahead of the shared profiles/node_modules symlink to the stock build.
      "@deepseek-ai/dsh-llm-pi-ai": `file:${path.resolve(repoRoot, "vendor", "dsh-llm-pi-ai")}`,
      // Top-level so npm resolves it by absolute path: oss-oauth-login's
      // nested "file:../../vendor/dsh-oauth-login" would otherwise resolve
      // against the install-links copy under profiles/*/node_modules.
      "dsh-oauth-login": `file:${path.resolve(repoRoot, "vendor", "dsh-oauth-login")}`,
      ...unpublishedDeps,
    },
    dsh: {
      profile: {
        bundles: [...SLIDES_PROFILE_BUNDLES],
      },
    },
  };
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const patchPath = path.join(dir, "cordis.patch.yml");
  if (!fs.existsSync(patchPath)) {
    fs.writeFileSync(
      patchPath,
      `# User overlay for the slides profile. Bundle patches live in dsh-slides-bundle.\n[]\n`,
    );
  }
  return dir;
}
