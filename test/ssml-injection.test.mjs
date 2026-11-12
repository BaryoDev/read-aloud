import { test } from "node:test";
import assert from "node:assert/strict";
import { EdgeTTS, InvalidOptionError, buildSsml, createReadAloudHandler, createReadAloudExpressHandler } from "../dist/server.js";

const INJECT = "100%'><break time='60s'/><prosody rate='100%";

test("a rate with a quote is rejected and never reaches the SSML", () => {
  assert.throws(
    () => buildSsml("hi", "en-US-JennyNeural", INJECT, "+0Hz", "+0%"),
    InvalidOptionError,
  );
});

test("pitch and volume with a quote are rejected", () => {
  assert.throws(() => buildSsml("hi", "en-US-JennyNeural", "+0%", INJECT, "+0%"), InvalidOptionError);
  assert.throws(() => buildSsml("hi", "en-US-JennyNeural", "+0%", "+0Hz", INJECT), InvalidOptionError);
});

test("a voice with a quote is rejected and never reaches the SSML", () => {
  const voice = "en-US-JennyNeural'><break time='60s'/><voice name='x";
  assert.throws(() => buildSsml("hi", voice, "+0%", "+0Hz", "+0%"), InvalidOptionError);
});

test("synthesize rejects a bad rate before opening a connection", async () => {
  await assert.rejects(new EdgeTTS().synthesize("hi", { rate: INJECT }), InvalidOptionError);
});

test("the handler answers 400 for a bad rate", async () => {
  const handler = createReadAloudHandler();
  const res = await handler(
    new Request("http://x/", { method: "POST", body: JSON.stringify({ text: "hi", rate: INJECT }) }),
  );
  assert.equal(res.status, 400);
});

test("the handler answers 400 for a bad voice", async () => {
  const handler = createReadAloudHandler();
  const res = await handler(
    new Request("http://x/", { method: "POST", body: JSON.stringify({ text: "hi", voice: "a'b" }) }),
  );
  assert.equal(res.status, 400);
});

test("normal values still build the SSML", () => {
  const ssml = buildSsml("a < b", "en-US-AriaNeural", "-10%", "+5Hz", "default");
  assert.ok(ssml.includes("<voice name='en-US-AriaNeural'>"));
  assert.ok(ssml.includes("pitch='+5Hz' rate='-10%' volume='default'"));
  assert.ok(ssml.includes("a &lt; b"));
  assert.doesNotThrow(() => buildSsml("hi", "zh-CN-liaoning-XiaobeiNeural", "+0%", "-2st", "+0%"));
});

test("creating a handler with a bad default throws", () => {
  assert.throws(() => createReadAloudHandler({ defaults: { rate: INJECT } }), InvalidOptionError);
  assert.throws(() => createReadAloudExpressHandler({ defaultVoice: "a'b" }), InvalidOptionError);
  assert.doesNotThrow(() => createReadAloudHandler({ defaultVoice: "en-US-AriaNeural", defaults: { rate: "+0%" } }));
});

test("the Express handler answers 400 for a bad rate", async () => {
  const sent = {};
  const res = {
    status(code) { sent.status = code; return res; },
    json(body) { sent.body = body; },
    send(body) { sent.body = body; },
    setHeader() {},
  };
  await createReadAloudExpressHandler()({ body: { text: "hi", rate: INJECT } }, res);
  assert.equal(sent.status, 400);
});
