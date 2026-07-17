// Browser entry point. Import from "@baryodev/read-aloud".
// Headless-first: `ReadAloud` is the core; the button and web component are optional sugar.
export { ReadAloud, createReadAloud } from "./client/read-aloud.js";
export { downloadRecording } from "./client/download.js";
export type { ReadAloudOptions } from "./client/read-aloud.js";
export { Highlighter } from "./client/highlight.js";
export type { HighlightOptions } from "./client/highlight.js";
export { mountButton, defineReadAloudElement } from "./client/button.js";
export type { ButtonOptions, MountedButton } from "./client/button.js";
export type {
  ReadAloudState,
  WordBoundary,
  FetchPayload,
  FetchResult,
} from "./client/types.js";
