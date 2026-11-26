/**
 * Test-only fixtures for dependent packages: an attached deck template with its palette, an
 * editor lease that lapses while a write waits for the project lock, and a composed deck followed
 * by a manual editor layout edit. Production code never imports this module. The package exposes
 * it as `@open-slidestudio/presentation-run/testkit`.
 */
export * from "./domain/deck-template.testkit.js";
export * from "./domain/editor-lapse.testkit.js";
export * from "./domain/composed-deck.testkit.js";
