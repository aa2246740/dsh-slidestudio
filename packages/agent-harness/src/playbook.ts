/**
 * Load open-kimi SKILL + design_system + slides_categories as a local playbook.
 * Content only — never executes export_pptx.py / official iframe.
 */
import fs from "node:fs";
import path from "node:path";
import { contrastRatio } from "@open-slidestudio/pptd-v2";
import { officialRecipesMarkdown } from "./playbook-recipes.js";

export const DEFAULT_DESIGN_SYSTEM = "consulting/pine-green-strategy";
export const DEFAULT_CATEGORY = "analysis-decision";

export type DesignSystemRef = {
  id: string;
  file: string;
};

export type Palette = {
  background: string;
  text: string;
  muted: string;
  primary: string;
  accent: string;
  danger: string;
};

export type PlaybookBundle = {
  skillRoot: string;
  designSystemId: string;
  categoryId: string;
  designMarkdown: string;
  categoryMarkdown: string;
  categoryGuideExcerpt: string;
  skillExcerpt: string;
  pptdExcerpt: string;
  recipesMarkdown: string;
  palette: Palette;
};

const SKILL_REL = path.join("vendor", "open-kimi-ppt", "skill-1.2.0", "skills", "open-kimi-ppt");

export function resolveSkillRoot(start = process.cwd()): string {
  const env = process.env.SLIDESTUDIO_SKILL_ROOT;
  if (env && fs.existsSync(path.join(env, "SKILL.md"))) return path.resolve(env);

  let dir = path.resolve(start);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, SKILL_REL);
    if (fs.existsSync(path.join(candidate, "SKILL.md"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "open-kimi skill not found (expected vendor/open-kimi-ppt/skill-1.2.0/skills/open-kimi-ppt). Set SLIDESTUDIO_SKILL_ROOT.",
  );
}

export function listDesignSystems(skillRoot: string): DesignSystemRef[] {
  const root = path.join(skillRoot, "reference", "design_system");
  const found: DesignSystemRef[] = [];
  if (!fs.existsSync(root)) return found;

  for (const group of fs.readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    // named folders: consulting/pine-green-strategy/design.md
    const groupDir = path.join(root, group.name);
    for (const child of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const design = path.join(groupDir, child.name, "design.md");
      if (fs.existsSync(design)) {
        found.push({ id: `${group.name}/${child.name}`, file: design });
      }
    }
  }
  found.sort((a, b) => a.id.localeCompare(b.id));
  return found;
}

/** Hub tile slugs that are not playbook folder ids. */
const DESIGN_ALIASES: Record<string, string> = {
  "finance/indigo": "consulting/indigo-due-diligence",
  indigo: "consulting/indigo-due-diligence",
  "consulting/moss-green": "consulting/moss-green-transformation",
  "moss-green": "consulting/moss-green-transformation",
  "consulting/color-bars": "consulting/pine-green-strategy",
  "color-bars": "consulting/pine-green-strategy",
  "finance/fresh-brand": "finance/honey-orange-memo",
  "fresh-brand": "finance/honey-orange-memo",
  "work/lead-grey": "work/warm-jade-annual-report",
  "lead-grey": "work/warm-jade-annual-report",
  "lead-gray": "work/warm-jade-annual-report",
  "promo/orange-tech": "promotion/cream-collage",
  "orange-tech": "promotion/cream-collage",
  "academic/meridian": "academic/paper-white-courseware",
  meridian: "academic/paper-white-courseware",
};

export function resolveDesignSystemFile(skillRoot: string, id: string): string {
  const systems = listDesignSystems(skillRoot);
  const raw = String(id || "").trim();
  const aliased = DESIGN_ALIASES[raw] || DESIGN_ALIASES[raw.split("/").pop() || ""];
  const wanted = aliased || raw;
  const exact = systems.find((s) => s.id === wanted);
  if (exact) return exact.file;
  const slug = wanted.split("/").pop() || wanted;
  const tail = systems.find((s) => s.id.endsWith("/" + slug) || s.id.split("/")[1] === slug);
  if (tail) return tail.file;
  const fuzzy = systems.find((s) => {
    const name = s.id.split("/")[1] || s.id;
    return name.startsWith(slug + "-") || name.includes(slug);
  });
  if (fuzzy) return fuzzy.file;
  throw new Error(
    `design system not found: ${id}. Known: ${systems
      .slice(0, 12)
      .map((s) => s.id)
      .join(", ")}…`,
  );
}

/** Pull a usable 6-color palette from a design.md hex soup. */
export function extractPalette(markdown: string): Palette {
  const hexes = [...markdown.matchAll(/#([0-9A-Fa-f]{6})\b/g)].map((m) => `#${m[1]!.toUpperCase()}`);
  const unique = [...new Set(hexes)];
  const scored = unique.map((hex) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    let hue: "red" | "green" | "blue" | "neutral" | "other" = "other";
    const span = Math.max(r, g, b) - Math.min(r, g, b);
    if (span < 24) hue = "neutral";
    else if (g >= r && g >= b) hue = "green";
    else if (b >= r && b >= g) hue = "blue";
    else if (r >= g && r >= b) hue = "red";
    return { hex, lum, sat, hue };
  });

  const lights = scored.filter((c) => c.lum > 0.85).sort((a, b) => b.lum - a.lum);
  const structural = scored
    .filter((c) => c.lum < 0.38 && c.sat > 0.15 && (c.hue === "green" || c.hue === "blue"))
    .sort((a, b) => a.lum - b.lum);
  const darks = scored.filter((c) => c.lum < 0.35 && c.sat > 0.15 && c.hue !== "red").sort((a, b) => a.lum - b.lum);
  const accents = scored
    .filter((c) => c.lum >= 0.35 && c.lum <= 0.75 && c.sat > 0.25 && c.hue !== "red")
    .sort((a, b) => b.sat - a.sat);
  const midGray = scored.filter((c) => c.sat < 0.12 && c.lum > 0.25 && c.lum < 0.55).sort((a, b) => a.lum - b.lum);
  const reds = scored.filter((c) => c.hue === "red" && c.sat > 0.3).sort((a, b) => b.sat - a.sat);

  const label = (re: RegExp): string | undefined => {
    const m = markdown.match(re);
    return m ? `#${m[1]!.toUpperCase()}` : undefined;
  };
  const labeledAccent =
    label(/Primary gold\s+#?([0-9A-Fa-f]{6})/i) ??
    label(/Copper brown\s+#?([0-9A-Fa-f]{6})/i) ??
    label(/Primary accent\s+#?([0-9A-Fa-f]{6})/i) ??
    label(/secondary accent\s+#?([0-9A-Fa-f]{6})/i);
  const labeledDark = label(/Dark background\s+#?([0-9A-Fa-f]{6})/i);
  const labeledTitle = label(/Title color\s+#?([0-9A-Fa-f]{6})/i) ?? label(/\btitles?\s+#?([0-9A-Fa-f]{6})/i);

  const isCream = lights[0] ? lights[0].hex !== "#FFFFFF" : false;
  const background = lights[0]?.hex ?? "#FFFFFF";
  const text = midGray[0]?.hex ?? "#333333";
  const primaryCandidate =
    labeledTitle ??
    structural[0]?.hex ??
    darks[0]?.hex ??
    labeledDark ??
    (isCream && labeledAccent ? labeledAccent : "#03522C");
  const primary =
    [primaryCandidate, labeledTitle, structural[0]?.hex, darks[0]?.hex, labeledDark, text, "#111111", "#FFFFFF"].find(
      (candidate): candidate is string => Boolean(candidate && contrastRatio(candidate, background) >= 4.5),
    ) ?? (contrastRatio("#111111", background) >= contrastRatio("#FFFFFF", background) ? "#111111" : "#FFFFFF");
  const accent = labeledAccent && labeledAccent !== primary ? labeledAccent : (accents[0]?.hex ?? "#29B974");

  const mutedCandidate = midGray[1]?.hex ?? "#7E7E7E";
  const muted =
    contrastRatio(mutedCandidate, background) >= 4.5
      ? mutedCandidate
      : contrastRatio(text, background) >= 4.5
        ? text
        : contrastRatio("#111111", background) >= contrastRatio("#FFFFFF", background)
          ? "#111111"
          : "#FFFFFF";
  return {
    background,
    text,
    muted,
    primary,
    accent,
    danger: reds[0]?.hex ?? "#E71C56",
  };
}

function skillExcerpt(skillRoot: string): string {
  return fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
}

function pptdExcerpt(skillRoot: string): string {
  return fs.readFileSync(path.join(skillRoot, "reference", "pptd.md"), "utf8");
}

const NEUTRAL_PALETTE: Palette = {
  background: "#FFFFFF",
  text: "#1B1A17",
  muted: "#6B6560",
  primary: "#1B1A17",
  accent: "#C45C26",
  danger: "#B42318",
};

/** Catalog-only playbook. Host did not pick a named system or category. */
export function catalogOnlyPlaybook(skillRoot = resolveSkillRoot()): PlaybookBundle {
  const systems = listDesignSystems(skillRoot);
  const catalog = systems.map((row) => `- ${row.id}`).join("\n");
  const guideFile = path.join(skillRoot, "reference", "slides_categories.md");
  const guide = fs.existsSync(guideFile) ? fs.readFileSync(guideFile, "utf8") : "";
  return {
    skillRoot,
    designSystemId: "",
    categoryId: "",
    designMarkdown: `# OpenKimi design catalog\n\nHost did not select a design system.\n\n${catalog}\n`,
    categoryMarkdown: guide,
    categoryGuideExcerpt: guide,
    skillExcerpt: skillExcerpt(skillRoot),
    pptdExcerpt: pptdExcerpt(skillRoot),
    recipesMarkdown: officialRecipesMarkdown(),
    palette: NEUTRAL_PALETTE,
  };
}

export function loadPlaybook(
  opts: {
    skillRoot?: string;
    designSystemId?: string;
    categoryId?: string;
    /** When false, missing ids do not fall back to pine-green / analysis-decision. */
    hostDefaults?: boolean;
  } = {},
): PlaybookBundle {
  const skillRoot = opts.skillRoot ?? resolveSkillRoot();
  const explicitDesign = opts.designSystemId?.trim() ?? "";
  const explicitCategory = opts.categoryId?.trim() ?? "";
  if (!explicitDesign && !explicitCategory && opts.hostDefaults === false) {
    return catalogOnlyPlaybook(skillRoot);
  }
  const designSystemId = explicitDesign || (opts.hostDefaults === false ? "" : DEFAULT_DESIGN_SYSTEM);
  const categoryId = explicitCategory || (opts.hostDefaults === false ? "" : DEFAULT_CATEGORY);
  if (!designSystemId) {
    const catalog = catalogOnlyPlaybook(skillRoot);
    if (!categoryId) return catalog;
    const categoryFile = path.join(skillRoot, "reference", "slides_categories", `${categoryId}.md`);
    return {
      ...catalog,
      categoryId,
      categoryMarkdown: fs.existsSync(categoryFile) ? fs.readFileSync(categoryFile, "utf8") : catalog.categoryMarkdown,
    };
  }
  const designFile = resolveDesignSystemFile(skillRoot, designSystemId);
  const designMarkdown = fs.readFileSync(designFile, "utf8");
  if (!categoryId) {
    const catalog = catalogOnlyPlaybook(skillRoot);
    return {
      ...catalog,
      designSystemId,
      designMarkdown,
      palette: extractPalette(designMarkdown),
    };
  }
  const categoryFile = path.join(skillRoot, "reference", "slides_categories", `${categoryId}.md`);
  if (!fs.existsSync(categoryFile)) {
    throw new Error(`slides category not found: ${categoryId} (${categoryFile})`);
  }
  const guideFile = path.join(skillRoot, "reference", "slides_categories.md");
  return {
    skillRoot,
    designSystemId,
    categoryId,
    designMarkdown,
    categoryMarkdown: fs.readFileSync(categoryFile, "utf8"),
    categoryGuideExcerpt: fs.readFileSync(guideFile, "utf8"),
    skillExcerpt: skillExcerpt(skillRoot),
    pptdExcerpt: pptdExcerpt(skillRoot),
    recipesMarkdown: officialRecipesMarkdown(),
    palette: extractPalette(designMarkdown),
  };
}
