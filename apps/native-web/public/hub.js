import { clearWaitingRow, paintWaitingRow } from "./step-paint.js";
import { installTooltips } from "./tooltips.js";
import { t, lang, onLangChange } from "./i18n.js";
import { parseCatalog, buildGenerationRequest } from "./hub-input.js";
import { editorHref, launchHref, readLaunch, saveLaunch } from "./launch-flow.js";
import { THEMES, applyTheme, currentTheme } from "./theme.js";
import {
  capabilityViewModel,
  createHealthRequestGate,
  healthSelectionMatches,
  selectedHealthReady,
} from "./hub-health-state.js";

installTooltips();

function nativeApi(path) {
  const rest = String(path || "").replace(/^\/api/, "");
  const root = location.pathname.startsWith("/app/") ? "/app/api" : "/api";
  return `${root}${rest.startsWith("/") ? rest : `/${rest}`}`;
}

function themeAssetUrl(path) {
  if (!path) return "";
  if (path.startsWith("http://") || path.startsWith("https://") || path.startsWith("/slides/")) {
    return path;
  }
  const root = location.pathname.startsWith("/app/") ? "/app" : "";
  const clean = path.replace(/^\.\//, "").replace(/^\//, "");
  return `${root}/${clean}`;
}

// These are visual-system references only. They select tokens and visual tone;
// Pi still designs every page structure and composition from the brief.
const FREESTYLE_STYLE = {
  id: "freestyle",
  title: "Freestyle",
  label: "自由风格",
  cat: "All",
  preview: "template-freestyle.jpg",
  previewUrl: "./templates/template-freestyle.jpg",
  system: "",
};
let styleReferences = [FREESTYLE_STYLE];
let generationCatalog = null;
let catalogError = null;
let creationInFlight = false;

let tabsList = [
  { id: "All", label: "全部" },
];
const KIND_LABELS = { Slides: "幻灯片", Docs: "文档", Report: "报告" };
const LAYOUT_LABELS = { Adaptive: "自适应", "16:9": "16:9", "4:3": "4:3" };

const brief = document.getElementById("brief");
const send = document.getElementById("btn-send");
const grid = document.getElementById("grid");
const tabs = document.getElementById("tabs");
const attachRow = document.getElementById("attach-row");
const toast = document.getElementById("toast");

let cat = "All";
let designSystemId = "";
let selectedStyleId = "freestyle";
let selectedStyleTitle = "Freestyle";
let kind = "Slides";
let layout = "16:9";
const modelName = "MiniMax-M3";
let serverPiAvailable = false;
let serverDshReady = false;
let serverMinimaxReady = false;
let serverCapability = null;
let piProductLoggedIn = false;
const attachments = [];
function syncCreateButton() {
  send.disabled = creationInFlight || !generationCatalog || !selectedModelKey() || !brief.value.trim()
    || attachments.some((attachment) => attachment.status !== "parsed");
}
let generateSeq = 0;
let generateAbort = null;
const PI_MODEL_STORE = "oss.pi.model";
const PI_PROVIDER_STORE = "oss.pi.provider";
function setModelChip(name = "AI Agent") {
  const el = document.getElementById("model-label");
  if (el) el.textContent = name;
}

function paintCapability(card, extras = {}) {
  const row = document.getElementById("capability-row");
  if (!row) return;
  const focusedIndex = [...row.children].indexOf(document.activeElement);
  const view = capabilityViewModel(card, extras);
  row.replaceChildren();
  for (const chip of view.chips) {
    const item = document.createElement("li");
    item.className = chip.on ? "is-on" : "is-off";
    item.textContent = chip.label;
    item.title = chip.hint;
    item.tabIndex = 0;
    item.setAttribute("aria-label", `${chip.label}：${chip.hint}`);
    row.append(item);
  }
  row.hidden = view.chips.length === 0;
  if (focusedIndex >= 0) {
    if (row.children[focusedIndex]) row.children[focusedIndex].focus({ preventScroll: true });
    else focusModelOption();
  }
  positionModelPanel();
}

let piLoginState = { providers: [] };
let modelListSequence = 0;
let currentModelKey = "";
let currentEffort = "";

function positionModelPanel() {
  const panel = document.getElementById("pi-panel");
  if (!panel || panel.hidden) return;
  const anchor = document.querySelector(".model-picker").getBoundingClientRect();
  panel.style.left = `${Math.max(16, Math.min(anchor.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 16)) - anchor.left}px`;
  panel.style.top = `${anchor.height + 6}px`;
  panel.style.maxHeight = `${Math.max(120, innerHeight - 32)}px`;
  const rect = panel.getBoundingClientRect();
  if (rect.bottom > innerHeight - 16) {
    panel.style.top = `${Math.max(16, anchor.top - rect.height - 6) - anchor.top}px`;
  }
}

function focusModelOption() {
  const list = document.getElementById("pi-model");
  (list?.querySelector('[aria-selected="true"]') || list)?.focus({ preventScroll: true });
}

function showPiPanel(open) {
  const panel = document.getElementById("pi-panel");
  if (!panel) return;
  if (open == null) panel.hidden = !panel.hidden;
  else panel.hidden = !open;
  document.getElementById("btn-model")?.setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) {
    positionModelPanel();
    focusModelOption();
    void refreshPiLogin();
  }
}

function loadPiProvider() {
  try {
    return String(localStorage.getItem(PI_PROVIDER_STORE) || "").trim();
  } catch {
    return "";
  }
}

function savePiProvider(value) {
  const next = String(value || "").trim();
  try {
    if (next) localStorage.setItem(PI_PROVIDER_STORE, next);
    else localStorage.removeItem(PI_PROVIDER_STORE);
  } catch {
    /* ignore */
  }
}

/** "providerId/modelId", or "" when the picker has nothing usable selected. */
function selectedModelKey() {
  return currentModelKey;
}

function currentPiOffer() {
  const [providerId] = selectedModelKey().split("/");
  return (piLoginState.providers || []).find((p) => p.id === providerId);
}

function selectedPiProvider() {
  return currentPiOffer()?.id || "";
}

function loadPiModel() {
  try {
    return String(localStorage.getItem(PI_MODEL_STORE) || "").trim();
  } catch {
    return "";
  }
}

function savePiModel(value) {
  const next = String(value || "").trim();
  try {
    if (next) localStorage.setItem(PI_MODEL_STORE, next);
    else localStorage.removeItem(PI_MODEL_STORE);
  } catch {
    /* ignore */
  }
}

function selectedPiModel() {
  const key = selectedModelKey();
  return key.includes("/") ? key.slice(key.indexOf("/") + 1) : "";
}

/**
 * One grouped list of the models a call could actually use. A provider that
 * is not ready has no models to pick, so it never appears; the note below the
 * select is what points the user at Settings.
 */
function paintPiModels() {
  const list = document.getElementById("pi-model");
  const note = document.getElementById("pi-provider-note");
  if (!list) return;
  const focusedKey = document.activeElement?.dataset.modelKey;
  const hadFocus = list.contains(document.activeElement);
  const ready = (piLoginState.providers || []).filter((row) => row.ready && modelsOf(row).length > 0);
  const keep = selectedModelKey() || modelKey(loadPiProvider(), loadPiModel());
  list.replaceChildren();
  const choices = [];
  for (const [index, provider] of ready.entries()) {
    const group = document.createElement("div");
    group.setAttribute("role", "group");
    const heading = document.createElement("div");
    heading.className = "model-group-label";
    heading.id = `model-group-${index}`;
    heading.textContent = provider.name || provider.id;
    group.setAttribute("aria-labelledby", heading.id);
    group.append(heading);
    for (const modelId of modelsOf(provider)) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "model-option";
      option.setAttribute("role", "option");
      option.dataset.modelKey = modelKey(provider.id, modelId);
      const name = document.createElement("span");
      name.textContent = provider.modelNames?.[modelId] || modelId;
      option.append(name);
      option.insertAdjacentHTML("beforeend", '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>');
      group.append(option);
      choices.push(option.dataset.modelKey);
    }
    list.append(group);
  }
  currentModelKey = choices.includes(keep) ? keep : choices[0] || "";
  for (const option of list.querySelectorAll('[role="option"]')) {
    const selected = option.dataset.modelKey === currentModelKey;
    option.setAttribute("aria-selected", String(selected));
    option.tabIndex = selected ? 0 : -1;
  }
  const chosen = currentPiOffer();
  // A temporary empty/error response must not erase the saved choice.
  if (chosen) {
    savePiProvider(chosen.id);
    savePiModel(selectedPiModel());
  }
  list.setAttribute("aria-disabled", String(choices.length === 0));
  setModelChip(chosen?.modelNames?.[selectedPiModel()] || selectedPiModel() || "AI Agent");
  if (note) note.hidden = choices.length > 0;
  paintEffortControl();
  syncCreateButton();
  positionModelPanel();
  if (hadFocus && !document.getElementById("pi-panel").hidden) {
    const previous = [...list.querySelectorAll('[role="option"]')].find((row) => row.dataset.modelKey === focusedKey);
    const target = previous || list.querySelector('[aria-selected="true"]') || list;
    for (const option of list.querySelectorAll('[role="option"]')) option.tabIndex = option === target ? 0 : -1;
    target.focus({ preventScroll: true });
  }
}

