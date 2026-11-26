import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  LAYOUT_CONTROL,
  LAYOUT_MODE_ELEMENT_IDS,
  createLayoutMode,
  layoutSurface,
  pageLayoutOpen,
  undoneLayoutMark,
} from "../public/layout-mode.js";

/*
 * Layout mode in the editor (masters-layouts §5.2; VAL-LAYOUT-013 and VAL-LAYOUT-014). Until the
 * layout markup lands in index.html, the page is a fixture with exactly the nodes the module needs
 * (the markup the integration spec asks for). Clicks and changes go through the module's own
 * listeners; the commands it sends are recorded instead of run.
 */

const FIXTURE_HTML = `<!doctype html><html><body>
  <button id="btn-rail-view" type="button"></button>
  <button id="btn-rail" type="button" data-control="chrome.pages.rail.toggle"></button>
  <nav>
    <button type="button" data-control="insert.table" data-tip="插入表格"></button>
    <button type="button" data-control="insert.chart" data-tip="插入图表"></button>
    <button type="button" data-control="insert.smartart"></button>
    <button type="button" id="btn-insert-pagenumber" data-control="insert.pagenumber" hidden></button>
  </nav>
  <aside class="rail layout-rail" id="layout-rail" hidden></aside>
  <div class="layout-banner" id="layout-banner" role="status" hidden>
    <p><span id="layout-banner-text"></span>
      <button type="button" id="layout-exit" data-control="theme.layout.exit">完成</button></p>
    <small id="layout-banner-note"></small>
  </div>
  <div class="slide" id="slide"></div>
  <section id="layout-page-section" hidden>
    <select id="layout-apply" data-control="theme.layout.apply"></select>
    <button type="button" id="layout-enter" data-control="theme.layout.enter">编辑版式</button>
    <button type="button" id="layout-create-first" data-control="theme.layout.create" hidden>新建版式</button>
    <p class="layout-note" id="layout-page-note" hidden></p>
  </section>
</body></html>`;
const DOM_GLOBALS = ["document", "HTMLElement", "HTMLInputElement", "HTMLFormElement"];

/** The page's view: the cover and body layouts, with the body layout used by 22 pages. @param {Record<string, unknown>} [extra] */
function pageView(extra = {}) {
  return {
    id: "page-5",
    size: [960, 540],
    presenting: false,
    selection: { kind: "none" },
    elements: [
      {
        id: "logo-a",
        type: "shape",
        inherited: { scope: "layout", name: "正文", ownerId: "body", elementId: "logo-a" },
      },
      {
        id: "pageno",
        type: "shape",
        inherited: { scope: "master", name: "母版", ownerId: "main", elementId: "pageno" },
      },
      { id: "title", type: "text" },
    ],
    layoutPanel: {
      surface: { kind: "page" },
      master: { id: "main", name: "母版" },
      layouts: [
        { id: "cover", name: "封面", useCount: 1 },
        { id: "body", name: "正文", useCount: 22 },
      ],
      pageLayoutId: "body",
    },
    layoutPreviews: [
      { scope: "master", id: "main", model: { size: [960, 540], elements: [] } },
      { scope: "layout", id: "cover", model: { size: [960, 540], elements: [] } },
      { scope: "layout", id: "body", model: { size: [960, 540], elements: [] } },
    ],
    ...extra,
  };
}

/** A layout surface over the same deck as the page view. @param {Record<string, unknown>} [surface] */
function layoutView(surface = { kind: "layout", layoutId: "body", name: "正文", useCount: 22 }) {
  const base = pageView();
  return { ...base, layoutPanel: { ...base.layoutPanel, surface } };
}

/**
 * Runs fn against the fixture with the DOM globals the module reads installed, restored only after
 * fn settles because the listeners run later than the first await.
 * @template T @param {(window: any) => T | Promise<T>} fn @returns {Promise<T>}
 */
