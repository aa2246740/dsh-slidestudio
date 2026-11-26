import type { RenderElement, renderModel } from "@open-slidestudio/canvas-session";
import type { Bounds } from "@open-slidestudio/pptd-v2";
import type { UserMessage } from "../../public/assistant-conversation.js";

export type PersistedReasonBlock = {
  summary?: string;
  detail?: string;
  label?: string;
  tool?: string;
};

export type PersistedReason = {
  brief?: string;
  think?: PersistedReasonBlock | null;
  plan?: PersistedReasonBlock | null;
  tools?: PersistedReasonBlock[] | null;
};

export type EditorModel = ReturnType<typeof renderModel> & {
  llmConfigured?: boolean;
  reason?: string | PersistedReason;
  generationPlaceholder?: boolean;
  pageModels?: EditorModel[];
  /** On a layout or master surface: the miniature of the master and of each layout, in list order. */
  layoutPreviews?: { scope: "master" | "layout"; id: string; model: EditorModel }[];
};

export type EditorVersion = {
  id: string;
  label?: string;
  note?: string;
  createdAt?: string;
  thumbs?: EditorModel[];
};

export type WorkspaceReceipt = {
  project: string;
  message: UserMessage;
  requestText?: string;
  clientRequestId?: string;
  error?: string;
  uncertain?: boolean;
  snapshotId?: string;
  snapshotLabel?: string;
  footer?: HTMLElement | null;
  footerSignature?: string;
};

export type ReviewControl = {
  cancelRequested: boolean;
  stage?: string;
  receipt?: WorkspaceReceipt;
  recovering?: boolean;
  lockLost?: boolean;
};

// Non-authoritative UI target. The Host's lease and verification still own authorization.
export type ReviewTarget = {
  scope?: string;
  pageIndex: number;
  pagePath: string;
  pagePaths: string[];
  targetPageId: string;
  targetPageIds: string[];
  elementIds: string[];
  label: string;
  structureOnly?: boolean;
  rewrite?: boolean;
  editableMeta?: string[];
  layoutId?: string;
  layoutName?: string;
  editablePageIds?: string[];
  deletablePageIds?: string[];
  reorderPageIds?: string[];
  insertIndex?: number;
  expectedAddCount?: number;
  lockedTargetPages?: {
    pageId: string;
    revision?: number;
    pageSha256?: string;
  }[];
};

export type ChartDraft = {
  elementId: string;
  rows: (string | number | null)[][];
  table: HTMLElement;
  status: HTMLElement | null;
  dirty: boolean;
  revision: number;
  commitPromise: Promise<void> | null;
};

export type TextLinkDialogState = {
  elementId: string;
  editingId: string | null;
  range: { start: number; end: number } | null;
  returnFocus: HTMLElement | null;
  currentHref: string;
};

export type CommentPopoverAnchor =
  { kind: "slide"; x: number; y: number } | { kind: "element"; id: string | undefined } | { kind: "pin"; id: string };

export type RailDrag = {
  fromIndex: number;
  startX: number;
  startY: number;
  active: boolean;
  thumb: HTMLButtonElement;
  insertAt?: number;
};

export type ResizeDirection = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type ElementDragMode = ResizeDirection | "move" | "rot" | `adj:${number}` | `crop:${string}`;

type ElementDragState = {
  id: string;
  startX: number;
  startY: number;
  bounds: Bounds;
  crop?: RenderElement["crop"];
  handle?: NonNullable<RenderElement["adjustHandles"]>[number] | null;
  adjustments?: number[];
  threshold?: number;
  moved?: boolean;
  group?: { id: string; bounds: Bounds }[];
  next?: Bounds;
  nextAdj?: number[];
  nextCrop?: RenderElement["crop"];
  nextRotation?: number;
};

export type ElementDrag = ElementDragState &
  ({ mode: "rot"; rotation: number } | { mode: Exclude<ElementDragMode, "rot">; rotation?: number });