function modelsOf(provider) {
  return (provider?.models || []).map((row) => String(row || "").trim()).filter((id) => id && id !== "(sign-in)");
}

function modelKey(providerId, modelId) {
  return providerId && modelId ? `${providerId}/${modelId}` : "";
}

function paintPiPanel() {
  paintPiModels();
  if (selectedModelKey()) void refreshHealth();
  else paintCapability(null, { state: "error" });
}

async function refreshPiLogin() {
  const sequence = ++modelListSequence;
  let groups;
  let failed = false;
  try {
    const response = await fetch("/slides/models");
    if (!response.ok) throw new Error("models unavailable");
    groups = await response.json();
    if (!Array.isArray(groups)) throw new Error("invalid model catalog");
  } catch {
    failed = true;
    groups = [];
  }
  if (sequence !== modelListSequence) return;
  const providers = groups.filter((row) => row.ready).map((row) => ({
    ...row,
    id: row.providerId,
    name: row.providerName,
    models: row.models.map((model) => model.id),
    modelNames: Object.fromEntries(row.models.map((model) => [model.id, model.name])),
  }));
  providerEfforts = new Map(
    providers.filter((row) => Array.isArray(row.efforts)).map((row) => [row.id, row.efforts]),
  );
  piLoginState = { providers };
  paintPiPanel();
  const note = document.getElementById("pi-provider-note");
  if (note) note.textContent = failed
    ? t("模型列表暂时无法加载，请重新打开此面板重试。")
    : t("还没有可用模型，去右上角「设置」接入。");
  positionModelPanel();
  return groups;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function toRgbColor(value) {
  const raw = String(value || "").trim();
  if (!raw || /gradient/i.test(raw)) return "rgb(232, 232, 234)";
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  }
  if (/^rgba?\(/i.test(raw)) return raw;
  return raw;
}

function showToast(text) {
  toast.hidden = false;
  toast.textContent = text;
  toast.classList.remove("is-in", "is-out");
  void toast.offsetWidth;
  toast.classList.add("is-in");
  clearTimeout(showToast.hideTimer);
  clearTimeout(showToast.leaveTimer);
  showToast.hideTimer = setTimeout(() => {
    toast.classList.remove("is-in");
    toast.classList.add("is-out");
    showToast.leaveTimer = setTimeout(() => {
      toast.hidden = true;
      toast.classList.remove("is-out");
    }, 180);
  }, 2200);
}

function setLaunchStatus(text = "") {
  const el = document.getElementById("launch-status");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text;
}

function goHome() {
  generateSeq += 1;
  if (generateAbort) {
    generateAbort.abort();
    generateAbort = null;
  }
  const screen = document.getElementById("agent-screen");
  screen.hidden = true;
  screen.classList.remove("is-enter");
  document.getElementById("home-screen").hidden = false;
  setLaunchStatus("");
  syncCreateButton();
  void renderProjects();
}

function showAgentScreen() {
  document.getElementById("home-screen").hidden = true;
  const screen = document.getElementById("agent-screen");
  screen.hidden = false;
  screen.classList.remove("is-enter");
  void screen.offsetWidth;
  screen.classList.add("is-enter");
}

function hideMenus() {
  for (const id of ["kind-menu", "layout-menu", "style-pop"]) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  document.getElementById("style-chip")?.setAttribute("aria-expanded", "false");
  showPiPanel(false);
}

const STYLE_NAMES = {
  "consulting/apricot-white-brief": "杏白简报",
  "consulting/indigo-due-diligence": "靛蓝尽调",
  "consulting/marine-blue-research": "海蓝研究",
  "consulting/moss-green-transformation": "苔绿转型",
  "consulting/pine-green-strategy": "松绿战略",
  "consulting/red-black-growth": "红黑增长",
  "finance/black-gold-ledger": "黑金台账",
  "finance/ebony-ledger": "乌木台账",
  "finance/honey-orange-memo": "蜜橙备忘",
  "finance/lake-blue-memo": "湖蓝备忘",
  "finance/prospect-annual": "展望年报",
  "finance/rice-paper-annual": "宣纸年报",
  "work/blue-flame-brand": "蓝焰品牌",
  "work/electric-violet-business": "电紫商务",
  "work/moon-white-imagery": "月白影像",
  "work/sky-blue-wayfinding": "天蓝导向",
  "work/warm-clay-works": "暖陶作品",
  "work/warm-jade-annual-report": "暖玉年报",
  "promotion/aqua-charity-report": "水色公益",
  "promotion/cream-collage": "奶油拼贴",
  "promotion/pine-soot-pictorial": "松烟画报",
  "promotion/silk-yellow-magazine": "丝黄杂志",
  "promotion/silver-gray-luxury-magazine": "银灰杂志",
  "promotion/travel-green-handbook": "旅行手册",
  "academic/blue-line-courseware": "蓝线课件",
  "academic/deep-blue-atlas": "深蓝图集",
  "academic/paper-white-courseware": "纸白课件",
  "academic/pastel-derivation": "粉彩推导",
  "academic/teal-green-academic-defense": "青绿答辩",
  "academic/wine-red-data": "酒红数据",
  "extra/color-stripes-documentary": "彩条纪实",
  "extra/dark-themed-data": "深色数据",
  "extra/dusk-violet-consulting": "暮紫咨询",
  "extra/fresh-brand": "清新品牌",
  "extra/gold-orange-type-journal": "金橙刊物",
  "extra/ink-green-market-trends": "墨绿趋势",
  "extra/lead-gray-quarterly": "铅灰季报",
  "extra/map-strategy": "地图战略",
  "extra/mist-blue-travelogue": "雾蓝游记",
  "extra/orange-tech": "橙色科技",
  "extra/pink-purple-diagnosis": "粉紫诊断",
  "extra/red-black-business": "红黑商务",
  "extra/red-white-business": "红白商务",
  "extra/xuan-paper-annual": "宣纸年刊",
};

const CATEGORY_NAMES = {
  All: "全部",
  consulting: "咨询策略",
  finance: "商业财务",
  work: "职场汇报",
  promotion: "品牌传播",
  academic: "学术教育",
  extra: "精选风格",
};

function getStyleDisplayName(style) {
  if (!style) return "";
  if (style.id === "freestyle") return t("自由风格");
  return t(STYLE_NAMES[style.id] || STYLE_NAMES[style.system] || style.label || style.title || style.id);
}

let slicesManifest = {};

function paintChip() {
  const style =
    styleReferences.find((item) => item.id === selectedStyleId) ||
    styleReferences.find((item) => item.title === selectedStyleTitle) ||
    FREESTYLE_STYLE;
  document.getElementById("style-label").textContent = getStyleDisplayName(style);
  const thumb = document.getElementById("style-thumb");
  if (thumb) {
    const sliceInfo = slicesManifest[style.id] || slicesManifest[style.system];
    thumb.src = (sliceInfo && sliceInfo.cover)
      ? themeAssetUrl(sliceInfo.cover)
      : (style.previewUrl || (style.preview ? `./templates/${style.preview}` : "./templates/template-freestyle.jpg"));
  }
}

function paintGrid() {
  grid.innerHTML = "";
  for (const style of styleReferences.filter(
    (item) => cat === "All" || item.cat === cat || item.cat === "All",
  )) {
    const b = document.createElement("button");
    b.type = "button";
    const isSelected = (style.id === selectedStyleId) || (!selectedStyleId && style.id === "freestyle");
    b.className = `style-reference-card${isSelected ? " is-selected" : ""}`;
    const displayName = t(getStyleDisplayName(style));
    b.setAttribute("aria-label", t("选择{n}风格参考", { n: displayName }));

    const sliceInfo = slicesManifest[style.id] || slicesManifest[style.system];
    const previewSrc = (sliceInfo && sliceInfo.cover)
      ? themeAssetUrl(sliceInfo.cover)
      : (style.previewUrl || (style.preview ? `./templates/${style.preview}` : "./templates/template-freestyle.jpg"));

    b.innerHTML = `<span class="style-reference-preview">
      <img alt="${escapeHtml(displayName)}" src="${previewSrc}" />
      <span class="page-badge" hidden>1</span>
      <div class="style-placeholder" hidden>
        <strong>${escapeHtml(displayName)}</strong>
        <span class="placeholder-cat">${escapeHtml(t(CATEGORY_NAMES[style.cat] || style.cat || "风格参考"))}</span>
      </div>
      ${isSelected
        ? `<span class="selected-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12l5 5L20 7"/></svg>${t("已选风格")}</span>`
        : ""
      }
    </span><span class="style-card-name">${escapeHtml(displayName)}</span>`;

    const image = b.querySelector("img");
    const badge = b.querySelector(".page-badge");
    const placeholder = b.querySelector(".style-placeholder");
    let timer = null;

    if (style.system) {
      b.disabled = true;
      b.setAttribute("aria-busy", "true");

      const setupHoverAnimation = (pageCount, pages) => {
        b.disabled = false;
        b.setAttribute("aria-busy", "false");
        if (pageCount <= 1) return;

        let preloaded = false;

        b.addEventListener("mouseenter", () => {
          if (!preloaded && pages) {
            pages.forEach((src) => {
              const p = new Image();
              p.src = themeAssetUrl(src);
            });
            preloaded = true;
          }
          let curPage = 0;
          badge.textContent = `1 / ${pageCount}`;
          badge.hidden = false;
          if (timer) clearInterval(timer);
          timer = setInterval(() => {
            curPage = (curPage + 1) % pageCount;
            if (pages && pages[curPage]) {
              image.src = themeAssetUrl(pages[curPage]);
            }
            badge.textContent = `${curPage + 1} / ${pageCount}`;
          }, 650);
        });

        b.addEventListener("mouseleave", () => {
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
          if (pages && pages[0]) {
            image.src = themeAssetUrl(pages[0]);
          }
          badge.hidden = true;
        });
      };

      if (sliceInfo && sliceInfo.pageCount > 1 && Array.isArray(sliceInfo.pages)) {
        setupHoverAnimation(sliceInfo.pageCount, sliceInfo.pages);
      } else {
        const setupImage = () => {
          b.disabled = false;
          b.setAttribute("aria-busy", "false");
          const pageCount = Math.max(1, Math.round(image.naturalHeight / (image.naturalWidth * 9 / 16)));
          setupHoverAnimation(pageCount, null);
        };

        if (image.complete && image.naturalWidth > 0) {
          setupImage();
        } else {
          image.addEventListener("load", setupImage);
          image.addEventListener("error", () => {
            image.hidden = true;
            if (placeholder) placeholder.hidden = false;
            b.disabled = false;
            b.setAttribute("aria-busy", "false");
          });
        }
      }
    }

    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      selectedStyleId = style.id;
      selectedStyleTitle = style.title;
      designSystemId = style.system;
      paintChip();
      paintGrid();
      document.getElementById("style-pop").hidden = true;
    });
    grid.append(b);
  }
}

