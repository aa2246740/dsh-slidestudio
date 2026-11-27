import { t } from "./i18n.js";
/**
 * Vanilla port of dsh-better-display ReasoningCard + reasoning-follow.
 * One real transcript: reference transform while following, native scroll
 * while reading. The card stays visible for short and long reasoning alike.
 */
export const REASON_HOLD = 840;
export const REASON_STEP = 500;
const REASON_LINES = 2;
const EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

function reasoningTarget(top, contentHeight, viewportHeight, lineHeight) {
  const end = Math.max(0, contentHeight - viewportHeight);
  const current = Math.min(end, Math.max(0, top));
  return Math.min(end, current + Math.max(1, lineHeight) * REASON_LINES);
}

export function mountReasonCard({ host, readingHost }) {
  const root = document.createElement("details");
  root.className = "generation-reasoning-card reason-card";
  root.dataset.expanded = "false";
  root.dataset.overflow = "false";

  const heading = document.createElement("summary");
  heading.className = "reason-heading";
  heading.dataset.readerReasoningHeading = "";
  const label = document.createElement("span");
  label.className = "reason-label";
  label.textContent = t("思考");
  const step = document.createElement("span");
  step.className = "reason-step";
  heading.append(label, step);

  const viewport = document.createElement("div");
  viewport.className = "reason-viewport";
  const track = document.createElement("div");
  track.className = "reason-track";
  const text = document.createElement("div");
  text.className = "reason-text";
  text.dataset.processDetail = "";
  track.append(text);
  viewport.append(track);

  const footer = document.createElement("div");
  footer.className = "reason-footer";
  const caption = document.createElement("span");
  caption.className = "reason-caption";
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "reason-action";
  expand.setAttribute("aria-expanded", "false");
  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("viewBox", "0 0 16 16");
  chevron.setAttribute("width", "12");
  chevron.setAttribute("height", "12");
  chevron.setAttribute("aria-hidden", "true");
  const chevronPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  chevron.append(chevronPath);
  expand.append(document.createElement("span"), chevron);
  footer.append(caption, expand);
  root.append(heading, viewport, footer);
  host.append(root);

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let running = false;
  let expanded = false;
  let following = true;
  let alive = true;
  let frame = 0;
  let timer;
  let nextAt = performance.now() + REASON_HOLD;
  let automatic = false;
  let painted = 0;
  let targetOffset = 0;
  let pendingText = null;
  let resize = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let poll = null;

  const tail = () => Math.max(0, text.offsetHeight - viewport.clientHeight);
  const clamp = (value) => Math.max(0, Math.min(tail(), value));
  const lineHeight = () => parseFloat(getComputedStyle(text).lineHeight) || 24;
  const hasSelection = () => {
    const selection = document.getSelection();
    return Boolean(selection && !selection.isCollapsed && selection.anchorNode && text.contains(selection.anchorNode));
  };
  const paintedOffset = () => (automatic ? painted : viewport.scrollTop);
  const cancel = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    clearTimeout(timer);
    timer = undefined;
    delete viewport.dataset.reasoningMoving;
  };
  const manual = () => {
    if (!automatic) return;
    const top = paintedOffset();
    automatic = false;
    track.style.transition = "none";
    track.style.transform = "none";
    viewport.style.overflow = "auto";
    viewport.scrollTop = top;
    painted = viewport.scrollTop;
  };
  const follow = () => {
    if (automatic) return;
    painted = clamp(viewport.scrollTop);
    track.style.transition = "none";
    track.style.transform = `translateY(-${painted}px)`;
    viewport.scrollTop = 0;
    viewport.style.overflow = "hidden";
    automatic = true;
  };
  const edgesOf = (top, bottom) => (top ? (bottom ? "both" : "top") : bottom ? "bottom" : "none");
  const measure = () => {
    if (!automatic) painted = viewport.scrollTop;
    const preview = parseFloat(getComputedStyle(viewport).getPropertyValue("--reason-preview-height")) || 224;
    const overflowing = text.offsetHeight > preview + 1;
    if (root.dataset.overflow !== String(overflowing)) root.dataset.overflow = String(overflowing);
    footer.hidden = !(overflowing || expanded);
    const top = painted > 1;
    const bottom = tail() - painted > 1;
    viewport.dataset.edges = edgesOf(top, bottom);
  };
  const schedule = () => {
    if (!canFollow() || frame || timer !== undefined) return;
    follow();
    if (tail() - painted < 1) return;
    timer = setTimeout(start, Math.max(0, nextAt - performance.now()));
  };
  const canFollow = () =>
    alive && root.open && running && following && !reduced.matches && !document.hidden && !hasSelection();
  const start = () => {
    timer = undefined;
    if (!canFollow()) return;
    const from = painted;
    const target = reasoningTarget(from, text.offsetHeight, viewport.clientHeight, lineHeight());
    if (target - from < 1) return;
    const began = performance.now();
    nextAt = began + REASON_HOLD;
    targetOffset = target;
    viewport.dataset.reasoningMoving = "true";
    // Self-driven interpolation: identical easing/step to the reference, but
    // independent of the webview's CSS-transition computed-style behavior.
    const animate = (now) => {
      frame = 0;
      if (!canFollow()) {
        cancel();
        manual();
        return;
      }
      const progress = Math.min(1, (now - began) / REASON_STEP);
      const eased = 1 - Math.pow(1 - progress, 3);
      painted = from + (target - from) * eased;
      track.style.transform = `translateY(-${painted}px)`;
      if (progress < 1) frame = requestAnimationFrame(animate);
      else {
        painted = target;
        delete viewport.dataset.reasoningMoving;
        measure();
        schedule();
      }
    };
    frame = requestAnimationFrame(animate);
  };
  const pause = () => {
    cancel();
    manual();
    following = false;
    measure();
    paintFooter();
  };
  const fitReading = () => {
    const host = readingHost || root.closest(".editor-generation-event-flow") || root.parentElement;
    if (!host) return;
    const headingHeight = heading.offsetHeight || 30;
    const footerHeight = footer.offsetHeight || 38;
    const available = Math.max(120, host.clientHeight - headingHeight - footerHeight - 32);
    root.style.setProperty("--reason-reading-height", `${available}px`);
  };
  const paintFooter = () => {
    if (running && following) {
      caption.textContent = "";
      expand.querySelector("span").textContent = t("暂停跟随");
      chevronPath.style.display = "none";
    } else {
      caption.textContent = expanded ? t("手动阅读") : t("可滚动阅读");
      expand.querySelector("span").textContent = expanded ? t("收起") : t("展开阅读");
      chevronPath.style.display = "";
      chevronPath.setAttribute("d", expanded ? "m4 10 4-4 4 4" : "m4 6 4 4 4-4");
    }
  };
  const toggleExpanded = () => {
    const from = viewport.clientHeight;
    expanded = !expanded;
    root.dataset.expanded = String(expanded);
    expand.setAttribute("aria-expanded", String(expanded));
    if (expanded) fitReading();
    root.open = true;
    root.dataset.userToggled = "true";
    viewport.style.overflow = "auto";
    automatic = false;
    following = false;
    paintFooter();
    measure();
    syncPoll();
    const to = viewport.clientHeight;
    if (!reduced.matches && Math.abs(to - from) > 1) {
      resize?.cancel();
      resize = viewport.animate([{ height: `${from}px` }, { height: `${to}px` }], {
        duration: 300,
        easing: EASING,
        fill: "both",
      });
      resize.onfinish = () => {
        resize?.cancel();
        resize = null;
      };
    }
  };
  const onScroll = () => {
    measure();
    if (automatic && viewport.scrollTop > 1) pause();
  };
  const onWheel = (event) => {
    if (!event.deltaY) return;
    const handoff = automatic && event.cancelable;
    if (handoff) event.preventDefault();
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? lineHeight()
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? viewport.clientHeight
          : 1;
    pause();
    if (handoff) {
      viewport.scrollTop = clamp(viewport.scrollTop + event.deltaY * unit);
      measure();
    }
  };
  const onSelection = () => {
    if (hasSelection()) pause();
    else if (pendingText !== null) {
      text.textContent = pendingText;
      pendingText = null;
      measure();
      schedule();
    }
  };
  const shouldPoll = () => alive && root.open && (running || expanded) && !document.hidden;
  const stopPoll = () => {
    if (poll !== null) {
      clearInterval(poll);
      poll = null;
    }
  };
  const syncPoll = () => {
    if (shouldPoll()) {
      if (poll === null) {
        poll = setInterval(() => {
          if (!shouldPoll()) {
            stopPoll();
            return;
          }
          measure();
          if (expanded) fitReading();
          schedule();
        }, 500);
      }
    } else {
      stopPoll();
    }
  };
  const onVisibility = () => {
    cancel();
    manual();
    nextAt = performance.now() + REASON_HOLD;
    if (!document.hidden) schedule();
    syncPoll();
  };
  const onToggle = () => {
    if (root.open) {
      measure();
      if (expanded) fitReading();
      schedule();
    } else {
      cancel();
      manual();
    }
    syncPoll();
  };
  const observer = new ResizeObserver(() => {
    if (automatic && targetOffset > tail() + 1) {
      cancel();
      manual();
      nextAt = performance.now() + REASON_HOLD;
    }
    measure();
    if (expanded) fitReading();
    schedule();
  });
  observer.observe(text);
  observer.observe(viewport);
  root.addEventListener("toggle", onToggle);
  viewport.addEventListener("scroll", onScroll, { passive: true });
  viewport.addEventListener("wheel", onWheel, { passive: false });
  document.addEventListener("selectionchange", onSelection);
  document.addEventListener("visibilitychange", onVisibility);
  expand.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (running && following) pause();
    else toggleExpanded();
  });
  heading.addEventListener("click", () => {
    root.dataset.userToggled = "true";
    if (expanded) toggleExpanded();
  });

  measure();
  paintFooter();

  return {
    root,
    setDetail(content, isRunning, stepLabel) {
      if (stepLabel) step.textContent = stepLabel;
      const changed = running !== isRunning;
      running = isRunning;
      root.dataset.streaming = String(running);
      label.textContent = running ? t("思考中") : t("思考");
      if (!running) {
        cancel();
        manual();
      }
      const value = String(content || "");
      if (hasSelection()) {
        pendingText = value;
        syncPoll();
        return;
      }
      pendingText = null;
      if (text.textContent !== value) text.textContent = value;
      if (changed) paintFooter();
      // Open/collapse is owned by the app layer (latest-thought protocol),
      // mirroring the React card whose `active` prop comes from the turn
      // boundary, not from this block's own stream state.
      measure();
      schedule();
      syncPoll();
    },
    setOpen(open) {
      if (root.dataset.userToggled === "true" || expanded) return;
      root.open = open;
      syncPoll();
    },
    destroy() {
      alive = false;
      cancel();
      syncPoll();
      observer.disconnect();
      root.removeEventListener("toggle", onToggle);
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", onWheel);
      document.removeEventListener("selectionchange", onSelection);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
