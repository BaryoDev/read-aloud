// Compile-only: an Express app must accept the handlers, and authorize must see the request.
import express from "express";
import { createReadAloudExpressHandler, createReadAloudHandler } from "../../dist/server.js";

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
