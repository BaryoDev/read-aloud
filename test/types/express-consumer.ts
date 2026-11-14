// Compile-only: an Express app must accept the handlers, and authorize must see the request.
import type { AzureSpeechOptions, SynthesisResult } from "../../dist/server.js";
import express from "express";
import { AzureSpeechTTS, createReadAloudExpressHandler, createReadAloudHandler } from "../../dist/server.js";

const app = express();
app.post(
  "/tts",
  express.json(),
  createReadAloudExpressHandler({
    authorize: (_body, req) => req.headers.authorization === "Bearer x",
  }),
);

createReadAloudHandler({
  authorize: (_body, request) => request.headers.get("authorization") === "Bearer x",
});

const azure: AzureSpeechOptions = { key: "k", region: "eastus", maxAudioBytes: 1024 };
createReadAloudHandler({ backend: "azure", azure });
createReadAloudExpressHandler({ backend: "edge" });
const engine: { synthesize: (text: string) => Promise<SynthesisResult> } = new AzureSpeechTTS(azure);
void engine;
