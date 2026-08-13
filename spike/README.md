# spike/

Throwaway programs that answer one question before it is expensive to answer. Nothing here is
published, imported by the package, or covered by semver.

## origin-spike

**Question:** can the Edge TTS engine be ported from TypeScript to C#?

It matters because the engine is the only part of `@baryodev/read-aloud` that cannot be reused
as-is. The browser half is framework-free and ships anywhere. The server half speaks a WebSocket
protocol to a Microsoft endpoint that requires an `Origin` header naming a specific Edge extension,
and `ClientWebSocket.Options.SetRequestHeader` refuses some restricted headers depending on
platform and runtime. If it refused `Origin`, a C# port would need a different WebSocket client, or
a hand-rolled TLS handshake.

**Answer: it works.** Measured 13 August 2026 on macOS arm64, .NET 8.0.24:

```
STEP 2  restricted request headers  <-- the gate
  Origin      : accepted
  User-Agent  : accepted

STEP 3  connect
  state: Open

  audio bytes      : 20,736
  word boundaries  : 9
```

The output is a real `MPEG ADTS, layer III, 48 kbps, 24 kHz, Monaural` file of 3.46 seconds, which
is exactly the requested `audio-24khz-48kbitrate-mono-mp3`. So the whole protocol round-trips, not
just the handshake, and the per-word timings that drive highlighting arrive intact.

```sh
cd spike/origin-spike
dotnet run                      # default sentence
dotnet run -- "your text here"
```

### Three things worth carrying into the real port

**The `Sec-MS-GEC` token gets simpler in C#.** The TypeScript computes
`(unixSeconds + 11644473600) * 10^7` with BigInt. That constant is the 1601-to-1970 epoch offset,
so the expression is a Windows file time and .NET has `DateTime.ToFileTimeUtc()` built in.

**Do not build `speech.config` with an interpolated string.** In C# interpolation `}}` renders as a
single `}`, so a run of closing braces silently closes one short. The server then accepts the
connection and sends no audio, which looks exactly like a network problem. This cost the first run
of the spike, and the JSON is built by concatenation here for that reason.

**Fragment reassembly is insurance, not load-bearing.** The `ws` npm library hands you whole
messages and `ClientWebSocket` hands you fragments, so the expectation was that a naive port would
break on split frames. It does not: at 297KB of audio, 574 messages arrived in 574 fragments, none
split, because the server chunks small enough that a 16KB buffer is never exceeded. The loop stays
because it costs nothing and a larger `outputFormat` or a smaller buffer would start splitting
frames without any error to notice.

### The CI job is also a canary

`.github/workflows/edge-tts-spike.yml` runs this on Ubuntu, Windows and macOS, weekly.

The cross-platform run is the point today. The schedule is the point later: this endpoint is
undocumented and unsupported by Microsoft, and can change or start rate-limiting without notice.
When the job starts failing, the Edge engine is no longer dependable and the Azure engine should
become the default. Better to learn that from a red build than from a user.
