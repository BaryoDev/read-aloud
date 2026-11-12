import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadAloudHandler, createReadAloudExpressHandler } from "../dist/server.js";

const OK = { audio: new Uint8Array([1, 2, 3]), boundaries: [], contentType: "audio/mpeg" };

function fakeEngine(impl) {
  const calls = [];
  return {
    calls,
    synthesize: async (text, opts) => {
      calls.push({ text, opts });
      return impl ? impl(text, opts) : OK;
    },
  };
}

function post(body, init = {}) {
  return new Request("http://x/", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...init });
}

function fakeRes() {
  const sent = {};
  const listeners = {};
  const res = {
    sent,
    writableFinished: false,
    status(code) { sent.status = code; return res; },
    json(body) { sent.body = body; },
    setHeader() {},
    on(ev, fn) { listeners[ev] = fn; },
    off(ev) { delete listeners[ev]; },
    emit(ev) { listeners[ev]?.(); },
  };
  return res;
}

// --- body size and parsing ---

test("a body over maxBodyBytes answers 413 and authorize never runs", async () => {
  let authorized = false;
  const handler = createReadAloudHandler({
    maxBodyBytes: 1000,
    authorize: () => ((authorized = true), true),
    engine: fakeEngine(),
  });
  const res = await handler(post({ text: "a".repeat(1_000_000) }));
  assert.equal(res.status, 413);
  assert.equal(authorized, false);
});

test("a streamed body with no content-length is cut off at the cap", async () => {
  const handler = createReadAloudHandler({ maxBodyBytes: 1000, engine: fakeEngine() });
  const chunk = new TextEncoder().encode("a".repeat(400));
  let sent = 0;
  const body = new ReadableStream({
    pull(c) {
      if (sent++ < 100) c.enqueue(chunk);
      else c.close();
    },
  });
  const res = await handler(new Request("http://x/", { method: "POST", body, duplex: "half" }));
  assert.equal(res.status, 413);
  assert.ok(sent < 10, `read ${sent} chunks`);
});

test("a body under the cap still works", async () => {
  const engine = fakeEngine();
  const res = await createReadAloudHandler({ engine })(post({ text: "hello" }));
  assert.equal(res.status, 200);
  assert.equal(engine.calls[0].text, "hello");
});

test("invalid JSON answers 400 with a fixed message", async () => {
  const res = await createReadAloudHandler({ engine: fakeEngine() })(post("{not json"));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "read-aloud: invalid JSON" });
});

test("a null, array or scalar body answers 400", async () => {
  const handler = createReadAloudHandler({ authorize: (b) => b.text.length > 0, engine: fakeEngine() });
  for (const raw of ["null", "[]", "5", '"hi"']) {
    const res = await handler(post(raw));
    assert.equal(res.status, 400, raw);
  }
});

test("the Express handler answers 400 for a non-object body", async () => {
  const res = fakeRes();
  await createReadAloudExpressHandler({ engine: fakeEngine() })({ body: [1] }, res);
  assert.equal(res.sent.status, 400);
});

test("a 500 shows a fixed message and the real error goes to onError", async () => {
  let seen;
  const handler = createReadAloudHandler({
    authorize: () => {
      throw new Error("ECONNREFUSED 1.2.3.4:443");
    },
    onError: (e) => (seen = e),
    engine: fakeEngine(),
  });
  const res = await handler(post({ text: "hi" }));
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.ok(!text.includes("1.2.3.4"), text);
  assert.match(seen.message, /ECONNREFUSED/);
});

// --- stripping ---

test("a huge unclosed <script> body is handled in linear time", async () => {
  const handler = createReadAloudExpressHandler({ engine: fakeEngine() });
  const res = fakeRes();
  const t0 = Date.now();
  await handler({ body: { text: "<script>".repeat(150_000) } }, res);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.equal(res.sent.status, 400);
});

test("many '<' with no '>' are handled in linear time", async () => {
  const handler = createReadAloudExpressHandler({ engine: fakeEngine() });
  const res = fakeRes();
  const t0 = Date.now();
  await handler({ body: { text: "<<<<".repeat(250_000) } }, res);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test("tags, scripts and styles are still removed", async () => {
  const engine = fakeEngine();
  const html = "<p>Hi &amp; <b>bye</b></p><script>x()</script><style>p{}</style> end <script>open";
  await createReadAloudHandler({ engine })(post({ text: html }));
  assert.equal(engine.calls[0].text, "Hi & bye end open");
});

// --- timeout and signal ---

test("the Fetch handler passes the request signal and timeoutMs to the engine", async () => {
  const engine = fakeEngine();
  const ac = new AbortController();
  await createReadAloudHandler({ engine, timeoutMs: 1234 })(post({ text: "hi" }, { signal: ac.signal }));
  const { signal, timeoutMs } = engine.calls[0].opts;
  assert.equal(timeoutMs, 1234);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  ac.abort();
  assert.equal(signal.aborted, true);
});

test("the Express handler aborts the synthesis when the client closes", async () => {
  let signal;
  const engine = fakeEngine((_t, opts) => {
    signal = opts.signal;
    return new Promise((_res, rej) => opts.signal.addEventListener("abort", () => rej(new Error("aborted"))));
  });
  const res = fakeRes();
  const run = createReadAloudExpressHandler({ engine })({ body: { text: "hi" } }, res);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(signal.aborted, false);
  res.emit("close");
  await run;
  assert.equal(signal.aborted, true);
});

// --- voice allow-list ---

test("allowedVoices also applies to the default voice", async () => {
  const engine = fakeEngine();
  const handler = createReadAloudHandler({ allowedVoices: ["en-GB-RyanNeural"], engine });
  const res = await handler(post({ text: "hi" }));
  assert.equal(res.status, 400);
  assert.equal(engine.calls.length, 0);
});

test("a configured default voice that is on the list is allowed", async () => {
  const engine = fakeEngine();
  const handler = createReadAloudHandler({
    allowedVoices: ["en-GB-RyanNeural"],
    defaultVoice: "en-GB-RyanNeural",
    engine,
  });
  assert.equal((await handler(post({ text: "hi" }))).status, 200);
});
