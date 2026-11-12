import { test } from "node:test";
import assert from "node:assert/strict";
import { ReadAloud } from "../dist/index.js";

// A DOM-free audio element: records what the controller does to it.
function makeAudio() {
  const listeners = {};
  const el = {
    plays: 0,
    paused: false,
    src: "",
    currentTime: 0,
    duration: 10,
    addEventListener(ev, fn) { (listeners[ev] ??= []).push(fn); },
    fire(ev) { for (const fn of listeners[ev] ?? []) fn(); },
    async play() { el.plays++; el.fire("playing"); },
    pause() { el.paused = true; },
    removeAttribute() {},
  };
  return el;
}

function setup(extra = {}) {
  const made = [];
  const errors = [];
  const states = [];
  const fetches = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const opts = {
    text: "hello there",
    createAudio: () => (made.push(makeAudio()), made.at(-1)),
    onError: (e) => errors.push(e),
    onState: (s) => states.push(s),
    ...extra,
  };
  return { made, errors, states, fetches, release, gate, opts };
}

const clip = { audio: new Uint8Array([1, 2, 3]), contentType: "audio/mpeg", boundaries: [] };

test("destroy() during a pending load: nothing plays, no audio element, no error", async () => {
  const t = setup();
  t.opts.fetchAudio = async () => {
    await t.gate;
    return clip;
  };
  const reader = new ReadAloud(t.opts);
  const playing = reader.play();
  reader.destroy();
  t.release();
  await playing;
  assert.equal(t.made.length, 0);
  assert.equal(t.errors.length, 0);
  assert.equal(reader.objectUrl, null);
});

test("destroy() aborts the signal handed to fetchAudio", async () => {
  const t = setup();
  let seen;
  t.opts.fetchAudio = async (payload) => {
    seen = payload.signal;
    await t.gate;
    return clip;
  };
  const reader = new ReadAloud(t.opts);
  const playing = reader.play();
  await Promise.resolve();
  assert.equal(seen.aborted, false);
  reader.destroy();
  assert.equal(seen.aborted, true);
  t.release();
  await playing;
});

test("an abort error from a destroyed load does not reach onError", async () => {
  const t = setup();
  t.opts.fetchAudio = async (payload) => {
    await t.gate;
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  };
  const reader = new ReadAloud(t.opts);
  const playing = reader.play();
  reader.destroy();
  t.release();
  await playing;
  assert.equal(t.errors.length, 0);
  assert.notEqual(reader.state, "error");
});

test("after an audio error, play() fetches again", async () => {
  const t = setup();
  let calls = 0;
  t.opts.fetchAudio = async () => (calls++, clip);
  const reader = new ReadAloud(t.opts);
  await reader.play();
  assert.equal(calls, 1);
  t.made[0].fire("error");
  assert.equal(reader.state, "error");
  assert.equal(t.errors.length, 1);
  await reader.play();
  assert.equal(calls, 2);
});

test("without an error, a second play() reuses the cached audio", async () => {
  const t = setup();
  let calls = 0;
  t.opts.fetchAudio = async () => (calls++, clip);
  const reader = new ReadAloud(t.opts);
  await reader.play();
  await reader.play();
  assert.equal(calls, 1);
});

test("the default fetch does not put the signal in the request body", async () => {
  const t = setup();
  const real = globalThis.fetch;
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = init;
    return { ok: true, json: async () => ({ audio: "AQID", contentType: "audio/mpeg" }) };
  };
  try {
    await new ReadAloud(t.opts).play();
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(JSON.parse(sent.body), { text: "hello there" });
  assert.ok(sent.signal instanceof AbortSignal);
});