function renderCatalogTabs() {
  tabs.innerHTML = "";
  for (const tab of tabsList) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = t(tab.label);
    if (tab.id === cat) b.classList.add("selected");
    b.addEventListener("click", () => {
      cat = tab.id;
      for (const x of tabs.querySelectorAll("button")) x.classList.toggle("selected", x === b);
      paintGrid();
    });
    tabs.append(b);
  }
}

async function loadCatalog() {
  try {
    const res = await fetch("/slides/catalog");
    if (!res.ok) {
      throw new Error(t("加载目录失败: HTTP {status}", { status: res.status }));
    }
    generationCatalog = parseCatalog(await res.json());
    try {
      const sliceManifestRes = await fetch(themeAssetUrl("theme-slices/manifest.json"));
      if (sliceManifestRes.ok) {
        slicesManifest = await sliceManifestRes.json();
      }
    } catch {
      slicesManifest = {};
    }
    styleReferences = [FREESTYLE_STYLE, ...generationCatalog.styles.map((style) => ({
      ...style, title: style.id, cat: style.category,
      preview: style.previews[0].url, previewUrl: style.previews[0].url, system: style.id,
    }))];
    const categories = ["consulting", "finance", "work", "promotion", "academic", "extra"];
    tabsList = [{ id: "All", label: "全部" }, ...categories.map((id) => ({
      id,
      label: CATEGORY_NAMES[id] || id,
    }))];
    catalogError = null;
    renderCatalogTabs();
    paintChip();
    paintGrid();
    syncCreateButton();
  } catch (err) {
    generationCatalog = null;
    catalogError = err instanceof Error ? err.message : String(err);
    styleReferences = [];
    send.disabled = true;
    const launchStatus = document.getElementById("launch-status");
    if (launchStatus) {
      launchStatus.textContent = t("设计目录不可用（{err}），已禁用创建。", { err: catalogError });
      launchStatus.hidden = false;
    }
    grid.innerHTML = `<div class="catalog-error" style="padding: 24px; color: #dc2626; text-align: center;">${t("设计目录不可用，创建暂不可用")}</div>`;
  }
}

paintChip();
paintGrid();
renderCatalogTabs();
void loadCatalog();

brief.addEventListener("input", () => {
  syncCreateButton();
});
{
  const draftId = new URLSearchParams(location.search).get("draft");
  const draft = draftId ? readLaunch(draftId) : null;
  if (draft?.request?.brief) {
    brief.value = draft.request.brief;
    syncCreateButton();
  }
  if (draftId) history.replaceState(null, "", "./");
}
brief.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
    ev.preventDefault();
    send.click();
  }
});

function toggleMenu(id) {
  const el = document.getElementById(id);
  const was = el.hidden;
  hideMenus();
  el.hidden = !was;
}

document.getElementById("btn-kind").addEventListener("click", (ev) => {
  ev.stopPropagation();
  toggleMenu("kind-menu");
});
document.getElementById("btn-layout").addEventListener("click", (ev) => {
  ev.stopPropagation();
  toggleMenu("layout-menu");
});
document.getElementById("btn-model").addEventListener("click", (ev) => {
  ev.stopPropagation();
  const open = document.getElementById("pi-panel").hidden;
  hideMenus();
  showPiPanel(open);
});
document.getElementById("kind-menu").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button");
  if (!btn || btn.disabled) return;
  const v = btn.getAttribute("data-kind");
  if (!v) return;
  kind = v;
  document.getElementById("kind-label").textContent = t(KIND_LABELS[v] || v);
  hideMenus();
});
document.getElementById("layout-menu").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button");
  if (!btn || btn.disabled) return;
  const v = btn.getAttribute("data-layout");
  if (!v) return;
  layout = v;
  document.getElementById("layout-label").textContent = t(LAYOUT_LABELS[v] || v);
  hideMenus();
});
document.getElementById("pi-model")?.addEventListener("click", (ev) => {
  const option = ev.target.closest('[role="option"]');
  if (!option) return;
  currentModelKey = option.dataset.modelKey;
  const chosen = currentPiOffer();
  savePiProvider(chosen?.id || "");
  savePiModel(selectedPiModel());
  paintPiModels();
  showPiPanel(false);
  document.getElementById("btn-model")?.focus();
  void refreshHealth();
});
document.getElementById("pi-model")?.addEventListener("keydown", (ev) => {
  const options = [...ev.currentTarget.querySelectorAll('[role="option"]')];
  if (!options.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(ev.key)) return;
  ev.preventDefault();
  const index = options.indexOf(document.activeElement);
  const next = ev.key === "Home" ? 0 : ev.key === "End" ? options.length - 1
    : (index + (ev.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
  for (const [i, option] of options.entries()) option.tabIndex = i === next ? 0 : -1;
  options[next].focus();
});
document.getElementById("pi-effort")?.addEventListener("click", (ev) => {
  const radio = ev.target.closest('[role="radio"]');
  if (!radio) return;
  currentEffort = radio.dataset.effort;
  paintEffortControl();
});
document.getElementById("pi-effort")?.addEventListener("keydown", (ev) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(ev.key)) return;
  ev.preventDefault();
  const efforts = selectedEfforts();
  const index = efforts.indexOf(currentEffort);
  const next = ev.key === "Home" ? 0 : ev.key === "End" ? efforts.length - 1
    : (index + (["ArrowRight", "ArrowDown"].includes(ev.key) ? 1 : -1) + efforts.length) % efforts.length;
  currentEffort = efforts[next];
  paintEffortControl();
});
document.getElementById("pi-panel")?.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  ev.preventDefault();
  ev.stopPropagation();
  showPiPanel(false);
  document.getElementById("btn-model")?.focus();
});
document.getElementById("pi-panel")?.addEventListener("click", (ev) => ev.stopPropagation());
document.querySelector(".model-picker")?.addEventListener("focusout", (ev) => {
  const picker = ev.currentTarget;
  if (picker.contains(ev.relatedTarget)) return;
  if (ev.relatedTarget) showPiPanel(false);
  else requestAnimationFrame(() => {
    if (!picker.contains(document.activeElement)) showPiPanel(false);
  });
});
window.addEventListener("resize", positionModelPanel);
window.addEventListener("scroll", positionModelPanel, { passive: true });
document.addEventListener("click", hideMenus);

let attachLocalSeq = 0;
let attachPaintFrame = 0;

function chipStatusText(f) {
  if (f.status === "uploading") return `${t("上传中")} ${f.progress ?? 0}%`;
  if (f.status === "parsed") return `${t("已解析")} (${f.chars ?? 0})`;
  if (f.status === "recorded") return t("已记录·不可解析");
  if (f.status === "failed") return f.error || t("上传失败");
  return f.status || "";
}

