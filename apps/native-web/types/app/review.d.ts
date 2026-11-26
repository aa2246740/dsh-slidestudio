import type { ReviewScope, ReviewThread } from "../server/contracts.js";

export type EditorCommentScope = Partial<Omit<ReviewScope, "kind">> & {
  kind: "page" | "elements";
};

export type EditorComment = Omit<Partial<ReviewThread>, "id" | "text" | "x" | "y" | "resolved" | "scope"> & {
  id: string;
  text: string;
  x: number;
  y: number;
  resolved: boolean;
  scope?: EditorCommentScope;
  _resolvePending?: boolean;
};

export type CommentEntry = { pagePath: string; comment: EditorComment };
