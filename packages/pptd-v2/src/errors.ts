/**
 * The error every PPTD read or write rejects with. It lives apart from parse.ts so the
 * validators it reports through (layout-schema.ts) do not import the parser back.
 */
export class PptdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PptdError";
  }
}