function renderChip(f) {
  const chip = document.createElement("div");
  chip.className = `reference-chip is-${f.status || "parsed"}`;
  chip.dataset.localId = f.localId;
  if (f.id) chip.dataset.attachId = f.id;
  const note = f.note || "";
  chip.innerHTML = `<span title="${escapeHtml(note)}"><b>${escapeHtml(f.name)}</b><small>${escapeHtml(chipStatusText(f))}</small>${
    f.status === "uploading"
      ? `<i class="chip-progress"><i class="chip-progress-bar" style="width: ${Math.max(0, f.progress ?? 0)}%"></i></i>`
      : ""
  }</span>`;
  const actions = document.createElement("div");
  actions.className = "chip-actions";
  if (f.status === "failed") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "chip-retry";
    retry.textContent = t("重试");
    retry.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (f.file) uploadAttachment(f);
    });
    actions.append(retry);
  }
  const rm = document.createElement("button");
  rm.type = "button";
  rm.textContent = "×";
  rm.title = t("移除");
  rm.addEventListener("click", (ev) => {
    ev.stopPropagation();
    removeAttachment(f.localId);
  });
  actions.append(rm);
  chip.append(actions);
  return chip;
}

function paintAttachments() {
  const modalList = document.getElementById("attach-modal-list");
  attachRow.innerHTML = "";
  if (modalList) modalList.innerHTML = "";
  for (const f of attachments) {
    attachRow.append(renderChip(f));
    if (modalList) modalList.append(renderChip(f));
  }
  syncCreateButton();
}

function paintAttachmentsSoon() {
  if (attachPaintFrame) return;
  attachPaintFrame = requestAnimationFrame(() => {
    attachPaintFrame = 0;
    paintAttachments();
  });
}

function removeAttachment(localId) {
  const i = attachments.findIndex((a) => a.localId === localId);
  if (i < 0) return;
  const rec = attachments[i];
  try { rec.xhr?.abort(); } catch { /* already closed */ }
  try { rec.reader?.abort(); } catch { /* already closed */ }
  attachments.splice(i, 1);
  paintAttachments();
}

function applyServerAttachment(rec, data) {
  rec.id = data.id;
  rec.name = data.name || rec.name;
  rec.bytes = data.bytes;
  rec.chars = data.chars;
  rec.note = data.note;
  rec.progress = 100;
  rec.status = data.parsed ? "parsed" : "recorded";
  rec.error = "";
}

function fileToDataUrl(file, rec, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    rec.reader = reader;
    reader.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.onabort = () => reject(new Error("aborted"));
    reader.readAsDataURL(file);
  });
}

function postAttachmentXhr(payload, rec, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    rec.xhr = xhr;
    xhr.open("POST", nativeApi("/api/attachments"));
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (e) {
          reject(e);
        }
      } else {
        let msg = `HTTP ${xhr.status}`;
        try {
          msg = JSON.parse(xhr.responseText).error || msg;
        } catch { /* keep status */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("network"));
    xhr.onabort = () => reject(new Error("aborted"));
    xhr.send(JSON.stringify(payload));
  });
}

async function uploadAttachment(rec) {
  const file = rec.file;
  if (!file) {
    rec.status = "failed";
    rec.error = t("没有可重试的文件");
    paintAttachments();
    return;
  }
  rec.status = "uploading";
  rec.progress = 0;
  rec.error = "";
  paintAttachments();
  try {
    const dataUrl = await fileToDataUrl(file, rec, (frac) => {
      rec.status = "uploading";
      rec.progress = Math.max(1, Math.round(frac * 40));
      paintAttachmentsSoon();
    });
    rec.progress = Math.max(rec.progress, 40);
    paintAttachments();
    const data = await postAttachmentXhr(
      { name: file.name, data: dataUrl, size: file.size },
      rec,
      (frac) => {
        rec.status = "uploading";
        rec.progress = 40 + Math.round(frac * 60);
        paintAttachmentsSoon();
      },
    );
    applyServerAttachment(rec, data);
    paintAttachments();
  } catch (e) {
    if (String(e?.message || e) === "aborted") return;
    rec.status = "failed";
    rec.error = e instanceof Error ? e.message : t("上传失败");
    rec.progress = 0;
    paintAttachments();
  }
}

function ingestFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  const added = [];
  for (const file of files) {
    const rec = {
      localId: `local-${++attachLocalSeq}`,
      name: file.name,
      file,
      status: "uploading",
      progress: 0,
    };
    attachments.push(rec);
    added.push(rec);
  }
  paintAttachments();
  for (const rec of added) uploadAttachment(rec);
}

const attachModal = document.getElementById("attach-modal");
const attachBox = attachModal.querySelector(".attach-modal");
document.getElementById("btn-attach").addEventListener("click", () => {
  attachModal.hidden = false;
});
document.getElementById("btn-attach-close").addEventListener("click", () => {
  attachModal.hidden = true;
});
document.getElementById("btn-pick-files").addEventListener("click", () => {
  document.getElementById("attach-file").click();
});
document.getElementById("btn-demo-ref").addEventListener("click", async () => {
  try {
    const res = await fetch(nativeApi("/api/attachments/demo"), { method: "POST" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const data = await res.json();
    for (const a of data.attachments || []) {
      attachments.push({
        localId: `local-${++attachLocalSeq}`,
        id: a.id,
        name: a.name,
        status: a.parsed ? "parsed" : "recorded",
        chars: a.chars,
        note: a.note,
        bytes: a.bytes,
        progress: 100,
      });
    }
    paintAttachments();
    attachModal.hidden = true;
    showToast(t("已加入本地品牌样例"));
  } catch (e) {
    showToast(e instanceof Error ? e.message : t("样例加入失败"));
  }
});
document.getElementById("attach-file").addEventListener("change", (ev) => {
  ingestFiles(ev.target.files);
  ev.target.value = "";
});
function bindDropTarget(el) {
  if (!el) return;
  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  el.addEventListener("dragenter", (e) => {
    stop(e);
    el.classList.add("is-dragover");
  });
  el.addEventListener("dragover", (e) => {
    stop(e);
    el.classList.add("is-dragover");
  });
  el.addEventListener("dragleave", () => {
    el.classList.remove("is-dragover");
  });
  el.addEventListener("drop", (e) => {
    stop(e);
    el.classList.remove("is-dragover");
    ingestFiles(e.dataTransfer?.files);
  });
}
bindDropTarget(document.getElementById("drop-zone"));
bindDropTarget(attachBox);
attachModal.addEventListener("click", (ev) => {
  if (ev.target === attachModal) attachModal.hidden = true;
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !attachModal.hidden) attachModal.hidden = true;
});

function toggleStylePop(ev) {
  ev.stopPropagation();
  const pop = document.getElementById("style-pop");
  const open = pop.hidden;
  hideMenus();
  pop.hidden = !open;
  document.getElementById("style-chip")?.setAttribute("aria-expanded", String(!pop.hidden));
}
document.getElementById("style-chip")?.addEventListener("click", toggleStylePop);
document.getElementById("style-chip")?.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" && ev.key !== " ") return;
  ev.preventDefault();
  toggleStylePop(ev);
});

document.getElementById("btn-style-pop-close")?.addEventListener("click", (ev) => {
  ev.stopPropagation();
  const pop = document.getElementById("style-pop");
  if (pop) pop.hidden = true;
});

document.getElementById("style-pop")?.addEventListener("click", (ev) => {
  ev.stopPropagation();
});

const VIEWED_PROJECTS_STORE = "oss.viewed.projects";

function loadViewedProjects() {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEWED_PROJECTS_STORE) || "[]");
    return new Set(Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function markProjectViewed(path) {
  try {
    const viewed = loadViewedProjects();
    viewed.add(String(path));
    localStorage.setItem(VIEWED_PROJECTS_STORE, JSON.stringify([...viewed].slice(-200)));
  } catch {
    /* ignore */
  }
}

function humanizeProjectId(id) {
  return String(id || "")
    .replace(/-[0-9a-f]{6,}$/i, "")
    .replace(/-/g, " ")
    .trim() || String(id || "");
}

function relativeProjectTime(updatedAt) {
  const ms = Date.now() - Number(updatedAt || 0);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return t("刚刚");
  if (minutes < 60) return t("{n} 分钟前", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{n} 小时前", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("{n} 天前", { n: days });
  return new Date(Number(updatedAt)).toLocaleDateString(lang() === "en" ? "en-US" : "zh-CN");
}

function formatProjectSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function projectRow(p, viewed) {
  const row = document.createElement("div");
  row.className = "proj-row";
  row.title = t("点击打开");
  const isGen = p.group === "generated";
  const unread = isGen && !viewed.has(String(p.path));
  const dot = document.createElement("span");
  dot.className = `proj-dot${unread ? " unread" : ""}`;
  const meta = document.createElement("div");
  meta.className = "proj-meta";
  const title = document.createElement("a");
  title.href = `./index.html?project=${encodeURIComponent(p.path)}&workspace=1&lang=${lang()}`;
  title.textContent = p.title || humanizeProjectId(p.id);
  if (unread) title.classList.add("unread");
  const sub = document.createElement("small");
  const when = relativeProjectTime(p.updatedAt);
  const size = isGen ? formatProjectSize(p.sizeBytes) : "";
  sub.textContent = isGen ? `${p.pageCount ? t("{n} 页", { n: p.pageCount }) : t("讨论中")}${when ? ` · ${when}` : ""}${size ? ` · ${size}` : ""}` : t("示例项目");
  meta.append(title, sub);
  row.append(dot, meta);
  row.addEventListener("click", () => {
    markProjectViewed(p.path);
    location.href = `./index.html?project=${encodeURIComponent(p.path)}&workspace=1&lang=${lang()}`;
  });
  if (isGen) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "proj-trash";
    del.title = t("删除该项目");
    del.setAttribute("aria-label", t("删除项目{n}", { n: p.title || humanizeProjectId(p.id) }));
    del.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-9 0l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13"/></svg>`;
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const name = p.title || humanizeProjectId(p.id);
      if (!window.confirm(t("确定删除「{name}」吗？整目录移除，不可恢复。", { name }))) return;
      try {
        const data = await fetch(nativeApi("/api/projects"), {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: p.path }),
        }).then((r) => r.json());
        if (data.error) throw new Error(data.error);
        showToast(t("已删除「{name}」", { name }));
        paintProjectList(data.projects || []);
      } catch (error) {
        showToast(error instanceof Error ? error.message : t("删除失败"));
      }
    });
    row.append(del);
  }
  return row;
}

