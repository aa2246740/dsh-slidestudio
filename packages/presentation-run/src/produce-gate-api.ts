import {
  composedPageLeftoverIssues,
  EMPTY_CLOSER_PRODUCE_NEXT,
  HOST_SEED_PRODUCE_NEXT,
  isPlaceholderReviewIssue,
  isWritePageCloser,
  pageCoverage,
  pageHasVisibleContent,
  pageIdMatchesFile,
  persistPageKey,
  persistPagePathFromId,
  renderedLayoutBlocksCompose,
  tableEmptyCellIssues,
  writePageSchemaError,
  writePageSchemaIssues,
} from "./domain/layout-qa.js";
import { readMaterialChunk } from "./domain/material-content.js";
import { materialCapabilityEntries, verifyMaterial } from "./domain/material-pack.js";
import { visualReviewIsClaimable } from "./capabilities.js";

export type ProduceGateApi = {
  pageHasVisibleContent: typeof pageHasVisibleContent;
  pageCoverage: typeof pageCoverage;
  persistPageKey: typeof persistPageKey;
  persistPagePathFromId: typeof persistPagePathFromId;
  pageIdMatchesFile: typeof pageIdMatchesFile;
  tableEmptyCellIssues: typeof tableEmptyCellIssues;
  writePageSchemaIssues: typeof writePageSchemaIssues;
  writePageSchemaError: typeof writePageSchemaError;
  isWritePageCloser: typeof isWritePageCloser;
  visualReviewIsClaimable: typeof visualReviewIsClaimable;
  isPlaceholderReviewIssue: typeof isPlaceholderReviewIssue;
  composedPageLeftoverIssues: typeof composedPageLeftoverIssues;
  renderedLayoutBlocksCompose: typeof renderedLayoutBlocksCompose;
  verifyMaterial: typeof verifyMaterial;
  readMaterialChunk: typeof readMaterialChunk;
  materialCapabilityEntries: typeof materialCapabilityEntries;
  EMPTY_CLOSER_PRODUCE_NEXT: string;
  HOST_SEED_PRODUCE_NEXT: string;
};

export const liveApi: ProduceGateApi = {
  pageHasVisibleContent,
  pageCoverage,
  persistPageKey,
  persistPagePathFromId,
  pageIdMatchesFile,
  tableEmptyCellIssues,
  writePageSchemaIssues,
  writePageSchemaError,
  isWritePageCloser,
  visualReviewIsClaimable,
  isPlaceholderReviewIssue,
  composedPageLeftoverIssues,
  renderedLayoutBlocksCompose,
  verifyMaterial,
  readMaterialChunk,
  materialCapabilityEntries,
  EMPTY_CLOSER_PRODUCE_NEXT,
  HOST_SEED_PRODUCE_NEXT,
};
