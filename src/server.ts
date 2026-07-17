// Node entry point. Import from "@baryodev/read-aloud/server".
export { EdgeTTS } from "./server/edge-tts.js";
export type {
  SynthesizeOptions,
  SynthesisResult,
  WordBoundary,
} from "./server/edge-tts.js";
export {
  createReadAloudHandler,
  createReadAloudExpressHandler,
} from "./server/handler.js";
export type {
  HandlerOptions,
  ReadAloudRequest,
  ReadAloudResponseBody,
} from "./server/handler.js";