// Demo 期多人共用：只显示这台浏览器打开过的生成项目，别人的稿子不
// 列出来，避免点进去互相抢。改回 false 即恢复全部可见。
const SHOW_ONLY_VIEWED_PROJECTS = false;
// Demo 期不展示示例项目（文件保留，测试和默认工程仍可用）。
const SHOW_FIXTURE_PROJECTS = false;

function paintProjectList(projects) {
  const list = document.getElementById("project-list");
  if (!list) return;
  const viewed = loadViewedProjects();
  const gen = (projects || [])
    .filter((p) => p.group === "generated")
    .filter((p) => !SHOW_ONLY_VIEWED_PROJECTS || viewed.has(String(p.path)))
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  const fixtures = SHOW_FIXTURE_PROJECTS
    ? (projects || []).filter((p) => p.group !== "generated")
    : [];
  list.innerHTML = "";
  for (const p of [...gen, ...fixtures]) {
    list.append(projectRow(p, viewed));
  }
  if (!gen.length && !fixtures.length) {
    const empty = document.createElement("p");
    empty.className = "proj-empty";
    empty.textContent = t("还没有项目，输入一句话生成第一份演示文稿。");
    list.append(empty);
  }
}

let lastProjects = [];

async function renderProjects() {
  try {
    const data = await fetch(nativeApi("/api/projects")).then((r) => r.json());
    lastProjects = data.projects || [];
    paintProjectList(lastProjects);
  } catch {
    /* panel stays empty; opening still works from resume links */
  }
}

document.getElementById("btn-upgrade").addEventListener("click", () => {
  showToast(t("本地离线工作台 · 无账号套餐"));
});

document.getElementById("btn-agent-back").addEventListener("click", () => {
  goHome();
});

function toolIcon(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("wait")) return "◌";
  if (n.includes("think") || n.includes("plan")) return "◉";
  if (n.includes("read")) return "▣";
  if (n.includes("research")) return "⌕";
  if (n.includes("todo")) return "☑";
  if (n.includes("write") || n.includes("page")) return "✎";
  if (n.includes("review") || n.includes("render")) return "◎";
  if (n.includes("terminal") || n.includes("export")) return ">_";
  if (n.includes("edit") || n.includes("compose")) return "✎";
  return "●";
}

function updateRunProgress(step) {
  const box = document.getElementById("run-progress");
  const label = document.getElementById("run-progress-label");
  const bar = document.getElementById("run-progress-bar");
  if (!box || !label || !bar) return;
  const text = `${step.summary || ""} ${step.detail || ""}`;
  const m = text.match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return;
  box.hidden = false;
  label.textContent = t("第 {a} / {b} 页", { a: m[1], b: m[2] });
  bar.max = Number(m[2]);
  bar.value = Number(m[1]);
}

function hideRunProgress() {
  const box = document.getElementById("run-progress");
  if (box) box.hidden = true;
}

function resetGenerationShowcase(title) {
  const box = document.getElementById("generation-showcase");
  if (!box) return;
  box.hidden = false;
  box.classList.remove("is-complete");
  document.getElementById("generation-showcase-title").textContent = title || t("正在生成演示文稿");
  document.getElementById("generation-showcase-detail").textContent = t("先搭结构，再逐页写入、渲染和审阅。每个完成页面都会立即出现。");
  const image = document.getElementById("generation-live-image");
  image.hidden = true;
  image.removeAttribute("src");
  image.removeAttribute("data-page-id");
  document.getElementById("generation-empty").hidden = false;
  document.getElementById("generation-live-badge").textContent = t("准备中");
  document.getElementById("generation-filmstrip").replaceChildren();
  document.getElementById("generation-live-open").hidden = true;
  document.querySelectorAll("#generation-stage-line span").forEach((node, index) => {
    node.classList.toggle("is-active", index === 0);
    node.classList.remove("is-done");
  });
}

function paintGenerationShowcase(snap, { sessionId, projectPath, wantPages = 0 } = {}) {
  const box = document.getElementById("generation-showcase");
  if (!box || !snap) return;
  box.hidden = false;
  const phase = snap.phase?.kind || "generating";
  const pageCount = Number(snap.project?.pageCount) || 0;
  const inspection = snap.inspection || {};
  const pages = Array.isArray(inspection.pages) ? inspection.pages : [];
  const reviewed = pages.filter((page) => page.visualReview === "pass").length;
  let stage = pageCount > 0 ? 1 : 0;
  if (inspection.structuralReview && inspection.structuralReview !== "missing") stage = 2;
  if (inspection.composeReady || phase === "complete") stage = 3;
  [...document.querySelectorAll("#generation-stage-line span")].forEach((node, index) => {
    node.classList.toggle("is-active", index === stage && phase !== "complete");
    node.classList.toggle("is-done", phase === "complete" || index < stage);
  });
  box.classList.toggle("is-complete", phase === "complete");
  const latestRaster = [...pages].reverse().find((page) => page.raster);
  const cover = snap.phase?.cover;
  const pageId = latestRaster?.pageId || cover?.pageId;
  const rasterUrl = pageId && sessionId
    ? `/slides/raster/${encodeURIComponent(sessionId)}/${encodeURIComponent(pageId)}`
    : cover?.rasterUrl;
  const image = document.getElementById("generation-live-image");
  if (rasterUrl) {
    const revision = latestRaster?.revision || cover?.revision || pageCount;
    const nextId = `${pageId}:${revision}`;
    if (image.dataset.pageId !== nextId) {
      image.dataset.pageId = nextId;
      image.src = `${rasterUrl}?v=${encodeURIComponent(revision)}&t=${Date.now()}`;
    }
    image.hidden = false;
    document.getElementById("generation-empty").hidden = true;
  }
  document.getElementById("generation-live-badge").textContent = phase === "complete"
    ? t("{n} 页 · 已完成", { n: pageCount })
    : phase === "paused"
      ? (pageCount ? t("{n} 页 · 已暂停", { n: pageCount }) : t("已暂停"))
      : phase === "failed"
        ? t("生成失败")
        : pageCount
          ? t("{n} 页 · 实时更新", { n: pageCount })
          : t("搭建结构中");
  const liveBadge = document.getElementById("generation-live-badge");
  if (liveBadge && phase === "paused") {
    const raw = String(snap.phase?.detail || snap.error?.detail || "");
    liveBadge.title = /2056|Token Plan|用量上限/.test(raw)
      ? t("MiniMax Token Plan 额度已用尽。请换模型或充值后再继续。")
      : (raw || t("生成已暂停"));
  }
  const target = Math.max(pageCount, Number(wantPages) || 0, pages.length, 1);
  const filmstrip = document.getElementById("generation-filmstrip");
  filmstrip.replaceChildren();
  for (let index = 0; index < Math.min(target, 24); index += 1) {
    const tile = document.createElement("span");
    const page = pages[index];
    tile.textContent = String(index + 1).padStart(2, "0");
    tile.classList.toggle("is-written", index < pageCount || Boolean(page));
    tile.classList.toggle("is-reviewed", page?.visualReview === "pass");
    tile.title = page?.visualReview === "pass"
      ? t("第 {index} 页已通过视觉检查", { index: index + 1 })
      : index < pageCount
        ? t("第 {index} 页已写入", { index: index + 1 })
        : t("第 {index} 页待生成", { index: index + 1 });
    filmstrip.append(tile);
  }
  const detail = document.getElementById("generation-showcase-detail");
  detail.textContent = phase === "complete"
    ? t("共 {pages} 页。写入、渲染、视觉检查和封板记录会保留在编辑器的 AI 工作区。", { pages: pageCount })
    : reviewed
      ? t("已写入 {pages} 页，{reviewed} 页通过视觉检查。你现在就可以进入编辑器实时观看。", { pages: pageCount, reviewed })
      : pageCount
        ? t("已写入 {pages} 页，正在渲染并检查版式。你现在就可以进入编辑器实时观看。", { pages: pageCount })
        : t("正在读取资料并确定结构，第一张页面写入后会立即出现。");
  const live = document.getElementById("generation-live-open");
  live.hidden = !(projectPath && pageCount > 0);
  if (!live.hidden) {
    live.textContent = phase === "complete" ? t("打开编辑器并查看生成历程") : t("在编辑器中实时观看");
    live.onclick = () => {
      location.href = editorHref(projectPath, { workspace: true, sessionId, live: phase !== "complete" });
    };
  }
}

