/**
 * The `kit` part of a PPTX template as read_material returns it: one section per reusable
 * component with its reference, role, archetype, box, scope hint and a count of its elements.
 * Path data, colours and file names stay out, so the model references a component instead of
 * copying its geometry; the Host expands the reference when the page or layout is written.
 */
import { MATERIAL_CHUNK_BYTES } from "./material-pack.js";
import { componentAspects, componentRef, type KitComponent, type LoadedTemplateKit } from "./template-kit.js";

const WRAPPER_OPEN = "<untrusted_reference_material>";
const WRAPPER_CLOSE = "</untrusted_reference_material>";
const USAGE =
  "Host 会把组件引用展开为原生元素（路径、渐变和图片由 Host 取自模板，不会出现在这里）。" +
  '用法：在 write_page 的 elements 里写 {"elementType":"component","ref":"<下方引用>","bounds":[x,y,w,h]}，' +
  "可以编辑版式的轮次里，版式的 elements 也接受同样的写法，但 SmartArt 组件只能放在页面上；bounds 为 960×540 页面像素，省略则保持模板里的位置。" +
  "SmartArt 组件可另带 texts 改写节点文字：每个节点一项，按阅读顺序；一项是节点文字，或它的几段（第一段是主文）。" +
  "流程类组件会按 texts 项数增减节点并等距重排，箭头落在间隙正中；其余组件的 texts 项数必须与节点数一致。展开后是普通形状，可单独选中移动。" +
  "组件不会新建页面，也不带样例文字。";

const ROLE_LABELS = { decoration: "装饰（decoration）", smartart: "SmartArt 图形（smartart）" };
const SCOPE_LABELS = {
  layout: "layout（放进版式，由各页继承）",
  page: "page（直接写在页面上）",
};
const TYPE_LABELS: Readonly<Record<string, string>> = {
  shape: "形状",
  image: "图片",
  line: "线",
  text: "文本框",
};

function escaped(value: string): string {
  return value.replace(/<\/untrusted_reference_material/gi, "&lt;/untrusted_reference_material");
}

function percent(value: number): string {
  return `${Number((value * 100).toFixed(2))}%`;
}

function elementSummary(entry: KitComponent): string {
  const counts = new Map<string, number>();
  for (const element of entry.elements) {
    counts.set(element.elementType, (counts.get(element.elementType) ?? 0) + 1);
  }
  return [...counts].map(([type, count]) => `${TYPE_LABELS[type] ?? escaped(type)} ×${count}`).join("、");
}

function section(kit: LoadedTemplateKit, entry: KitComponent): string {
  const [x, y, w, h] = entry.box;
  const slides = entry.slides.length ? `；出现在第 ${entry.slides.join("、")} 页` : "";
  return [
    `### ${escaped(componentRef(kit.materialId, entry.id))}`,
    `角色：${ROLE_LABELS[entry.role]} · 原型：${escaped(entry.archetype || "未分类")} · scopeHint：${SCOPE_LABELS[entry.scopeHint]}`,
    `位置：左 ${percent(x)}、上 ${percent(y)}、宽 ${percent(w)}、高 ${percent(h)}${slides}`,
    `元素：${elementSummary(entry)} · 需要采用的用途：${componentAspects(kit, entry).join("、")}`,
  ].join("\n");
}

function wrapped(body: string): string {
  return `${WRAPPER_OPEN}\n${body}\n${WRAPPER_CLOSE}`;
}

/** Wrapped chunks of at most one material chunk each; a component section is never split. */
export function templateKitChunks(kit: LoadedTemplateKit): string[] {
  const heading = `## 可复用模板组件\n${USAGE}`;
  if (!kit.components.length) return [wrapped(`${heading}\n\n（模板没有可复用组件。）`)];
  const chunks: string[] = [];
  let sections: string[] = [];
  const bytes = (parts: readonly string[]) => Buffer.byteLength(wrapped([heading, ...parts].join("\n\n")), "utf8");
  for (const entry of kit.components) {
    const next = section(kit, entry);
    if (sections.length && bytes([...sections, next]) > MATERIAL_CHUNK_BYTES) {
      chunks.push(wrapped([heading, ...sections].join("\n\n")));
      sections = [];
    }
    sections.push(next);
  }
  chunks.push(wrapped([heading, ...sections].join("\n\n")));
  return chunks;
}
