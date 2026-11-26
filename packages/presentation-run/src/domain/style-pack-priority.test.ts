import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createEmptyProject, loadProject, saveProject } from "@open-slidestudio/pptd-v2";
import { createPresentationRun } from "../run.js";
import { writeDomainRuntime } from "./domain-hands.js";
import { kindThemePackIssue, packColorWriteContextFrom } from "./theme-pack.js";
import { stylePackDisplayName } from "./style-pack-priority.js";
import type { DesignAspect } from "./design-aspects.js";
import type { MaterialKind } from "./material-pack.js";
import { verifyMaterial } from "./material-pack.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PACK = "finance/honey-orange-memo";
const PLAN = [{ pageId: "cover", title: "说明", layoutFamily: "cover", exhibits: [] }];
const sha = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex");

function writeMaterial(root: string, kind: MaterialKind, parser: string, name: string) {
  const id = "attachment";
  const dir = path.join(root, "_agent/materials", id);
  fs.mkdirSync(dir, { recursive: true });
  const original = Buffer.from("synthetic material");
  const derivative = Buffer.from(
    JSON.stringify({
      schema: "material-derivative/v1",
      materialId: id,
      status: "ok",
      source: { sha256: sha(original) },
      parser: { id: parser },
      document: { pages: [{ index: 1, text: "说明" }] },
    }),
  );
  fs.writeFileSync(path.join(dir, `original${path.extname(name)}`), original);
  fs.writeFileSync(path.join(dir, "derivative.json"), derivative);
  fs.writeFileSync(
    path.join(dir, "receipt.json"),
    JSON.stringify({
      version: 1,
      id,
      kind,
      parser,
      name,
      originalSha256: sha(original),
      derivativeSha256: sha(derivative),
    }),
  );
  fs.writeFileSync(
    path.join(root, "_agent/materials/manifest.json"),
    JSON.stringify({
      version: 1,
      materials: [{ id, kind, parser, name, sha256: sha(original), parts: [] }],
    }),
  );
}

test("VAL-ASPECT-004: image and PDF style rejections name the pack and file before kind eligibility", async (t) => {
  for (const [kind, parser, name] of [
    ["image", "image-sharp-v1", "配色图.png"],
    ["document", "pdf-unpdf-v3", "参考.pdf"],
  ] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oss-style-priority-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    createEmptyProject(root, { title: "优先级" });
    writeMaterial(root, kind, parser, name);
    writeDomainRuntime(root, { brief: "按附件模板的风格做", designSystemId: PACK });
    const run = createPresentationRun({ repoRoot: REPO });
    const handle = await run.open({
      projectRoot: root,
      sessionId: `priority-${kind}`,
      brief: "按附件模板的风格做",
      editorBaseUrl: "http://127.0.0.1:1",
      design: { kind: "explicit-style", designSystemId: PACK },
      provider: { providerId: "offline", modelId: "fixture" },
    });
    const before = fs.readFileSync(path.join(root, "deck.pptd"));
    for (const aspect of ["palette", "fonts", "decorations"]) {
      const result = await run.execute(
        {
          name: "commit_design",
          args: {
            slidePlan: PLAN,
            adoptedSourceIds: ["material:attachment"],
            designAspects: [{ source: "material:attachment", aspects: [aspect] }],
          },
        },
        {
          ...handle,
          projectRoot: root,
          toolCallId: `deny-${aspect}`,
          abortSignal: new AbortController().signal,
        },
      );
      assert.equal(result.ok, false);
      assert.ok(result.detail.includes("风格「蜜橙备忘」"), result.detail);
      assert.ok(result.detail.includes(`附件「${name}」`), result.detail);
      assert.match(result.detail, /designAuthority: material:<id>/);
      assert.deepEqual(fs.readFileSync(path.join(root, "deck.pptd")), before);
    }
  }
});

