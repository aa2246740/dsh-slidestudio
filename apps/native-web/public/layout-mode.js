/**
 * Layout mode (masters-layouts §5.2): the canvas session owns every rule and refusal; this module
 * paints the chrome and sends its commands. Its DOM lives in index.html (ids listed in
 * `LAYOUT_MODE_ELEMENT_IDS`); user-visible strings are Chinese source keys translated with `t`.
 */
import { t } from "./i18n.js";

/** Oracle control ids of the eight layout-mode controls (masters §5.3). */
export const LAYOUT_CONTROL = Object.freeze({
  apply: "theme.layout.apply",
  enter: "theme.layout.enter",
  exit: "theme.layout.exit",
  select: "theme.layout.select",
  create: "theme.layout.create",
  rename: "theme.layout.rename",
  remove: "theme.layout.delete",
  pageNumber: "insert.pagenumber",
});

/** Every element id createLayoutMode looks up; index.html must carry each of them. */
export const LAYOUT_MODE_ELEMENT_IDS = Object.freeze([
  "layout-rail",
  "layout-banner",
  "layout-banner-text",
  "layout-banner-note",
  "layout-exit",
  "layout-page-section",
  "layout-apply",
  "layout-enter",
  "layout-create-first",
  "layout-page-note",
  "btn-insert-pagenumber",
  "btn-rail",
  "btn-rail-view",
  "slide",
]);

/** Inserts a layout refuses. They stay visible but disabled, with the reason as their tip. */
const GRAPHIC_INSERTS = ["insert.table", "insert.chart", "insert.smartart"];
const GRAPHIC_REFUSAL = "版式里不能放图表/表格";
/** Longest layout name the canvas session accepts (layout-surface.ts). */
const NAME_MAX = 24;

/** The layout or master the editor is on, or null on a page. @param {any} m @returns {any} */
export function layoutSurface(m) {
  const surface = m?.layoutPanel?.surface;
  return surface && surface.kind !== "page" ? surface : null;
}

/** The layout or master edit a page-mode undo would revert. @param {any} m model before the undo
 * @returns {{scope: string, id: string, name: string} | null} */
export function undoneLayoutMark(m) {
  if (layoutSurface(m)) return null;
  return m?.layoutPanel?.undoMark ?? null;
}

/** @param {any} m */
function hasElementSelection(m) {
  const kind = m?.selection?.kind;
  return kind === "element" || kind === "multi";
}

/** Whether the page's 版式 section shows, with layouts to use; app.js keeps the property panel
 * open for it even while the chat is open. @param {any} m @returns {boolean} */
export function pageLayoutOpen(m) {
  const layouts = m?.layoutPanel?.layouts ?? [];
  return !layoutSurface(m) && !hasElementSelection(m) && !m?.presenting && layouts.length > 0;
}

/** @template {keyof HTMLElementTagNameMap} K @param {K} tag @param {string} [className]
 * @param {string} [text] @returns {HTMLElementTagNameMap[K]} */
function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A plain rail button. @param {string} text @param {string} action @param {string} [control] */
function toolButton(text, action, control) {
  const node = make("button", "", text);
  node.type = "button";
  node.dataset.action = action;
  if (control) node.setAttribute("data-control", control);
  return node;
}

/** @param {string} id @returns {HTMLElement} */
function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`layout mode needs #${id} in the editor page`);
  return node;
}

/** @param {EventTarget | null} target @param {string} selector */
function within(target, selector) {
  const node = /** @type {{closest?: (value: string) => Element | null} | null} */ (target);
  return typeof node?.closest === "function" ? node.closest(selector) : null;
}

/** The list rows of the 母版/版式 rail: the master first, then each layout. @param {any} m */
function railRows(m) {
  /** @type {{scope: string, id: string, name: string, meta: string}[]} */
  const rows = [];
  const master = m.layoutPanel.master;
  if (master) rows.push({ scope: "master", id: master.id, name: master.name, meta: t("母版") });
  for (const layout of m.layoutPanel.layouts ?? []) {
    rows.push({
      scope: "layout",
      id: layout.id,
      name: layout.name,
      meta: t("{count} 页使用", { count: layout.useCount }),
    });
  }
  return rows;
}

