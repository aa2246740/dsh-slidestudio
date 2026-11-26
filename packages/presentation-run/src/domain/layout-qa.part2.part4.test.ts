import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { reviewSkillPages, writePageSchemaIssues, writePageSchemaError, photoExhibitIssues } from "./layout-qa.js";
import type { SkillPageInput } from "./skill-pages.js";

describe("photo exhibit media gate", () => {
  function photoPage(
    id: string,
    src: string | undefined,
    bounds: [number, number, number, number] = [40, 120, 560, 300],
  ): SkillPageInput {
    return {
      id,
      pageType: "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [40, 40, 400, 40],
          content: { text: "城市空中血液网络", fontSize: 22, color: "#111111" },
        },
        ...(src ? [{ elementId: "hero", elementType: "image" as const, bounds, src }] : []),
      ],
    };
  }

  function mediaRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "photo-gate-"));
    createEmptyProject(root, { title: "photo gate" });
    fs.mkdirSync(path.join(root, "media"), { recursive: true });
    fs.writeFileSync(path.join(root, "media", "corridor.png"), "png");
    return root;
  }

  it("refuses a photo todo page without any image element", () => {
    const issues = photoExhibitIssues(photoPage("cover_scene", undefined), { photoExhibit: true });
    assert.equal(issues[0]?.code, "missing_media");
    assert.match(issues[0]?.message ?? "", /photo-led/);
  });

  it("refuses a photo page whose src is not in media/", () => {
    const issues = photoExhibitIssues(photoPage("cover_scene", "media/ghost.png"), {
      photoExhibit: true,
      projectRoot: mediaRoot(),
    });
    assert.equal(issues[0]?.code, "missing_media");
    assert.match(issues[0]?.message ?? "", /media\/ghost\.png/);
  });

  it("accepts a photo page backed by an existing unique media file", () => {
    const ctx = {
      photoExhibit: true,
      projectRoot: mediaRoot(),
      siblingImageSrcs: [{ pageId: "cover", src: "media/cover.png" }],
    };
    assert.deepEqual(photoExhibitIssues(photoPage("cover_scene", "media/corridor.png"), ctx), []);
  });

  it("refuses a photo page whose only image reuses a sibling src", () => {
    const ctx = {
      photoExhibit: true,
      projectRoot: mediaRoot(),
      siblingImageSrcs: [{ pageId: "cover", src: "media/corridor.png" }],
    };
    const issues = photoExhibitIssues(photoPage("cover_scene", "media/corridor.png"), ctx);
    assert.equal(issues[0]?.code, "reused_cover_src");
  });

  it("stays off when the todo does not promise a photo", () => {
    assert.deepEqual(photoExhibitIssues(photoPage("cover_scene", undefined), {}), []);
    assert.deepEqual(writePageSchemaIssues(photoPage("cover_scene", undefined), { projectRoot: mediaRoot() }), []);
  });

  it("rejects at write_page schema level with missing_media", () => {
    const page = photoPage("cover_scene", undefined);
    const err = writePageSchemaError(writePageSchemaIssues(page, { photoExhibit: true }), page, {
      photoExhibit: true,
    });
    assert.equal(err?.error, "missing_media");
  });
});

describe("missing_media covers picture fills (ruling 114)", () => {
  function mediaProject(files: readonly string[]): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fill-media-"));
    createEmptyProject(root, { title: "fill media" });
    fs.mkdirSync(path.join(root, "media"), { recursive: true });
    for (const name of files) fs.writeFileSync(path.join(root, "media", name), "png");
    return root;
  }

  /** A content page: a title, and one full-width rectangle filled with the picture `src`. */
  function bandPage(src: string): SkillPageInput {
    return {
      id: "p2",
      pageType: "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [40, 40, 400, 40],
          content: { text: "城市空中血液网络", fontSize: 22, color: "#111111" },
        },
        {
          elementId: "band",
          elementType: "shape",
          shapeName: "rect",
          bounds: [40, 120, 880, 300],
          fill: { type: "image", src },
        },
      ],
    };
  }

  function missingMedia(pages: SkillPageInput[], projectRoot: string) {
    return reviewSkillPages(pages, { mode: "compose", projectRoot }).issues.filter(
      (issue) => issue.code === "missing_media",
    );
  }

  it("reports a picture fill whose media file was removed", () => {
    const issues = missingMedia([bandPage("media/ghost.png")], mediaProject([]));
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.pageId, "p2");
    assert.match(issues[0]?.message ?? "", /media\/ghost\.png/);
  });

  it("accepts a picture fill whose media file exists", () => {
    const root = mediaProject(["band.png"]);
    assert.deepEqual(missingMedia([bandPage("media/band.png")], root), []);
  });

  it("still reports a picture element whose media file is missing", () => {
    const page: SkillPageInput = {
      id: "p3",
      pageType: "content",
      elements: [
        {
          elementId: "hero",
          elementType: "image",
          bounds: [40, 120, 400, 300],
          src: "media/ghost.png",
        },
      ],
    };
    const issues = missingMedia([page], mediaProject([]));
    assert.equal(issues.length, 1);
    assert.match(issues[0]?.message ?? "", /media\/ghost\.png/);
  });
});
