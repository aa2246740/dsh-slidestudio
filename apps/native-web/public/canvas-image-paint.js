import { applyImageCropDisplay, clipShadowLayer, pictureSurface, shadowFollowsClip } from "./canvas-element-paint.js";
/** @typedef {import("@open-slidestudio/canvas-session").RenderElement} RenderElement */

/**
 *  The picture of an image element, painted onto its `.el` box. The render model's clip and crop set the picture layer; while the crop tool is open the full picture and the crop chrome show instead.
 * @param {HTMLElement} node
 * @param {RenderElement} el
 * @param {{
 *  cropping: boolean; mediaUrl: (src: string | undefined) => string; startCropDrag: (ev: PointerEvent, el: RenderElement, dir: string) => void; }} context
 */
export function paintCanvasImage(node, el, { cropping, mediaUrl, startCropDrag }) {
  const crop = el.crop || {};
  const l = crop.left || 0;
  const t = crop.top || 0;
  const r = crop.right || 0;
  const b = crop.bottom || 0;
  // The picture draws on its own layer, so a clip there never hides the handles on the box. A clipped picture's shadow comes from a layer that wraps that picture layer.
  const host = shadowFollowsClip(el) ? clipShadowLayer(node, el) : node;
  const surface = pictureSurface(host);
  surface.style.backgroundImage = `url("${mediaUrl(el.src)}")`;
  surface.style.backgroundRepeat = "no-repeat";
  if (cropping) {
    node.classList.add("is-cropping");
    surface.style.clipPath = "";
    surface.style.backgroundSize = "100% 100%";
    surface.style.backgroundPosition = "0 0";
    /** @param {string} cls @param {Partial<CSSStyleDeclaration>} style */
    const dim = (cls, style) => {
      const d = document.createElement("div");
      d.className = `crop-dim ${cls}`;
      Object.assign(d.style, style);
      node.append(d);
    };
    dim("crop-dim-t", { left: "0", top: "0", right: "0", height: `${t * 100}%` });
    dim("crop-dim-b", { left: "0", bottom: "0", right: "0", height: `${b * 100}%` });
    dim("crop-dim-l", {
      left: "0",
      top: `${t * 100}%`,
      width: `${l * 100}%`,
      bottom: `${b * 100}%`,
    });
    dim("crop-dim-r", {
      right: "0",
      top: `${t * 100}%`,
      width: `${r * 100}%`,
      bottom: `${b * 100}%`,
    });
    const frame = document.createElement("div");
    frame.className = "crop-frame";
    frame.style.left = `${l * 100}%`;
    frame.style.top = `${t * 100}%`;
    frame.style.right = `${r * 100}%`;
    frame.style.bottom = `${b * 100}%`;
    for (const [dir, left, top] of /** @type {[string, string, string][]} */ ([
      ["nw", "0%", "0%"],
      ["n", "50%", "0%"],
      ["ne", "100%", "0%"],
      ["e", "100%", "50%"],
      ["se", "100%", "100%"],
      ["s", "50%", "100%"],
      ["sw", "0%", "100%"],
      ["w", "0%", "50%"],
    ])) {
      const h = document.createElement("i");
      h.className = `handle handle-crop handle-${dir}`;
      h.dataset.crop = dir;
      h.style.left = left;
      h.style.top = top;
      h.addEventListener("pointerdown", (ev) => startCropDrag(ev, el, dir));
      frame.append(h);
    }
    node.append(frame);
  } else {
    applyImageCropDisplay(surface, el);
  }
}