/** @param {any} m @param {any} surface */
function bannerText(m, surface) {
  return surface.kind === "layout"
    ? t("正在编辑版式『{name}』· {count} 页使用", {
        name: surface.name ?? "",
        count: surface.useCount ?? 0,
      })
    : t("正在编辑母版『{name}』", { name: m.layoutPanel.master?.name ?? surface.name ?? "" });
}

/** The note under the page's 版式 dropdown. @param {number} count @param {unknown} current */
function pageNoteText(count, current) {
  if (count === 0) return t("这份文稿还没有版式。新建一个版式后，页面可以套用它。");
  return current === undefined ? t("这一页没有版式。选择一个版式后，可以编辑它。") : "";
}

/**
 * @typedef {{
 *   command: (cmd: string, payload?: Record<string, any>) => Promise<unknown>,
 *   showToast: (message: string) => void,
 *   paintSlide: (target: HTMLElement, model: any, opts?: {interactive?: boolean}) => void,
 *   getView: () => any,
 * }} LayoutModeDeps
 * @typedef {{kind: "rename" | "delete", layoutId: string, value: string}} PendingLayoutForm
 */

/** The layout-mode controller; every index.html node is looked up once here. @param {LayoutModeDeps} deps */
export function createLayoutMode({ command, showToast, paintSlide, getView }) {
  const rail = byId("layout-rail");
  const banner = byId("layout-banner");
  const bannerLine = byId("layout-banner-text");
  const bannerNote = byId("layout-banner-note");
  const exitButton = /** @type {HTMLButtonElement} */ (byId("layout-exit"));
  const pageSection = byId("layout-page-section");
  const applySelect = /** @type {HTMLSelectElement} */ (byId("layout-apply"));
  const enterButton = /** @type {HTMLButtonElement} */ (byId("layout-enter"));
  const createFirst = /** @type {HTMLButtonElement} */ (byId("layout-create-first"));
  const pageNote = byId("layout-page-note");
  const insertButton = /** @type {HTMLButtonElement} */ (byId("btn-insert-pagenumber"));
  const pageRailToggle = /** @type {HTMLButtonElement} */ (byId("btn-rail"));
  const pageRailView = /** @type {HTMLButtonElement} */ (byId("btn-rail-view"));
  const slide = byId("slide");

  /** The open rename form or delete confirmation. @type {PendingLayoutForm | null} */
  let pending = null;
  let focusRename = false;
  /** Whether the last chrome pass locked the layout controls (a version is being previewed). */
  let lastLocked = false;
  /** @type {Map<HTMLElement, string | null>} */
  const graphicTips = new Map();

  function repaint() {
    const m = getView();
    if (m) paintChrome(m, lastLocked);
  }

  /** Sends one command and repaints either way, so no control keeps a value the deck lacks.
   * @param {string} cmd @param {Record<string, any>} payload @param {() => void} [onDone] */
  function send(cmd, payload, onDone) {
    return command(cmd, payload).then(
      () => {
        onDone?.();
        repaint();
      },
      () => repaint(),
    );
  }

  /** @param {any} m @param {any} surface */
  function paintBanner(m, surface) {
    banner.hidden = !surface;
    if (!surface) return;
    bannerLine.textContent = bannerText(m, surface);
    bannerNote.textContent = t(GRAPHIC_REFUSAL);
  }

  /** A master or layout miniature, painted from the server's render model.
   * @param {any} m @param {{scope: string, id: string}} row */
  function thumbnail(m, row) {
    const frame = make("span", "thumb-frame layout-frame");
    const preview = (m.layoutPreviews ?? []).find(
      (/** @type {any} */ item) => item.scope === row.scope && item.id === row.id,
    );
    if (!preview?.model?.size) return frame;
    const [sw, sh] = preview.model.size;
    frame.style.aspectRatio = `${sw} / ${sh}`;
    const mini = make("div", "thumb-mini");
    frame.append(mini);
    paintSlide(mini, preview.model, { interactive: false });
    return frame;
  }

  function fitThumbnails() {
    for (const node of rail.querySelectorAll(".layout-frame > .thumb-mini")) {
      const mini = /** @type {HTMLElement} */ (node);
      const slideWidth = parseFloat(mini.style.width);
      const frameWidth = mini.parentElement?.clientWidth ?? 0;
      if (slideWidth > 0 && frameWidth > 0) {
        mini.style.transform = `scale(${frameWidth / slideWidth})`;
      }
    }
  }

  /** @param {any} m @param {{scope: string, id: string, name: string, meta: string}} row
   * @param {boolean} active @param {boolean} locked */
  function listRow(m, row, active, locked) {
    const item = make("li");
    const button = make("button", "layout-row");
    button.type = "button";
    button.disabled = locked;
    button.setAttribute("data-control", LAYOUT_CONTROL.select);
    button.dataset.scope = row.scope;
    if (row.scope === "layout") button.dataset.layoutId = row.id;
    if (active) button.setAttribute("aria-current", "true");
    const kind = row.scope === "master" ? t("母版") : t("版式");
    button.setAttribute("aria-label", t("{kind}：{name}，{meta}", { kind, name: row.name, meta: row.meta }));
    const text = make("span", "layout-text");
    text.append(make("span", "layout-name", row.name), make("span", "layout-meta", row.meta));
    button.append(thumbnail(m, row), text);
    item.append(button);
    return item;
  }

  /** @param {any} m @param {any} surface @param {boolean} locked */
  function paintRail(m, surface, locked) {
    rail.hidden = !surface;
    if (!surface) {
      rail.replaceChildren();
      pending = null;
      return;
    }
    const current = surface.kind === "layout" ? surface.layoutId : null;
    if (locked || (pending && pending.layoutId !== current)) pending = null;
    const list = make("ul", "layout-list");
    for (const row of railRows(m)) {
      const active = row.scope === "master" ? surface.kind === "master" : row.id === surface.layoutId;
      list.append(listRow(m, row, active, locked));
    }
    const head = make("header", "layout-rail-head");
    head.append(make("strong", "", t("母版与版式")));
    const create = toolButton(t("新建版式"), "create", LAYOUT_CONTROL.create);
    create.className = "layout-create";
    create.disabled = locked;
    rail.replaceChildren(head, list);
    if (surface.kind === "layout") rail.append(layoutTools(surface, locked));
    rail.append(create);
    fitThumbnails();
  }

  /** A master has no rename or delete. @param {any} surface @param {boolean} locked */
  function layoutTools(surface, locked) {
    const wrap = make("div", "layout-tools");
    if (pending && pending.layoutId === surface.layoutId) {
      wrap.append(pending.kind === "rename" ? renameForm(pending.value) : deleteConfirm(surface));
      return wrap;
    }
    const rename = toolButton(t("重命名"), "rename", LAYOUT_CONTROL.rename);
    rename.disabled = locked;
    const remove = toolButton(t("删除版式"), "delete", LAYOUT_CONTROL.remove);
    remove.disabled = locked;
    wrap.append(rename, remove);
    return wrap;
  }

  /** @param {string} value */
  function renameForm(value) {
    const form = make("form", "layout-rename");
    form.setAttribute("aria-label", t("重命名版式"));
    const label = make("label", "", t("版式名称"));
    const input = make("input");
    input.type = "text";
    input.maxLength = NAME_MAX;
    input.value = value;
    input.dataset.role = "rename-input";
    label.append(input);
    const error = make("p", "layout-note");
    error.hidden = true;
    error.dataset.role = "rename-error";
    const actions = make("div", "layout-form-actions");
    const save = make("button", "", t("保存"));
    save.type = "submit";
    actions.append(toolButton(t("取消"), "cancel"), save);
    form.append(label, error, actions);
    if (focusRename) {
      focusRename = false;
      queueMicrotask(() => input.focus());
    }
    return form;
  }

  /** @param {any} surface */
  function deleteConfirm(surface) {
    const box = make("div", "layout-confirm");
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-label", t("删除版式确认"));
    const message = t("删除后，{count} 页会失去版式『{name}』的内容；页面自有内容保留。", {
      count: surface.useCount ?? 0,
      name: surface.name ?? "",
    });
    box.append(make("p", "", message));
    const actions = make("div", "layout-form-actions");
    const confirm = toolButton(t("删除"), "confirm-delete");
    confirm.className = "layout-danger";
    actions.append(toolButton(t("取消"), "cancel"), confirm);
    box.append(actions);
    return box;
  }

  /** @param {any} m @param {any} surface @param {boolean} locked */
  function paintPageSection(m, surface, locked) {
    // The zero-page placeholder is built without a layoutPanel: no page to give a layout.
    const show = Boolean(m.layoutPanel) && !surface && !hasElementSelection(m) && !m.presenting;
    pageSection.hidden = !show;
    if (!show) return;
    const rows = m.layoutPanel.layouts ?? [];
    const current = m.layoutPanel.pageLayoutId;
    const none = make("option", "", t("无版式"));
    none.value = "";
    /** @type {HTMLOptionElement[]} */
    const options = [none];
    for (const row of rows) {
      const label = t("{name}（{count} 页）", { name: row.name, count: row.useCount });
      const option = make("option", "", label);
      option.value = row.id;
      options.push(option);
    }
    applySelect.replaceChildren(...options);
    applySelect.value = current ?? "";
    applySelect.disabled = locked || rows.length === 0;
    enterButton.hidden = rows.length === 0;
    enterButton.disabled = locked || current === undefined;
    createFirst.hidden = rows.length > 0;
    createFirst.disabled = locked;
    const note = pageNoteText(rows.length, current);
    pageNote.textContent = note;
    pageNote.hidden = note === "";
  }

  /** @param {boolean} onLayout */
  function paintGraphicInserts(onLayout) {
    for (const id of GRAPHIC_INSERTS) {
      for (const node of document.querySelectorAll(`[data-control="${id}"]`)) {
        const control = /** @type {HTMLButtonElement} */ (node);
        if (onLayout) {
          if (!graphicTips.has(control)) graphicTips.set(control, control.getAttribute("data-tip"));
          control.setAttribute("data-tip", t(GRAPHIC_REFUSAL));
          control.disabled = true;
        } else if (graphicTips.has(control)) {
          // renderChrome has set `disabled` from the session gate; only the tip is put back.
          const saved = graphicTips.get(control) ?? null;
          if (saved === null) control.removeAttribute("data-tip");
          else control.setAttribute("data-tip", saved);
          graphicTips.delete(control);
        }
      }
    }
  }

  /** Paints the layout chrome after renderChrome's data-control pass, so its disables stick.
   * @param {any} m @param {boolean} [locked] a version is previewed: controls show but cannot run */
  function paintChrome(m, locked = false) {
    lastLocked = locked;
    const surface = layoutSurface(m);
    paintBanner(m, surface);
    paintRail(m, surface, locked);
    paintPageSection(m, surface, locked);
    exitButton.disabled = locked;
    insertButton.hidden = !surface;
    insertButton.disabled = locked;
    paintGraphicInserts(Boolean(surface));
    if (surface) {
      // The 母版/版式 rail replaces the page rail, so the page rail's toggles have nothing to do.
      pageRailToggle.disabled = true;
      pageRailView.disabled = true;
    }
  }

  /** @param {any} surface */
  function startDelete(surface) {
    if ((surface.useCount ?? 0) > 0) {
      pending = { kind: "delete", layoutId: surface.layoutId, value: "" };
      repaint();
    } else {
      void send("layoutDelete", { layoutId: surface.layoutId });
    }
  }

  /** One rail tool button: create, rename, delete, confirm-delete or cancel. @param {string | undefined} kind @param {any} surface */
  function runRailAction(kind, surface) {
    const onLayout = surface.kind === "layout";
    if (kind === "create") {
      void send("layoutCreate", {});
    } else if (kind === "rename" && onLayout) {
      pending = { kind: "rename", layoutId: surface.layoutId, value: surface.name ?? "" };
      focusRename = true;
      repaint();
    } else if (kind === "delete" && onLayout) {
      startDelete(surface);
    } else if (kind === "confirm-delete" && onLayout) {
      void send("layoutDelete", { layoutId: surface.layoutId, confirmed: true }, () => {
        pending = null;
      });
    } else if (kind === "cancel") {
      pending = null;
      repaint();
    }
  }

  /** @param {Event} event */
  function onRailClick(event) {
    const row = within(event.target, "button.layout-row");
    if (row instanceof HTMLElement) {
      const scope = row.dataset.scope;
      void send("layoutSelect", scope === "master" ? { scope } : { layoutId: row.dataset.layoutId });
      return;
    }
    const action = within(event.target, "[data-action]");
    const surface = layoutSurface(getView());
    if (action instanceof HTMLElement && surface) runRailAction(action.dataset.action, surface);
  }

  /** @param {Event} event */
  function onRenameSubmit(event) {
    event.preventDefault();
    const form = within(event.target, "form.layout-rename");
    const surface = layoutSurface(getView());
    if (!(form instanceof HTMLFormElement) || surface?.kind !== "layout") return;
    const input = /** @type {HTMLInputElement | null} */ (form.querySelector("input[data-role='rename-input']"));
    const name = (input?.value ?? "").trim();
    const error = form.querySelector("[data-role='rename-error']");
    if (name === "") {
      if (error instanceof HTMLElement) {
        error.textContent = t("版式名称不能为空");
        error.hidden = false;
      }
      return;
    }
    void send("layoutRename", { layoutId: surface.layoutId, name }, () => {
      pending = null;
    });
  }

  /** Double-click on a copy opens the layout or master it came from, with that element selected. @param {Event} event */
  function onCopyDoubleClick(event) {
    const copy = within(event.target, ".el[data-inherited]");
    if (!(copy instanceof HTMLElement)) return;
    const inherited = getView()?.elements?.find((/** @type {any} */ el) => el.id === copy.dataset.id)?.inherited;
    if (!inherited) return;
    event.preventDefault();
    event.stopPropagation();
    void send("layoutEnter", {
      scope: inherited.scope,
      layoutId: inherited.ownerId,
      elementId: inherited.elementId,
    });
  }

  exitButton.addEventListener("click", () => void send("layoutExit", {}));
  applySelect.addEventListener("change", () => {
    const value = applySelect.value;
    void send("layoutApply", { layoutId: value === "" ? null : value });
  });
  enterButton.addEventListener("click", () => {
    const current = getView()?.layoutPanel?.pageLayoutId;
    if (current === undefined) return;
    void send("layoutEnter", { scope: "layout", layoutId: current });
  });
  createFirst.addEventListener("click", () => void send("layoutCreate", {}));
  insertButton.addEventListener("click", () => void send("insertPageNumber", {}));
  rail.addEventListener("click", onRailClick);
  rail.addEventListener("input", (event) => {
    if (pending?.kind !== "rename") return;
    const input = within(event.target, "input[data-role='rename-input']");
    if (input instanceof HTMLInputElement) pending.value = input.value;
  });
  rail.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && pending) {
      pending = null;
      repaint();
    }
  });
  rail.addEventListener("submit", onRenameSubmit);
  slide.addEventListener("dblclick", onCopyDoubleClick);

  return {
    paintChrome,
    /** Names the layout a page-mode undo reverted (`mark` from undoneLayoutMark, before undo).
     * @param {{scope: string, name: string} | null} mark @param {any} model */
    afterUndo(mark, model) {
      if (!mark || layoutSurface(model)) return;
      const key = mark.scope === "master" ? "已撤销母版『{name}』的修改" : "已撤销版式『{name}』的修改";
      showToast(t(key, { name: mark.name }));
    },
  };
}