test("VAL-ASPECT-004: restored style pack never widens pack_color with legacy attachment palette", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oss-style-legacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = createEmptyProject(root, { title: "旧的设计记录" });
  project.presentation.theme = {
    colors: { accent1: "#FF5703" },
    textStyles: { schemeMajor: { fontFamily: { latin: "Arial", ea: "微软雅黑" } } },
  };
  saveProject(project);
  writeMaterial(root, "image", "image-sharp-v1", "颜色.png");
  writeDomainRuntime(root, {
    brief: "按附件模板的风格做",
    designSystemId: PACK,
    designAspects: [{ source: "material:attachment", aspects: ["palette"] }],
  });
  const before = loadProject(root).presentation.theme;
  const context = packColorWriteContextFrom({ designSystemId: PACK, adoptedSourceIds: ["material:attachment"] }, root);
  assert.equal(context.materialError, undefined);
  assert.equal(context.adoptedPackHexes?.has("#FF5703"), true);
  assert.equal(context.adoptedPackHexes?.has("#C8102E"), false);
  assert.equal(context.adoptedDesignSourceIds, undefined);
  assert.deepEqual(loadProject(root).presentation.theme, before);
  writeDomainRuntime(root, {
    brief: "按附件模板的风格做",
    designAspects: [{ source: "material:attachment", aspects: ["palette"] }],
  });
  const requestOnly = packColorWriteContextFrom(
    { designSystemId: PACK, adoptedSourceIds: ["material:attachment"] },
    root,
  );
  assert.equal(requestOnly.materialError, undefined, "structured request also protects the pack");
  assert.equal(requestOnly.adoptedDesignSourceIds, undefined);
});

test("kind_theme_pack: only declared adopted material palette satisfies the narrow extension", () => {
  const brief = "给董事会做一份北麓制造上半年经营汇报，16页。";
  const uses: DesignAspect[][] = [["palette"], ["logo"], ["content"], []];
  for (const id of ["tpl", "image", "logo", "screenshot", "pdf"]) {
    for (const aspects of uses) {
      const input = {
        brief,
        adoptedSourceIds: [`material:${id}`],
        designAspects: [{ source: `material:${id}`, aspects }],
      };
      assert.equal(
        kindThemePackIssue(input)?.code,
        aspects.includes("palette") ? undefined : "missing_theme_pack",
        `${id}:${aspects}`,
      );
      assert.equal(
        kindThemePackIssue({ ...input, adoptedSourceIds: [] })?.code,
        "missing_theme_pack",
        "declared but unadopted palette grants nothing",
      );
      assert.equal(
        kindThemePackIssue({
          ...input,
          adoptedSourceIds: [...input.adoptedSourceIds, "work/warm-jade-annual-report"],
        })?.code,
        "kind_theme_pack",
        "palette does not bypass forbidden catalog families",
      );
    }
  }
});

test("kind_theme_pack: omitted aspects grant legacy palette only to a verified deck-template", (t) => {
  const brief = "给董事会做一份北麓制造上半年经营汇报，16页。";
  const adoptedSourceIds = ["material:attachment"];
  assert.equal(
    kindThemePackIssue({ brief, adoptedSourceIds })?.code,
    "missing_theme_pack",
    "a material id alone cannot prove a legacy PPTX",
  );
  for (const [kind, parser, name] of [
    ["image", "image-sharp-v1", "参考.png"],
    ["document", "pdf-unpdf-v3", "参考.pdf"],
    ["deck-template", "pptx-ooxml-v1", "参考.pptx"],
  ] as const) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oss-legacy-palette-"));
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    writeMaterial(projectRoot, kind, parser, name);
    assert.equal(verifyMaterial(projectRoot, "attachment").kind, kind);
    const input = { brief, adoptedSourceIds, projectRoot };
    assert.equal(
      kindThemePackIssue(input)?.code,
      kind === "deck-template" ? undefined : "missing_theme_pack",
      `${kind}: omitted declarations need verified PPTX compatibility`,
    );
    const designAspects = [{ source: adoptedSourceIds[0]!, aspects: ["palette"] }];
    assert.equal(kindThemePackIssue({ ...input, designAspects }), undefined);
    writeDomainRuntime(projectRoot, { brief, designAspects });
    assert.equal(kindThemePackIssue(input), undefined, `${kind}: persisted palette is explicit`);
    writeDomainRuntime(projectRoot, { brief });
    fs.appendFileSync(
      path.join(projectRoot, "_agent/materials/attachment", `original${path.extname(name)}`),
      "tampered",
    );
    assert.equal(
      kindThemePackIssue(input)?.code,
      "missing_theme_pack",
      `${kind}: unverifiable material never receives an implicit palette`,
    );
  }
});

test("style-pack display names agree with all Hub names, including restored catalog packs", async () => {
  const uiModule = path.join(REPO, "apps/native-web/public/style-catalog-names.js");
  const names = (await import(uiModule)) as { STYLE_NAMES: Map<string, string> };
  assert.equal(names.STYLE_NAMES.size, 44);
  for (const [id, name] of names.STYLE_NAMES) assert.equal(stylePackDisplayName(id), name, id);
});
