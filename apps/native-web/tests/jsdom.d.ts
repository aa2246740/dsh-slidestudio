declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string);
    readonly window: {
      document: Document;
      close(): void;
    };
  }
}
