import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AzureSpeechTTS, createReadAloudHandler, InvalidOptionError } from "../dist/server.js";

const KEY = "sekret-key-0123456789abcdef"; // allow-secret test fixture, not a real key

// A local stand-in for the Azure REST endpoint. `respond(req, res, body)` answers each request.
async function fakeAzure(respond) {
  const seen = [];
  const server = createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const body = Buffer.concat(parts).toString("utf8");
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      respond(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    seen,
    endpoint: `http://127.0.0.1:${port}/cognitiveservices/v1`,
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

const ok = (bytes) => (_req, res) => {
  res.writeHead(200, { "Content-Type": "audio/mpeg" });
  res.end(Buffer.from(bytes));
};

test("success returns the audio bytes and sends the documented request", async () => {
  const svc = await fakeAzure(ok([1, 2, 3, 4]));
  try {
    const tts = new AzureSpeechTTS({ key: KEY, endpoint: svc.endpoint });
    const r = await tts.synthesize("hello", { voice: "en-GB-RyanNeural" });
    assert.deepEqual([...r.audio], [1, 2, 3, 4]);
    assert.equal(r.contentType, "audio/mpeg");
    assert.deepEqual(r.boundaries, []);
    const req = svc.seen[0];
    assert.equal(req.method, "POST");
    assert.equal(req.headers["ocp-apim-subscription-key"], KEY);
    assert.equal(req.headers["content-type"], "application/ssml+xml");
    assert.equal(req.headers["x-microsoft-outputformat"], "audio-24khz-48kbitrate-mono-mp3");
    assert.ok(req.headers["user-agent"]);
    assert.ok(req.body.includes("<voice name='en-GB-RyanNeural'>"));
    assert.ok(req.body.includes(">hello</prosody>"));
  } finally {
    await svc.close();
  }
});

test("a riff format gives audio/wav", async () => {
  const svc = await fakeAzure(ok([9]));
  try {
    const tts = new AzureSpeechTTS({ key: KEY, endpoint: svc.endpoint });
    const r = await tts.synthesize("hi", { format: "riff-24khz-16bit-mono-pcm" });
    assert.equal(r.contentType, "audio/wav");
    assert.equal(svc.seen[0].headers["x-microsoft-outputformat"], "riff-24khz-16bit-mono-pcm");
  } finally {
    await svc.close();
  }
});

test("text is escaped in the SSML body", async () => {
  const svc = await fakeAzure(ok([1]));
  try {
    const tts = new AzureSpeechTTS({ key: KEY, endpoint: svc.endpoint });
    await tts.synthesize(`a < b & c > d "q" 'p' </prosody><break time='60s'/>`);
    const body = svc.seen[0].body;
    assert.ok(body.includes("a &lt; b &amp; c &gt; d &quot;q&quot; &apos;p&apos; &lt;/prosody&gt;&lt;break time=&apos;60s&apos;/&gt;"));
    assert.ok(!body.includes("<break"));
    assert.equal((body.match(/<prosody/g) ?? []).length, 1);
  } finally {
    await svc.close();
  }
});

test("control characters XML cannot carry are dropped", async () => {
  const svc = await fakeAzure(ok([1]));
  try {
    const tts = new AzureSpeechTTS({ key: KEY, endpoint: svc.endpoint });
    await tts.synthesize("a\u0000b\u0008c\u000bd");
    assert.ok(svc.seen[0].body.includes(">abcd</prosody>"));
  } finally {
    await svc.close();
  }
});

test("a bad voice, rate or format is rejected before any request", async () => {
  const svc = await fakeAzure(ok([1]));
  try {
    const tts = new AzureSpeechTTS({ key: KEY, endpoint: svc.endpoint });
    await assert.rejects(tts.synthesize("hi", { voice: "a'><break/><voice name='x" }), InvalidOptionError);
    await assert.rejects(tts.synthesize("hi", { rate: "100%'><break time='60s'/>" }), InvalidOptionError);
    await assert.rejects(tts.synthesize("hi", { format: "mp3\r\nX-Evil: 1" }), InvalidOptionError);
    assert.equal(svc.seen.length, 0);
  } finally {
    await svc.close();
  }
});

test("401 and 429 give an error with the status and without the key", async () => {
  for (const status of [401, 429]) {
    // The fake echoes the key in its body, like a hostile or sloppy server could.
    const svc = await fakeAzure((req, res) => {
      res.writeHead(status);
      res.end(`bad key ${req.headers["ocp-apim-subscription-key"]}`);
    });
    try {
      const tts = new AzureSpeechTTS({ key: KEY, endpoint: svc.endpoint });
      await assert.rejects(tts.synthesize("hi"), (err) => {
        assert.ok(err.message.includes(String(status)));
        assert.ok(!err.message.includes(KEY));
        assert.ok(!String(err.stack).includes(KEY));
        assert.ok(!JSON.stringify(err, Object.getOwnPropertyNames(err)).includes(KEY));
        return true;
      });
    } finally {
      await svc.close();
    }
  }
});

test("a server that never answers times out and the error has no key", async () => {
  const svc = await fakeAzure(() => {});
  try {
    const tts = new AzureSpeechTTS({ key: KEY, endpoint: svc.endpoint });
    await assert.rejects(tts.synthesize("hi", { timeoutMs: 200 }), (err) => {
      assert.match(err.message, /timed out/);
      assert.ok(!err.message.includes(KEY));
      return true;
    });
  } finally {
    await svc.close();
  }
});

test("a body that stalls after the headers also times out", async () => {
  const svc = await fakeAzure((_req, res) => {
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.write(Buffer.from([1, 2]));
  });
  try {
    const tts = new AzureSpeechTTS({ key: KEY, endpoint: svc.endpoint });
    await assert.rejects(tts.synthesize("hi", { timeoutMs: 200 }), /timed out/);
  } finally {
    await svc.close();
  }
});

test("an aborted signal rejects, before and during the request", async () => {
  const svc = await fakeAzure(() => {});
  try {
    const tts = new AzureSpeechTTS({ key: KEY, endpoint: svc.endpoint });
    await assert.rejects(tts.synthesize("hi", { signal: AbortSignal.abort() }), /aborted/);
    assert.equal(svc.seen.length, 0);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(tts.synthesize("hi", { signal: ac.signal, timeoutMs: 0 }), /aborted/);
  } finally {
    await svc.close();
  }
});

test("a response over maxAudioBytes is an error, declared or streamed", async () => {
  const declared = await fakeAzure((_req, res) => {
    res.writeHead(200, { "Content-Length": "100" });
    res.end(Buffer.alloc(100));
  });
  const streamed = await fakeAzure((_req, res) => {
    res.writeHead(200); // chunked, no length
    res.write(Buffer.alloc(60));
    res.end(Buffer.alloc(60));
  });
  try {
    for (const svc of [declared, streamed]) {
      const tts = new AzureSpeechTTS({ key: KEY, endpoint: svc.endpoint, maxAudioBytes: 50 });
      await assert.rejects(tts.synthesize("hi"), /too large/);
    }
    const tts = new AzureSpeechTTS({ key: KEY, endpoint: declared.endpoint, maxAudioBytes: 100 });
    assert.equal((await tts.synthesize("hi")).audio.length, 100);
  } finally {
    await declared.close();
    await streamed.close();
  }
});

test("an empty 200 is an error", async () => {
  const svc = await fakeAzure((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  try {
    const tts = new AzureSpeechTTS({ key: KEY, endpoint: svc.endpoint });
    await assert.rejects(tts.synthesize("hi"), /no audio/);
  } finally {
    await svc.close();
  }
});

test("a redirect is not followed, so the key stays on the first host", async () => {
  const other = await fakeAzure(ok([1]));
  const svc = await fakeAzure((_req, res) => {
    res.writeHead(307, { Location: other.endpoint });
    res.end();
  });
  try {
    const tts = new AzureSpeechTTS({ key: KEY, endpoint: svc.endpoint });
    await assert.rejects(tts.synthesize("hi"), (err) => !err.message.includes(KEY));
    assert.equal(other.seen.length, 0);
  } finally {
    await svc.close();
    await other.close();
  }
});

test("the constructor needs a key and a region or endpoint, and never echoes the key", () => {
  const saved = { k: process.env.AZURE_SPEECH_KEY, r: process.env.AZURE_SPEECH_REGION };
  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;
  try {
    assert.throws(() => new AzureSpeechTTS({ region: "eastus" }), /key is not set/);
    assert.throws(() => new AzureSpeechTTS({ key: KEY }), /region/);
    assert.throws(() => new AzureSpeechTTS({ key: KEY, region: "east.evil.com/x" }), (e) => !e.message.includes(KEY));
    assert.throws(() => new AzureSpeechTTS({ key: KEY, endpoint: "ftp://x" }), /http or https/);
    assert.throws(() => new AzureSpeechTTS({ key: `${KEY}\r\nX: y`, region: "eastus" }), (e) => !e.message.includes(KEY));
    assert.doesNotThrow(() => new AzureSpeechTTS({ key: KEY, region: "eastus" }));
    process.env.AZURE_SPEECH_KEY = KEY;
    process.env.AZURE_SPEECH_REGION = "westeurope";
    assert.doesNotThrow(() => new AzureSpeechTTS());
  } finally {
    for (const [name, v] of [["AZURE_SPEECH_KEY", saved.k], ["AZURE_SPEECH_REGION", saved.r]]) {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
  }
});

test("the handler uses Azure when azure is set, and a failure never leaks the key", async () => {
  const svc = await fakeAzure(ok([5, 6]));
  try {
    const handler = createReadAloudHandler({ azure: { key: KEY, endpoint: svc.endpoint } });
    const res = await handler(new Request("http://x/", { method: "POST", body: JSON.stringify({ text: "hi" }) }));
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(Buffer.from(json.audio, "base64").toString("hex"), "0506");
    assert.equal(svc.seen.length, 1);
  } finally {
    await svc.close();
  }
  const bad = await fakeAzure((_req, res) => {
    res.writeHead(401);
    res.end();
  });
  try {
    const errors = [];
    const handler = createReadAloudHandler({
      azure: { key: KEY, endpoint: bad.endpoint },
      onError: (e) => errors.push(e),
    });
    const res = await handler(new Request("http://x/", { method: "POST", body: JSON.stringify({ text: "hi" }) }));
    assert.equal(res.status, 500);
    assert.ok(!(await res.text()).includes(KEY));
    assert.match(errors[0].message, /401/);
    assert.ok(!errors[0].message.includes(KEY));
  } finally {
    await bad.close();
  }
});

test("backend azure without a key fails at setup, and the default stays Edge", () => {
  const saved = process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_KEY;
  try {
    assert.throws(() => createReadAloudHandler({ backend: "azure" }), /key is not set/);
    process.env.AZURE_SPEECH_KEY = KEY;
    // Env alone must not switch an existing caller off Edge.
    assert.doesNotThrow(() => createReadAloudHandler());
  } finally {
    if (saved === undefined) delete process.env.AZURE_SPEECH_KEY;
    else process.env.AZURE_SPEECH_KEY = saved;
  }
});

test("a custom engine wins over azure", async () => {
  let called = false;
  const handler = createReadAloudHandler({
    azure: { key: KEY, region: "eastus" },
    engine: {
      synthesize: async () => {
        called = true;
        return { audio: new Uint8Array([1]), boundaries: [], contentType: "audio/mpeg" };
      },
    },
  });
  const res = await handler(new Request("http://x/", { method: "POST", body: JSON.stringify({ text: "hi" }) }));
  assert.equal(res.status, 200);
  assert.ok(called);
});