async function withPage(fn) {
  const window = /** @type {any} */ (new JSDOM(FIXTURE_HTML).window);
  /** @type {any} */
  const scope = globalThis;
  const previous = Object.fromEntries(DOM_GLOBALS.map((name) => [name, scope[name]]));
  for (const name of DOM_GLOBALS) scope[name] = name === "document" ? window.document : window[name];
  try {
    return await fn(window);
  } finally {
    for (const name of DOM_GLOBALS) scope[name] = previous[name];
  }
}

/** Mounts the layout mode; `show` paints a view the way app.js does after a render. @param {any} window @param {any} initial */
function mount(window, initial) {
  const { document } = window;
  let view = initial;
  /** @type {{cmd: string, payload: unknown}[]} */
  const sent = [];
  /** @type {string[]} */
  const toasts = [];
  const mode = createLayoutMode({
    command: async (cmd, payload = {}) => {
      sent.push({ cmd, payload });
      return {};
    },
    showToast: (message) => toasts.push(message),
    paintSlide: (target, model) => {
      target.style.width = `${model.size[0]}px`;
      target.style.height = `${model.size[1]}px`;
    },
    getView: () => view,
  });
  return {
    document,
    mode,
    sent,
    toasts,
    $: (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id)),
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
    /** @param {any} next */
    show(next) {
      view = next;
      // app.js renderChrome resets every data-control from the session gate before paintChrome.
      for (const node of document.querySelectorAll("[data-control]")) node.disabled = false;
      mode.paintChrome(next);
    },
  };
}

