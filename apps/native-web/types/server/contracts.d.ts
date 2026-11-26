import type { Page, PptdProject } from "@open-slidestudio/pptd-v2";
import type { CanvasSession } from "@open-slidestudio/canvas-session";
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from "node:http";

export type Native = {
  pptd: typeof import("@open-slidestudio/pptd-v2");
  canvas: typeof import("@open-slidestudio/canvas-session");
  exporter: typeof import("@open-slidestudio/exporter-native");
  store: typeof import("@open-slidestudio/project-store");
};
/** Local single-user owner key; the native editor has no identity service. */
export type Principal = { readonly id: string };
export type Reply = (status: number, body: unknown, headers?: OutgoingHttpHeaders) => void;
export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  native: Native;
  principal: Principal;
  reply: Reply;
};
export type LiveEntry = {
  session: CanvasSession | null;
  diskRevision: string | null;
  projectRoot: string;
};
export type DeckState = {
  title: string;
  theme: NonNullable<PptdProject["presentation"]["theme"]>;
  pageOrder: string[];
};
export type ReviewScope = {
  kind: "elements" | "page" | "pages" | "deck";
  pageId: string;
  elementIds: string[];
  pageRevision: number | null;
  pageSha256: string;
  capturedAt?: string;
  authorizationId?: string;
  targetPageIds?: string[];
  targetPages?: { pageId: string; revision: number; pageSha256: string }[];
  structureOnly?: boolean;
  rewrite?: boolean;
  metaOnly?: boolean;
  editableMeta?: ("title" | "theme" | "layouts")[];
  layoutId?: string;
  layoutName?: string;
  layoutShas?: Record<string, string>;
  editablePageIds?: string[];
  deletablePageIds?: string[];
  reorderPageIds?: string[];
  insertIndex?: number;
  expectedAddCount?: number;
  backgroundColorOverride?: boolean;
};
export type ReviewThread = {
  id: string;
  pagePath: string;
  scope?: ReviewScope;
  elementId?: string;
  x: number;
  y: number;
  ox?: number;
  oy?: number;
  text: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  resolved: boolean;
  aiStatus: "idle" | "running" | "applied" | "failed" | "needs-review";
  pageGone: boolean;
  aiSubmissionId?: string;
  aiAppliedAt?: string;
  aiError?: string;
};
export type PageBaseline = {
  pageId: string;
  pagePath: string;
  pageSha256: string;
  ownPageSha256?: string;
  layoutId?: string;
};
export type BatchItem = { pagePath: string; commentId: string; commentRevision: number };
export type LockedItem = BatchItem & {
  scope: ReviewScope;
  pageSha256: string;
  pageRevision: number | null;
  pageBody: Page;
};
export type ReviewLock = {
  token: string;
  root: string;
  pagePath: string;
  commentId?: string;
  commentRevision?: number;
  scope?: ReviewScope;
  pageSha256?: string;
  pageBody?: Page;
  items?: LockedItem[];
  deckState?: DeckState;
  projectPages?: PageBaseline[];
  snapshotVersionId?: string;
  createdAt: string;
  expiresAt: number;
  /** Memory only: when the holding browser last proved it was alive. */
  renewedAt?: number;
  submissionId?: string;
  workspaceVerified?: boolean;
  restored?: boolean;
};
export type LockOptions = Partial<
  Pick<
    ReviewLock,
    | "pagePath"
    | "commentId"
    | "commentRevision"
    | "scope"
    | "pageSha256"
    | "pageBody"
    | "deckState"
    | "projectPages"
    | "items"
  >
>;
export type PageSnapshot = {
  pageId: string;
  pageRevision: number | null;
  pageBody: Page;
  canonicalPage: Page & { id: string };
  pageSha256: string;
  pageRevisionSha256: string;
  deckState: DeckState;
  stableSha256: typeof import("@open-slidestudio/presentation-run").stableSha256;
};
export type ThreadOptions = {
  scope?: ReviewScope;
  allowScopeChange?: boolean;
  allowApplied?: boolean;
};
export type ReviewRecord = {
  version: number;
  revision: number;
  updatedAt?: string;
  pages: Record<string, unknown>;
};