async function downloadDeckPptx(projectPath) {
  const open = await fetch(nativeApi("/api/open"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath }),
  });
  if (!open.ok) throw new Error((await open.json().catch(() => ({}))).error || t("打不开这份文稿"));
  const res = await fetch(nativeApi("/api/export"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format: "pptx" }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t("导出失败"));
  const blob = await res.blob();
  const header = res.headers.get("content-disposition") || "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  const name = decodeURIComponent(star?.[1] || plain?.[1] || "deck.pptx");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return name;
}

async function readGenerateStream(res, { paintStep, paintRuntime, card, still, onRun }) {
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || res.statusText);
  }
  if (!res.body) throw new Error(t("生成未返回结果"));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let doneData = null;
  const handle = (ev) => {
    if (ev.type === "run" && typeof ev.path === "string" && ev.path) onRun?.(ev.path);
    if (ev.type === "waiting") paintWaitingRow(card, ev);
    if (ev.type === "runtime" && ev.event) paintRuntime(ev.event);
    if (ev.type === "step") {
      clearWaitingRow(card);
      paintStep(ev.step, ev.index);
    }
    if (ev.type === "done") doneData = ev;
    if (ev.type === "error") throw new Error(ev.error);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (still && !still()) {
      try { await reader.cancel(); } catch { /* already aborted */ }
      return null;
    }
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      handle(ev);
    }
  }
  const tail = buf.trim();
  if (tail) {
    try {
      handle(JSON.parse(tail));
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
  return doneData;
}

// Providers whose home profile declares supported reasoning efforts.
let providerEfforts = new Map();

function effortsForProvider(id) {
  return providerEfforts.has(id) ? providerEfforts.get(id) : undefined;
}

/**
 * The levels that apply to the CURRENT selection. A provider-wide union cannot
 * answer this: OpenRouter ships both models that reason and models that refuse
 * an effort, and the kernel validates the value against the model.
 */
function selectedEfforts() {
  const offer = currentPiOffer();
  const perModel = offer?.modelEfforts?.[selectedPiModel()];
  return Array.isArray(perModel) ? perModel : effortsForProvider(offer?.id);
}

function paintEffortControl() {
  const wrap = document.getElementById("pi-effort-wrap");
  const group = document.getElementById("pi-effort");
  if (!wrap || !group) return;
  const hadFocus = group.contains(document.activeElement);
  const efforts = selectedEfforts();
  group.replaceChildren();
  if (!efforts?.length) {
    wrap.hidden = true;
    currentEffort = "";
    return; // this model declares no levels → never offer or send one
  }
  wrap.hidden = false;
  if (!efforts.includes(currentEffort)) currentEffort = efforts.includes("high") ? "high" : efforts[0];
  for (const id of efforts) {
    const radio = document.createElement("button");
    radio.type = "button";
    radio.dataset.effort = id;
    radio.textContent = id;
    radio.setAttribute("role", "radio");
    radio.setAttribute("aria-checked", String(id === currentEffort));
    radio.tabIndex = id === currentEffort ? 0 : -1;
    group.append(radio);
  }
  if (hadFocus) group.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
}

function runHubGenerate() {
  if (creationInFlight) return;
  let request;
  try {
    const efforts = selectedEfforts();
    const rawEffort = currentEffort;
    request = buildGenerationRequest({
      catalog: generationCatalog, brief: brief.value, kind, layout, designSystemId, attachments,
      provider: selectedPiProvider(),
      model: selectedPiModel(),
      reasoningEffort: efforts?.includes(rawEffort) ? rawEffort : undefined,
    });
  } catch (error) {
    setLaunchStatus(error.message);
    showToast(error.message);
    return;
  }
  // Respond at once: the editor shows the message and runs the model's intent
  // read and session creation itself (launch-flow.js), instead of the Hub
  // sitting still for several seconds before it navigates.
  const launchId = saveLaunch(request);
  if (!launchId) {
    setLaunchStatus(t("浏览器禁止了本地会话存储，无法打开编辑器。"));
    return;
  }
  creationInFlight = true;
  syncCreateButton();
  hideMenus();
  location.replace(launchHref(launchId));
}

send.addEventListener("click", () => {
  runHubGenerate();
});
window.addEventListener("pageshow", (event) => {
  // Returning from the back/forward cache must not leave Send locked.
  if (event.persisted && creationInFlight) {
    creationInFlight = false;
    syncCreateButton();
  }
});

const healthRequestGate = createHealthRequestGate();

function currentHealthSelection() {
  return {
    provider: selectedPiProvider(),
    model: selectedPiModel(),
  };
}

async function refreshHealth() {
  let data = {};
  const request = healthRequestGate.begin(currentHealthSelection());
  const { provider, model } = request.selection;
  const qs = new URLSearchParams();
  if (provider) qs.set("provider", provider);
  if (model) qs.set("model", model);
  serverCapability = null;
  serverMinimaxReady = false;
  piProductLoggedIn = false;
  paintCapability(null, { state: "loading" });
  try {
    const res = await fetch("/slides/health" + (qs.toString() ? `?${qs}` : ""));
    if (!res.ok) throw new Error("slides health");
    data = await res.json();
  } catch {
    data = await fetch(nativeApi("/api/health")).then((r) => r.json()).catch(() => ({}));
    if (!healthRequestGate.isCurrent(request, currentHealthSelection())) return data;
    serverDshReady = data.product === "DSH SlideStudio";
    serverCapability = null;
    serverMinimaxReady = false;
    piProductLoggedIn = false;
    paintCapability(null, { state: "error" });
    setModelChip(model || "AI Agent");
    return data;
  }
  if (!healthRequestGate.isCurrent(request, currentHealthSelection())) return data;
  if (!healthSelectionMatches(request.selection, data.selection)) {
    serverCapability = null;
    serverMinimaxReady = false;
    piProductLoggedIn = false;
    paintCapability(null, { state: "mismatch" });
    setModelChip(model || "AI Agent");
    return data;
  }
  serverDshReady = data.product === "DSH SlideStudio";
  serverPiAvailable = false;
  const selection = data.selection || {};
  const offer = currentPiOffer();
  const selectedReady = selectedHealthReady(data);
  serverMinimaxReady = selectedReady;
  serverCapability = data.capability || null;
  const chipModel = model || selection.model || offer?.name || data.connection?.model;
  const piChip = !selectedReady
    ? `${offer?.name || t("供应商")} · ${t("未接入")}`
    : `${chipModel} · ${t("已接入")}`;
  piProductLoggedIn = selectedReady;
  if (serverCapability) {
    paintCapability(serverCapability, {
      piAvailable: serverDshReady,
      piAuthReady: selectedReady,
      piChip,
    });
  } else {
    paintCapability(null, { state: "error" });
  }
  setModelChip(offer?.modelNames?.[model] || model || selection.model || data.connection?.model || "AI Agent");
  return data;
}

function settingsInput(id) {
  return document.getElementById(id);
}

function fillEndpoint(prefix, endpoint) {
  const on = endpoint?.kind === "custom";
  const url = settingsInput(`${prefix}-url`);
  const key = settingsInput(`${prefix}-key`);
  const model = settingsInput(`${prefix}-model`);
  if (url) url.value = on ? endpoint.url : "";
  if (key) {
    key.value = "";
    key.placeholder = on && endpoint.apiKeySet ? t("已保存，留空则保持") : t("可选");
  }
  if (model) model.value = on ? endpoint.model || "" : "";
}

function collectEndpoint(prefix) {
  const url = String(settingsInput(`${prefix}-url`)?.value || "").trim();
  if (!url) return { kind: "off" };
  const modelEl = settingsInput(`${prefix}-model`);
  return {
    kind: "custom",
    url,
    apiKey: String(settingsInput(`${prefix}-key`)?.value || ""),
    model: String(modelEl?.value || "").trim(),
  };
}

async function loadToolSettings() {
  const data = await fetch("/slides/tool-settings").then((r) => r.json());
  const settings = data.settings || {};
  fillEndpoint("search", settings.imageSearch);
  fillEndpoint("image", settings.imageGenerate);
}

function showSettings(open, pane = "") {
  const home = document.getElementById("home-screen");
  const settings = document.getElementById("settings-screen");
  if (!home || !settings) return;
  settings.hidden = !open;
  home.hidden = open;
  // DSH 插件模式下模型接入与订阅登录归 DSH 官方设置页；即使回退到本页也不提供这两个面板。
  const dshManaged = location.pathname.startsWith("/app/");
  for (const id of ["models", "oauth"]) {
    const nav = document.querySelector(`[data-settings-pane="${id}"]`);
    if (nav) nav.hidden = dshManaged;
    const paneEl = document.getElementById(`pane-${id}`);
    if (paneEl && dshManaged) paneEl.hidden = true;
  }
  const note = document.getElementById("settings-dsh-note");
  if (note) note.hidden = !dshManaged;
  if (open) {
    const effective = dshManaged && (!pane || pane === "models" || pane === "oauth") ? "appearance" : pane;
    if (effective) selectSettingsPane(effective);
    loadToolSettings().catch(() => showToast(t("无法读取设置")));
    loadSettingsProviders().catch(() => showToast(t("无法读取供应商")));
  }
}

// DSH 插件模式（/app/ 挂载）下模型接入归 DSH 统一管理：设置齿轮先弹「前往 DSH 设置」
// 确认，确认后委托宿主打开 DSH 设置面板；宿主无应答（页面未真正挂进 DSH 时）
// 回退到产品自带设置页。
function openHostSettings(fallback) {
  if (!location.pathname.startsWith("/app/") || window.parent === window) {
    fallback();
    return;
  }
  const modal = document.getElementById("dsh-goto-modal");
  if (!modal) {
    fallback();
    return;
  }
  modal.hidden = false;
}

function hideGotoModal() {
  const modal = document.getElementById("dsh-goto-modal");
  if (modal) modal.hidden = true;
}

document.getElementById("btn-settings")?.addEventListener("click", () => openHostSettings(() => showSettings(true)));
document.getElementById("btn-goto-cancel")?.addEventListener("click", hideGotoModal);
document.getElementById("btn-goto-dsh")?.addEventListener("click", () => {
  const button = document.getElementById("btn-goto-dsh");
  if (button.disabled) return;
  button.disabled = true;
  let accepted = false;
  const done = () => {
    window.removeEventListener("message", onAck);
    clearTimeout(timeout);
    button.disabled = false;
  };
  const onAck = (event) => {
    if (event.origin !== location.origin || event.source !== window.parent) return;
    if (event.data?.type === "oss:dsh-settings-accepted") {
      accepted = true;
      hideGotoModal();
    } else if (event.data?.type === "oss:dsh-settings-opened") {
      hideGotoModal();
      done();
    } else if (event.data?.type === "oss:dsh-settings-failed") {
      hideGotoModal();
      showToast(t("无法打开 DSH 设置，请从工作空间的账号菜单打开设置。"));
      done();
    }
  };
  window.addEventListener("message", onAck);
  const timeout = setTimeout(() => {
    done();
    if (!accepted) {
      hideGotoModal();
      showSettings(true);
    }
  }, 610_000); // Host may wait for the user to finish an onboarding dialog.
  window.parent.postMessage({ type: "oss:open-dsh-settings" }, location.origin);
  setTimeout(() => {
    if (!accepted && button.disabled) {
      done();
      hideGotoModal();
      showToast(t("无法打开 DSH 设置，请从工作空间的账号菜单打开设置。"));
    }
  }, 1500);
});
document.getElementById("btn-settings-back")?.addEventListener("click", () => showSettings(false));

let settingsProviderRows = [];
let settingsPresets = [];
let settingsOauthByRoute = new Map();
let byokEditId = "";

function keyProviders() {
  return settingsProviderRows.filter((row) => (row.methods || []).includes("api_key"));
}

function oauthProviders() {
  return settingsProviderRows.filter((row) => (row.methods || []).includes("oauth"));
}

function settingsOauthId(provider) {
  return settingsOauthByRoute.get(provider.id)?.id || String(provider.id || "").replace(/^pi-/, "");
}

function settingsOauthSignedIn(provider) {
  return settingsOauthByRoute.get(provider.id)?.account?.status === "signed-in";
}

function renderByokList() {
  const list = document.getElementById("byok-list");
  if (!list) return;
  list.innerHTML = "";
  for (const provider of keyProviders()) {
    const row = document.createElement("li");
    row.className = "byok-row";
    const name = document.createElement("span");
    name.className = "byok-name";
    name.textContent = provider.name || provider.id;
    row.append(name);
    if (provider.userAdded) {
      const tag = document.createElement("span");
      tag.className = "byok-tag";
      tag.textContent = t("自定义");
      row.append(tag);
    }
    const dot = document.createElement("span");
    dot.className = `byok-dot${provider.ready ? " is-on" : ""}`;
    dot.title = provider.ready ? t("API 密钥已配置") : t("未配置");
    row.append(dot);
    const actions = document.createElement("div");
    actions.className = "byok-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = t("编辑");
    edit.setAttribute("aria-label", `${t("编辑")} ${provider.name || provider.id}`);
    edit.addEventListener("click", () => {
      byokEditId = byokEditId === provider.id ? "" : provider.id;
      renderByokList();
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = t("删除");
    del.setAttribute("aria-label", `${t("删除")} ${provider.name || provider.id}`);
    del.addEventListener("click", async () => {
      const path = provider.userAdded
        ? `/slides/providers/${encodeURIComponent(provider.id)}`
        : `/slides/providers/${encodeURIComponent(provider.id)}/key`;
      await fetch(path, { method: "DELETE" }).then((r) => r.json());
      byokEditId = "";
      await afterProviderChange();
    });
    actions.append(edit, del);
    row.append(actions);
    if (byokEditId === provider.id) {
      const form = document.createElement("div");
      form.className = "byok-edit";
      const input = document.createElement("input");
      input.type = "password";
      input.autocomplete = "off";
      input.placeholder = provider.ready ? t("已保存，填新 Key 覆盖") : t("粘贴 API Key");
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = t("保存");
      save.addEventListener("click", async () => {
        const data = await fetch(`/slides/providers/${encodeURIComponent(provider.id)}/key`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: input.value.trim() }),
        }).then((r) => r.json());
        if (data.error) {
          showToast(data.error);
          return;
        }
        byokEditId = "";
        await afterProviderChange();
        showToast(t("已保存"));
      });
      form.append(input, save);
      row.append(form);
    }
    list.append(row);
  }
  if (keyProviders().length === 0) {
    const empty = document.createElement("li");
    empty.className = "provider-models";
    empty.textContent = t("还没有 API Key 提供方。");
    list.append(empty);
  }
}