test("the fixture carries every node the module looks up", async () => {
  await withPage(async (window) => {
    for (const id of LAYOUT_MODE_ELEMENT_IDS) assert.ok(window.document.getElementById(id), id);
    window.document.getElementById("layout-rail").remove();
    assert.throws(() => mount(window, pageView()), /layout mode needs #layout-rail/);
  });
});

test("the page shows the 版式 section with 无版式 and each layout, and 编辑版式 opens the page's layout", async () => {
  await withPage(async (window) => {
    const page = mount(window, pageView());
    page.show(pageView());
    assert.equal(page.$("layout-page-section").hidden, false);
    const options = [...page.$("layout-apply").options].map((option) => [option.value, option.textContent]);
    assert.deepEqual(options, [
      ["", "无版式"],
      ["cover", "封面（1 页）"],
      ["body", "正文（22 页）"],
    ]);
    assert.equal(page.$("layout-apply").value, "body");
    assert.equal(page.$("layout-enter").hidden, false);
    assert.equal(page.$("layout-enter").disabled, false);
    assert.equal(page.$("layout-enter").getAttribute("data-control"), LAYOUT_CONTROL.enter);
    assert.equal(page.$("layout-banner").hidden, true);
    assert.equal(page.$("layout-rail").hidden, true);
    assert.equal(page.$("btn-insert-pagenumber").hidden, true);
    page.$("layout-enter").click();
    await page.flush();
    assert.deepEqual(page.sent, [{ cmd: "layoutEnter", payload: { scope: "layout", layoutId: "body" } }]);
  });
});

test("choosing 无版式 sends a null layout, and choosing a layout sends its id", async () => {
  await withPage(async (window) => {
    const page = mount(window, pageView());
    page.show(pageView());
    const apply = page.$("layout-apply");
    for (const value of ["", "cover"]) {
      apply.value = value;
      apply.dispatchEvent(new window.Event("change", { bubbles: true }));
      await page.flush();
    }
    assert.deepEqual(page.sent, [
      { cmd: "layoutApply", payload: { layoutId: null } },
      { cmd: "layoutApply", payload: { layoutId: "cover" } },
    ]);
  });
});

test("a page without a layout explains why 编辑版式 is off", async () => {
  await withPage(async (window) => {
    const bare = pageView({ layoutPanel: { ...pageView().layoutPanel, pageLayoutId: undefined } });
    const page = mount(window, bare);
    page.show(bare);
    assert.equal(page.$("layout-apply").value, "");
    assert.equal(page.$("layout-enter").disabled, true);
    assert.equal(page.$("layout-page-note").hidden, false);
    assert.equal(page.$("layout-page-note").textContent, "这一页没有版式。选择一个版式后，可以编辑它。");
    page.$("layout-enter").click();
    await page.flush();
    assert.deepEqual(page.sent, [], "a disabled 编辑版式 sends nothing even if clicked");
  });
});

test("a deck without layouts disables the dropdown and offers 新建版式", async () => {
  await withPage(async (window) => {
    const empty = pageView({
      layoutPanel: { ...pageView().layoutPanel, layouts: [], pageLayoutId: undefined },
      layoutPreviews: [],
    });
    const page = mount(window, empty);
    page.show(empty);
    assert.equal(page.$("layout-apply").disabled, true);
    assert.equal(page.$("layout-enter").hidden, true);
    assert.equal(page.$("layout-create-first").hidden, false);
    assert.equal(page.$("layout-page-note").textContent, "这份文稿还没有版式。新建一个版式后，页面可以套用它。");
    page.$("layout-create-first").click();
    await page.flush();
    assert.deepEqual(page.sent, [{ cmd: "layoutCreate", payload: {} }]);
  });
});

test("the 版式 section steps aside while an element is selected, and for the zero-page placeholder", async () => {
  await withPage(async (window) => {
    const selected = pageView({ selection: { kind: "element", elementId: "title" } });
    const page = mount(window, selected);
    page.show(selected);
    assert.equal(page.$("layout-page-section").hidden, true);
    const placeholder = {
      size: [960, 540],
      presenting: false,
      selection: { kind: "none" },
      elements: [],
      generationPlaceholder: true,
    };
    page.show(pageView());
    assert.equal(page.$("layout-page-section").hidden, false);
    assert.doesNotThrow(() => page.show(placeholder));
    assert.equal(page.$("layout-page-section").hidden, true);
    assert.equal(pageLayoutOpen(placeholder), false);
  });
});

test("a layout surface shows the banner, the 母版/版式 rail, and the 页码 insert", async () => {
  await withPage(async (window) => {
    const view = layoutView();
    const page = mount(window, view);
    page.show(view);
    assert.equal(layoutSurface(view).kind, "layout");
    assert.equal(page.$("layout-banner").hidden, false);
    assert.equal(page.$("layout-banner-text").textContent, "正在编辑版式『正文』· 22 页使用");
    assert.equal(page.$("layout-banner-note").textContent, "版式里不能放图表/表格");
    assert.equal(page.$("layout-page-section").hidden, true);
    assert.equal(page.$("layout-rail").hidden, false);
    const rows = [...page.$("layout-rail").querySelectorAll("button.layout-row")];
    assert.deepEqual(
      rows.map((row) => row.getAttribute("aria-label")),
      ["母版：母版，母版", "版式：封面，1 页使用", "版式：正文，22 页使用"],
    );
    assert.ok(rows.every((row) => row.getAttribute("data-control") === LAYOUT_CONTROL.select));
    assert.equal(rows.find((row) => row.getAttribute("aria-current") === "true").dataset.layoutId, "body");
    assert.equal(page.$("btn-insert-pagenumber").hidden, false);
    const minis = page.$("layout-rail").querySelectorAll(".layout-frame > .thumb-mini");
    assert.equal(minis.length, 3);
    assert.equal(minis[0].style.width, "960px");
    assert.equal(minis[0].parentElement.style.aspectRatio, "960 / 540");
  });
});

test("a master surface names the master and offers no rename or delete", async () => {
  await withPage(async (window) => {
    const view = layoutView({ kind: "master", name: "母版" });
    const page = mount(window, view);
    page.show(view);
    assert.equal(page.$("layout-banner-text").textContent, "正在编辑母版『母版』");
    assert.equal(page.$("layout-rail").querySelector('[data-action="rename"]'), null);
    assert.equal(page.$("layout-rail").querySelector('[data-action="delete"]'), null);
    const current = page.$("layout-rail").querySelector('[aria-current="true"]');
    assert.equal(current.dataset.scope, "master");
  });
});

test("a graphic insert is disabled on a layout and comes back with its own tip on a page", async () => {
  await withPage(async (window) => {
    const page = mount(window, pageView());
    page.show(pageView());
    const table = page.document.querySelector('[data-control="insert.table"]');
    const smartArt = page.document.querySelector('[data-control="insert.smartart"]');
    page.show(layoutView());
    assert.equal(table.disabled, true);
    assert.equal(table.getAttribute("data-tip"), "版式里不能放图表/表格");
    assert.equal(smartArt.getAttribute("data-tip"), "版式里不能放图表/表格");
    page.show(pageView());
    assert.equal(table.disabled, false);
    assert.equal(table.getAttribute("data-tip"), "插入表格");
    assert.equal(smartArt.hasAttribute("data-tip"), false, "a control without a tip gets none back");
  });
});

test("完成 leaves the layout, and 页码 inserts the page number", async () => {
  await withPage(async (window) => {
    const page = mount(window, layoutView());
    page.show(layoutView());
    page.$("layout-exit").click();
    await page.flush();
    page.$("btn-insert-pagenumber").click();
    await page.flush();
    assert.deepEqual(page.sent, [
      { cmd: "layoutExit", payload: {} },
      { cmd: "insertPageNumber", payload: {} },
    ]);
  });
});

test("a list row selects its layout or the master, and 新建版式 creates one", async () => {
  await withPage(async (window) => {
    const page = mount(window, layoutView());
    page.show(layoutView());
    const rail = () => page.$("layout-rail");
    rail().querySelectorAll("button.layout-row")[0].click();
    await page.flush();
    rail().querySelectorAll("button.layout-row")[1].click();
    await page.flush();
    rail().querySelector(".layout-create").click();
    await page.flush();
    assert.deepEqual(page.sent, [
      { cmd: "layoutSelect", payload: { scope: "master" } },
      { cmd: "layoutSelect", payload: { layoutId: "cover" } },
      { cmd: "layoutCreate", payload: {} },
    ]);
  });
});

test("rename refuses an empty name, then sends the new one; Escape and 取消 close the form", async () => {
  await withPage(async (window) => {
    const page = mount(window, layoutView());
    page.show(layoutView());
    const rail = page.$("layout-rail");
    rail.querySelector('[data-action="rename"]').click();
    let form = rail.querySelector("form.layout-rename");
    assert.ok(form, "the rename form opens");
    const input = form.querySelector("input");
    assert.equal(input.value, "正文");
    input.value = "   ";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await page.flush();
    assert.deepEqual(page.sent, []);
    const error = form.querySelector("[data-role='rename-error']");
    assert.equal(error.hidden, false);
    assert.equal(error.textContent, "版式名称不能为空");
    input.value = "新正文";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await page.flush();
    assert.deepEqual(page.sent, [{ cmd: "layoutRename", payload: { layoutId: "body", name: "新正文" } }]);
    assert.equal(rail.querySelector("form.layout-rename"), null, "a saved rename closes the form");
    rail.querySelector('[data-action="rename"]').click();
    rail.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(rail.querySelector("form.layout-rename"), null, "Escape closes the form");
    rail.querySelector('[data-action="rename"]').click();
    form = rail.querySelector("form.layout-rename");
    form.querySelector('[data-action="cancel"]').click();
    assert.equal(rail.querySelector("form.layout-rename"), null, "取消 closes the form");
  });
});

test("deleting an unused layout is immediate; a layout in use asks first", async () => {
  await withPage(async (window) => {
    const unused = layoutView({ kind: "layout", layoutId: "cover", name: "封面", useCount: 0 });
    const page = mount(window, unused);
    page.show(unused);
    page.$("layout-rail").querySelector('[data-action="delete"]').click();
    await page.flush();
    assert.deepEqual(page.sent, [{ cmd: "layoutDelete", payload: { layoutId: "cover" } }]);
    page.show(layoutView());
    page.$("layout-rail").querySelector('[data-action="delete"]').click();
    const confirm = page.$("layout-rail").querySelector(".layout-confirm");
    assert.ok(confirm, "the confirmation opens");
    assert.match(confirm.textContent, /22 页会失去版式『正文』的内容/);
    assert.equal(page.sent.length, 1, "nothing is sent until the user confirms");
    confirm.querySelector('[data-action="confirm-delete"]').click();
    await page.flush();
    assert.deepEqual(page.sent.at(-1), { cmd: "layoutDelete", payload: { layoutId: "body", confirmed: true } });
  });
});

test("a double-click on an inherited copy enters its layout or master with that element selected", async () => {
  await withPage(async (window) => {
    const page = mount(window, pageView());
    page.show(pageView());
    const slide = page.$("slide");
    /** @param {string} id @param {string} [inherited] */
    const copyOf = (id, inherited) => {
      const node = page.document.createElement("div");
      node.className = "el shape";
      node.dataset.id = id;
      if (inherited) node.dataset.inherited = inherited;
      slide.append(node);
      return node;
    };
    for (const node of [copyOf("logo-a", "layout"), copyOf("pageno", "master"), copyOf("title")]) {
      node.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
      await page.flush();
    }
    assert.deepEqual(page.sent, [
      { cmd: "layoutEnter", payload: { scope: "layout", layoutId: "body", elementId: "logo-a" } },
      { cmd: "layoutEnter", payload: { scope: "master", layoutId: "main", elementId: "pageno" } },
    ]);
  });
});

test("a page-mode undo of a layout edit names the layout; a layout surface stays quiet", async () => {
  await withPage(async (window) => {
    const page = mount(window, pageView());
    page.show(pageView());
    const mark = { scope: "layout", id: "body", name: "正文" };
    const marked = pageView({ layoutPanel: { ...pageView().layoutPanel, undoMark: mark } });
    assert.deepEqual(undoneLayoutMark(marked), mark);
    assert.equal(undoneLayoutMark(layoutView()), null);
    page.mode.afterUndo({ scope: "layout", name: "正文" }, pageView());
    assert.deepEqual(page.toasts, ["已撤销版式『正文』的修改"]);
    page.mode.afterUndo({ scope: "master", name: "母版" }, pageView());
    assert.equal(page.toasts.at(-1), "已撤销母版『母版』的修改");
    page.mode.afterUndo({ scope: "layout", name: "正文" }, layoutView());
    page.mode.afterUndo(null, pageView());
    assert.equal(page.toasts.length, 2);
  });
});

test("while a version is previewed, the layout controls show but cannot run", async () => {
  await withPage(async (window) => {
    const page = mount(window, layoutView());
    page.mode.paintChrome(layoutView(), true);
    assert.equal(page.$("layout-exit").disabled, true);
    assert.equal(page.$("btn-insert-pagenumber").disabled, true);
    const controls = page.$("layout-rail").querySelectorAll("button");
    assert.ok(controls.length >= 5);
    for (const node of controls) assert.equal(node.disabled, true, node.textContent);
    page.mode.paintChrome(pageView(), true);
    assert.equal(page.$("layout-apply").disabled, true);
    assert.equal(page.$("layout-enter").disabled, true);
  });
});

test("the page rail's toggles are off on a layout surface, where the 母版/版式 rail replaces it", async () => {
  await withPage(async (window) => {
    const page = mount(window, layoutView());
    page.show(layoutView());
    assert.equal(page.$("btn-rail").disabled, true);
    assert.equal(page.$("btn-rail-view").disabled, true);
  });
});

test("the property panel stays open for the page's 版式 section, and only where that section applies", () => {
  assert.equal(pageLayoutOpen(pageView()), true);
  const none = pageView({ layoutPanel: { ...pageView().layoutPanel, layouts: [] } });
  assert.equal(pageLayoutOpen(none), false);
  assert.equal(pageLayoutOpen(layoutView()), false);
  assert.equal(pageLayoutOpen(pageView({ selection: { kind: "element", id: "title" } })), false);
  assert.equal(pageLayoutOpen(pageView({ selection: { kind: "multi", ids: ["title", "pageno"] } })), false);
  assert.equal(pageLayoutOpen(pageView({ presenting: true })), false);
  assert.equal(Object.values(LAYOUT_CONTROL).length, 8, "exactly the eight controls of masters §5.3");
});
