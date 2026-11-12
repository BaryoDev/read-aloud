import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { WebSocketServer } from "ws";
import { EdgeTTS } from "../dist/server.js";

// A local stand-in for the speech service. `script(ws)` runs once the SSML request arrives.
async function fakeService(script) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.on("listening", r));
  const seen = { connections: 0 };
  wss.on("connection", (ws) => {
    seen.connections++;
    let n = 0;
    ws.on("message", () => {
      if (++n === 2) script(ws);
    });
  });
  const { port } = wss.address();
  return {
    seen,
    engine: new EdgeTTS({ endpoint: `ws://127.0.0.1:${port}/v1` }),
    close: () => {
      for (const c of wss.clients) c.terminate();
      return new Promise((r) => wss.close(r));
    },
  };
}

function audioFrame(bytes) {
  const header = Buffer.from("X-RequestId:1\r\nPath:audio\r\n");
  const head = Buffer.alloc(2);
  head.writeUInt16BE(header.length);
  return Buffer.concat([head, header, Buffer.alloc(bytes, 7)]);
}
const textFrame = (path, body = "") => `X-Timestamp:t\r\nPath:${path}\r\n\r\n${body}`;
const metadata = (word) =>
  textFrame(
    "audio.metadata",
    JSON.stringify({ Metadata: [{ Type: "WordBoundary", Data: { Offset: 0, Duration: 10, text: { Text: word } } }] }),
  );

test("a socket that closes before turn.end rejects instead of returning a short clip", async () => {
  const svc = await fakeService((ws) => {
    ws.send(audioFrame(100), { binary: true });
    ws.close();
  });
  try {
    await assert.rejects(svc.engine.synthesize("hello"), /closed before the end/);
  } finally {
    await svc.close();
  }
});

test("a complete clip gets the content type of the requested format", async () => {
  const svc = await fakeService((ws) => {
    ws.send(audioFrame(100), { binary: true });
    ws.send(textFrame("turn.end"));
  });
  try {
    const wav = await svc.engine.synthesize("hello", { format: "riff-24khz-16bit-mono-pcm" });
    assert.equal(wav.contentType, "audio/wav");
    const mp3 = await svc.engine.synthesize("hello");
    assert.equal(mp3.contentType, "audio/mpeg");
  } finally {
    await svc.close();
  }
});

test("a drop after turn.end still returns the audio", async () => {
  const svc = await fakeService((ws) => {
    ws.send(audioFrame(100), { binary: true });
    ws.send(textFrame("turn.end"));
    ws.close();
  });
  try {
    const r = await svc.engine.synthesize("hello");
    assert.equal(r.audio.length, 100);
  } finally {
    await svc.close();
  }
});

test("spoken text that looks like a turn.end header does not end the stream early", async () => {
  const svc = await fakeService((ws) => {
    ws.send(audioFrame(100), { binary: true });
    ws.send(metadata("Path:turn.end"));
    ws.send(audioFrame(5000), { binary: true });
    ws.send(textFrame("turn.end"));
  });
  try {
    const r = await svc.engine.synthesize("hello Path:turn.end world");
    assert.equal(r.audio.length, 5100);
    assert.equal(r.boundaries[0].text, "Path:turn.end");
  } finally {
    await svc.close();
  }
});

test("a silent service times out", async () => {
  const svc = await fakeService(() => {});
  try {
    const t0 = Date.now();
    await assert.rejects(svc.engine.synthesize("hello", { timeoutMs: 200 }), /timed out/);
    assert.ok(Date.now() - t0 < 3000);
  } finally {
    await svc.close();
  }
});

test("a signal that is already aborted rejects without connecting", async () => {
  const svc = await fakeService((ws) => {
    ws.send(audioFrame(100), { binary: true });
    ws.send(textFrame("turn.end"));
  });
  try {
    await assert.rejects(svc.engine.synthesize("hello", { signal: AbortSignal.abort() }), /aborted/);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(svc.seen.connections, 0);
  } finally {
    await svc.close();
  }
});

test("an abort during synthesis rejects", async () => {
  const svc = await fakeService(() => {});
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(svc.engine.synthesize("hello", { signal: ac.signal }), /aborted/);
  } finally {
    await svc.close();
  }
});

test("the abort listener is removed when the synthesis finishes", async () => {
  const svc = await fakeService((ws) => {
    ws.send(audioFrame(100), { binary: true });
    ws.send(textFrame("turn.end"));
  });
  try {
    const ac = new AbortController();
    await svc.engine.synthesize("hello", { signal: ac.signal });
    assert.equal(getEventListeners(ac.signal, "abort").length, 0);
  } finally {
    await svc.close();
  }
});