function renderProviderList() {
  const list = document.getElementById("provider-list");
  if (!list) return;
  list.innerHTML = "";
  for (const provider of oauthProviders()) {
    const row = document.createElement("div");
    row.className = "provider-row";
    const head = document.createElement("div");
    head.className = "provider-head";
    const name = document.createElement("strong");
    name.textContent = provider.name || provider.id;
    const badge = document.createElement("span");
    badge.className = `provider-badge${provider.ready ? " is-on" : ""}`;
    const viaOauth = settingsOauthSignedIn(provider);
    badge.textContent = !provider.ready ? t("未登录") : viaOauth ? t("已登录 · 账号") : t("已登录 · Key");
    head.append(name, badge);
    row.append(head);
    const models = document.createElement("small");
    models.className = "provider-models";
    models.textContent = (provider.models || []).join(" · ") || t("模型列表由供应商返回");
    row.append(models);
    if (provider.nativeSearch) {
      const nativeHint = document.createElement("small");
      nativeHint.className = "provider-models";
      nativeHint.textContent = provider.ready ? t("联网检索由模型自带") : t("登录后联网检索由模型自带");
      row.append(nativeHint);
    }
    const status = document.createElement("span");
    status.className = "provider-status llm-status";
    const actions = document.createElement("div");
    actions.className = "provider-actions";
    if ((provider.methods || []).includes("api_key")) {
      const wrap = document.createElement("div");
      wrap.className = "provider-key";
      const input = document.createElement("input");
      input.type = "password";
      input.autocomplete = "off";
      input.placeholder = provider.ready && !viaOauth ? t("已保存，填新 Key 覆盖") : t("粘贴 API Key");
      input.setAttribute("aria-label", `${provider.name} API Key`);
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = t("保存 Key");
      save.addEventListener("click", async () => {
        status.textContent = t("保存中…");
        try {
          const data = await fetch(`/slides/providers/${encodeURIComponent(provider.id)}/key`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey: input.value.trim() }),
          }).then((r) => r.json());
          if (data.error) throw new Error(data.error);
          input.value = "";
          status.textContent = t("已保存");
          await afterProviderChange();
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : t("保存失败");
        }
      });
      wrap.append(input, save);
      row.append(wrap);
    }
    if ((provider.methods || []).includes("oauth")) {
      const wrap = document.createElement("div");
      wrap.className = "provider-oauth";
      const login = document.createElement("button");
      login.type = "button";
      login.textContent = viaOauth ? t("重新授权") : t("账号登录");
      login.addEventListener("click", () => settingsOauthLogin(provider, status, wrap));
      wrap.append(login);
      row.append(wrap);
    }
    if (provider.ready && (settingsOauthSignedIn(provider) || provider.keyStored)) {
      const logout = document.createElement("button");
      logout.type = "button";
      logout.className = "provider-logout";
      logout.textContent = t("退出登录");
      logout.addEventListener("click", async () => {
        status.textContent = t("退出中…");
        try {
          if (settingsOauthSignedIn(provider)) {
            const data = await fetch("/plugins/dsh-oauth-login/auth/logout", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ provider: settingsOauthId(provider) }),
            }).then((r) => r.json());
            if (data.error) throw new Error(data.error);
          }
          await fetch(`/slides/providers/${encodeURIComponent(provider.id)}/key`, {
            method: "DELETE",
          }).then((r) => r.json());
          status.textContent = t("已退出");
          await afterProviderChange();
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : t("退出失败");
        }
      });
      actions.append(logout);
    } else if (provider.ready) {
      const note = document.createElement("small");
      note.className = "provider-models";
      note.textContent = t("Key 来自本机环境，重启后仍有效");
      actions.append(note);
    }
    row.append(actions, status);
    list.append(row);
  }
  if (settingsProviderRows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "provider-models";
    empty.textContent = t("没有可用供应商，请稍后重试。");
    list.append(empty);
  }
}

async function afterProviderChange() {
  await loadSettingsProviders();
  await refreshPiLogin().catch(() => {});
  await refreshHealth().catch(() => {});
}

async function loadSettingsProviders() {
  const status = document.getElementById("providers-status");
  const [provData, oauthRows] = await Promise.all([
    fetch("/slides/providers").then((r) => r.json()),
    fetch("/plugins/dsh-oauth-login/auth/status")
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []),
  ]);
  settingsOauthByRoute = new Map();
  for (const row of Array.isArray(oauthRows) ? oauthRows : []) {
    if (/antigravity|\bagy-/i.test(`${row.id || ""} ${row.route || ""}`)) continue;
    if (row.route) settingsOauthByRoute.set(row.route, row);
  }
  const providers = Array.isArray(provData.providers) ? provData.providers : [];
  settingsPresets = Array.isArray(provData.presets) ? provData.presets : [];
  settingsProviderRows = providers;
  if (status) status.textContent = "";
  renderProviderList();
  renderByokList();
}

async function settingsOauthLogin(provider, status, wrap) {
  status.textContent = t("正在发起授权…");
  try {
    const challenge = await fetch("/plugins/dsh-oauth-login/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: settingsOauthId(provider) }),
    }).then((r) => r.json());
    if (challenge.error) throw new Error(challenge.error);
    if (challenge.kind === "input" || challenge.input) {
      const input = document.createElement("input");
      input.type = "text";
      input.autocomplete = "off";
      input.placeholder = challenge.input?.placeholder || challenge.input?.message || t("输入验证码");
      const submit = document.createElement("button");
      submit.type = "button";
      submit.textContent = t("继续");
      submit.addEventListener("click", async () => {
        status.textContent = t("验证中…");
        try {
          const data = await fetch("/plugins/dsh-oauth-login/auth/complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: settingsOauthId(provider), value: input.value.trim() }),
          }).then((r) => r.json());
          if (data.error) throw new Error(data.error);
          status.textContent = t("已登录");
          await afterProviderChange();
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : t("验证失败");
        }
      });
      wrap.append(input, submit);
      status.textContent = challenge.input?.message || t("按提示完成授权");
      return;
    }
    if (challenge.url) window.open(challenge.url, "_blank", "noopener");
    status.textContent = t("请在浏览器完成授权…");
    for (let i = 0; i < 90; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await loadSettingsProviders();
      const current = settingsProviderRows.find((row) => row.id === provider.id);
      if (current?.ready) break;
    }
    const done = settingsProviderRows.find((row) => row.id === provider.id)?.ready;
    status.textContent = done ? t("已登录") : t("还没登录完成，请再试");
    showToast(done ? t("已登录，可以生成") : t("还没登录完成，请再试"));
    await refreshPiLogin().catch(() => {});
    await refreshHealth().catch(() => {});
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : t("授权失败");
  }
}
function selectSettingsPane(pane) {
  document.querySelectorAll("[data-settings-pane]").forEach((item) => {
    item.classList.toggle("is-on", item.getAttribute("data-settings-pane") === pane);
  });
  for (const id of ["models", "oauth", "tools", "appearance"]) {
    const el = document.getElementById(`pane-${id}`);
    if (el) el.hidden = id !== pane;
  }
}
document.querySelectorAll("[data-settings-pane]").forEach((btn) => {
  btn.addEventListener("click", () => selectSettingsPane(btn.getAttribute("data-settings-pane")));
});

function paintThemeOptions() {
  const host = document.getElementById("theme-options");
  if (!host) return;
  const active = currentTheme();
  host.replaceChildren(...THEMES.map((theme) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "theme-option";
    option.dataset.themeId = theme.id;
    option.setAttribute("role", "radio");
    option.setAttribute("aria-checked", String(theme.id === active));
    const swatch = document.createElement("span");
    swatch.className = "theme-swatch";
    swatch.dataset.themeSwatch = theme.id;
    const name = document.createElement("b");
    name.textContent = t(theme.name);
    const note = document.createElement("small");
    note.textContent = t(theme.note);
    option.append(swatch, name, note);
    option.addEventListener("click", () => {
      applyTheme(theme.id);
      paintThemeOptions();
      document.querySelector(`[data-theme-id="${theme.id}"]`)?.focus();
    });
    return option;
  }));
}
paintThemeOptions();

function unusedPresets() {
  const used = new Set(keyProviders().map((row) => row.id));
  return settingsPresets.filter((row) => !used.has(row.id));
}

async function addByokProvider(body) {
  const res = await fetch("/slides/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || t("无法添加提供方"));
  await afterProviderChange();
}

document.getElementById("btn-add-provider")?.addEventListener("click", () => {
  const picker = document.getElementById("preset-picker");
  const custom = document.getElementById("custom-provider-form");
  if (custom) custom.hidden = true;
  if (!picker) return;
  picker.hidden = !picker.hidden;
  picker.innerHTML = "";
  picker.className = "byok-form preset-choice";
  const unused = unusedPresets();
  if (unused.length === 0) {
    picker.textContent = t("常用提供方都已在列表中，请添加自定义提供方。");
    return;
  }
  for (const preset of unused) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `${preset.name} · ${preset.baseURL}`;
    btn.addEventListener("click", async () => {
      try {
        await addByokProvider({ preset: preset.id });
        picker.hidden = true;
        byokEditId = preset.id;
        renderByokList();
        showToast(t("已添加 {name}，请填入 API Key", { name: preset.name }));
      } catch (error) {
        showToast(error instanceof Error ? error.message : t("添加失败"));
      }
    });
    picker.append(btn);
  }
});

document.getElementById("btn-add-custom-provider")?.addEventListener("click", () => {
  const picker = document.getElementById("preset-picker");
  const form = document.getElementById("custom-provider-form");
  if (picker) picker.hidden = true;
  if (form) form.hidden = !form.hidden;
});
document.getElementById("btn-custom-cancel")?.addEventListener("click", () => {
  const form = document.getElementById("custom-provider-form");
  if (form) form.hidden = true;
});
document.getElementById("custom-provider-form")?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const status = document.getElementById("custom-status");
  if (status) status.textContent = t("保存中…");
  try {
    const models = String(document.getElementById("custom-models")?.value || "")
      .split(",")
      .map((row) => row.trim())
      .filter(Boolean);
    await addByokProvider({
      id: document.getElementById("custom-id")?.value,
      name: document.getElementById("custom-name")?.value,
      baseURL: document.getElementById("custom-base")?.value,
      apiKeyEnv: `${String(document.getElementById("custom-id")?.value || "custom").trim().replace(/-/g, "_").toUpperCase()}_API_KEY`,
      models,
      apiKey: document.getElementById("custom-key")?.value,
    });
    if (status) status.textContent = t("已保存");
    const form = document.getElementById("custom-provider-form");
    if (form) form.hidden = true;
    showToast(t("已添加自定义提供方"));
  } catch (error) {
    if (status) status.textContent = error instanceof Error ? error.message : t("保存失败");
  }
});

document.getElementById("btn-settings-save")?.addEventListener("click", async () => {
  const status = document.getElementById("settings-status");
  if (status) status.textContent = t("保存中…");
  try {
    const res = await fetch("/slides/tool-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        imageSearch: collectEndpoint("search"),
        imageGenerate: collectEndpoint("image"),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || t("保存失败"));
    fillEndpoint("search", data.settings.imageSearch);
    fillEndpoint("image", data.settings.imageGenerate);
    if (status) status.textContent = t("已保存");
    await refreshHealth();
  } catch (error) {
    if (status) status.textContent = error instanceof Error ? error.message : t("保存失败");
  }
});

// Repaint dynamic sections when the UI language flips.
onLangChange(() => {
  paintChip();
  paintGrid();
  renderCatalogTabs();
  paintAttachments();
  paintProjectList(lastProjects);
  paintThemeOptions();
  paintPiPanel();
  renderByokList();
  renderProviderList();
  paintEffortControl();
});

// Initial network completion must not close a panel the user has already opened.
Promise.all([refreshPiLogin(), renderProjects()]).catch(() => {});
