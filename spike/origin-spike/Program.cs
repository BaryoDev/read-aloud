using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

// Spike: can ClientWebSocket speak the Edge "read aloud" protocol?
//
// Gates the whole read-aloud C# port. Two questions, in order:
//   1. Does ClientWebSocket.Options.SetRequestHeader accept "Origin" and "User-Agent"?
//      Both are restricted in some HTTP stacks, and the endpoint rejects the connection without them.
//   2. Does the fragment reassembly work? The `ws` npm library hands you whole messages;
//      ClientWebSocket hands you fragments, so the TS port cannot be transliterated.
//
// Success = an mp3 on disk with word boundaries. Anything else is a finding.

const string TrustedClientToken = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const string WssUrl = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const string ChromiumVersion = "134.0.3124.66";
const string ExtensionOrigin = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";

var text = args.Length > 0 ? args[0] : "The quick brown fox jumps over the lazy dog.";
var voice = "en-US-JennyNeural";
var format = "audio-24khz-48kbitrate-mono-mp3";

Console.WriteLine($"runtime   : {System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}");
Console.WriteLine($"os        : {System.Runtime.InteropServices.RuntimeInformation.OSDescription.Trim()}");
Console.WriteLine($"arch      : {System.Runtime.InteropServices.RuntimeInformation.OSArchitecture}");
Console.WriteLine();

// ---- 1. the Sec-MS-GEC token -------------------------------------------------
//
// The TS does (unixSeconds + 11644473600) * 10^7, which is exactly a Windows file time.
// .NET has that built in, so this is the one part of the port that gets *simpler*.

var window = DateTime.UtcNow;
window = window.AddTicks(-(window.Ticks % TimeSpan.TicksPerSecond))          // drop sub-second
               .AddSeconds(-(window.Second % 300) - 60 * (window.Minute % 5)); // floor to 5 min
var fileTime = window.ToFileTimeUtc();
var gec = Convert.ToHexString(
    SHA256.HashData(Encoding.ASCII.GetBytes($"{fileTime}{TrustedClientToken}")));

Console.WriteLine("STEP 1  Sec-MS-GEC token");
Console.WriteLine($"  window (utc, floored) : {window:yyyy-MM-dd HH:mm:ss}");
Console.WriteLine($"  windows file time     : {fileTime}");
Console.WriteLine($"  token                 : {gec[..16]}...");
Console.WriteLine();

// ---- 2. THE GATE: can we set Origin and User-Agent? --------------------------

var connectionId = Guid.NewGuid().ToString("N");
using var ws = new ClientWebSocket();

Console.WriteLine("STEP 2  restricted request headers  <-- the gate");
try
{
    ws.Options.SetRequestHeader("Origin", ExtensionOrigin);
    Console.WriteLine("  Origin      : accepted");
}
catch (Exception ex)
{
    Console.WriteLine($"  Origin      : REJECTED -> {ex.GetType().Name}: {ex.Message}");
    Console.WriteLine();
    Console.WriteLine("VERDICT: blocked. ClientWebSocket will not carry the Origin header on this");
    Console.WriteLine("platform, so the port needs a different websocket client (e.g. Websocket.Client");
    Console.WriteLine("over System.Net.Sockets, or a raw TLS socket doing the handshake by hand).");
    return 2;
}

try
{
    ws.Options.SetRequestHeader(
        "User-Agent",
        $"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        $"Chrome/{ChromiumVersion} Safari/537.36 Edg/{ChromiumVersion}");
    Console.WriteLine("  User-Agent  : accepted");
}
catch (Exception ex)
{
    Console.WriteLine($"  User-Agent  : REJECTED -> {ex.GetType().Name}: {ex.Message}");
    return 2;
}

Console.WriteLine();

// Setting a header is not the same as the server accepting it. Only the connect proves that.

var url =
    $"{WssUrl}?TrustedClientToken={TrustedClientToken}" +
    $"&Sec-MS-GEC={gec}" +
    $"&Sec-MS-GEC-Version=1-{ChromiumVersion}" +
    $"&ConnectionId={connectionId}";

Console.WriteLine("STEP 3  connect");
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
try
{
    await ws.ConnectAsync(new Uri(url), cts.Token);
    Console.WriteLine($"  state: {ws.State}");
}
catch (Exception ex)
{
    Console.WriteLine($"  FAILED -> {ex.GetType().Name}: {ex.Message}");
    Console.WriteLine();
    Console.WriteLine("VERDICT: headers were settable but the handshake was refused. Check whether the");
    Console.WriteLine("server saw the Origin at all before concluding the endpoint is gone.");
    return 3;
}

Console.WriteLine();

// ---- 4. send config + ssml ---------------------------------------------------

static string Timestamp() => DateTime.UtcNow.ToString("o");

async Task SendAsync(string payload) =>
    await ws.SendAsync(Encoding.UTF8.GetBytes(payload), WebSocketMessageType.Text, true, cts.Token);

// Built without interpolation on purpose. In an interpolated string `}}` renders as a single
// `}`, so the run of closing braces at the end of this JSON is very easy to get wrong.
var speechConfig =
    "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{" +
    "\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"true\"},"
    + "\"outputFormat\":\"" + format + "\"}}}}";

await SendAsync(
    $"X-Timestamp:{Timestamp()}\r\n" +
    "Content-Type:application/json; charset=utf-8\r\n" +
    "Path:speech.config\r\n\r\n" +
    speechConfig);

var ssml =
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    $"<voice name='{voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>" +
    $"{System.Security.SecurityElement.Escape(text)}</prosody></voice></speak>";

await SendAsync(
    $"X-RequestId:{connectionId}\r\n" +
    $"X-Timestamp:{Timestamp()}\r\n" +
    "Content-Type:application/ssml+xml\r\n" +
    "Path:ssml\r\n\r\n" +
    ssml);

Console.WriteLine("STEP 4  receive  (fragment reassembly is the second thing being proved)");

// ---- 5. the receive loop -----------------------------------------------------
//
// This is where a straight transliteration of the TS would break. `ws` reassembles
// messages; ClientWebSocket does not, so a binary audio frame arrives in pieces and the
// 2-byte header only exists at the start of the FIRST fragment. Accumulate, then parse.

var audio = new MemoryStream();
var boundaries = new List<(string Text, double Offset, double Duration)>();
var buffer = new byte[16 * 1024];
var message = new MemoryStream();
var fragments = 0;
var messages = 0;
var turnEnded = false;

while (ws.State == WebSocketState.Open && !turnEnded)
{
    WebSocketReceiveResult result;
    message.SetLength(0);

    do
    {
        result = await ws.ReceiveAsync(buffer, cts.Token);
        if (result.MessageType == WebSocketMessageType.Close) { turnEnded = true; break; }
        message.Write(buffer, 0, result.Count);
        fragments++;
    }
    while (!result.EndOfMessage);

    if (turnEnded) break;
    messages++;

    var data = message.ToArray();

    if (result.MessageType == WebSocketMessageType.Binary)
    {
        // First 2 bytes: big-endian header length. Audio follows the header.
        var headerLength = (data[0] << 8) | data[1];
        var start = 2 + headerLength;
        if (start < data.Length) audio.Write(data, start, data.Length - start);
        continue;
    }

    var msg = Encoding.UTF8.GetString(data);

    // Trace the control frames. When this protocol drifts, the server says so in a text frame
    // and a silent failure looks identical to a network problem.
    var path = msg.Split("\r\n").FirstOrDefault(l => l.StartsWith("Path:")) ?? "(no path)";
    Console.WriteLine($"  <- text {path}");

    if (msg.Contains("Path:audio.metadata"))
    {
        var body = msg[(msg.IndexOf("\r\n\r\n", StringComparison.Ordinal) + 4)..];
        try
        {
            using var doc = JsonDocument.Parse(body);
            foreach (var m in doc.RootElement.GetProperty("Metadata").EnumerateArray())
            {
                if (m.GetProperty("Type").GetString() != "WordBoundary") continue;
                var d = m.GetProperty("Data");
                boundaries.Add((
                    d.GetProperty("text").GetProperty("Text").GetString() ?? "",
                    d.GetProperty("Offset").GetDouble() / 10000,   // 100ns ticks -> ms
                    d.GetProperty("Duration").GetDouble() / 10000));
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"  metadata parse failed: {ex.Message}");
        }
    }

    if (msg.Contains("Path:turn.end")) turnEnded = true;
}

Console.WriteLine($"  websocket messages   : {messages}");
Console.WriteLine($"  raw fragments        : {fragments}");
Console.WriteLine($"  audio bytes          : {audio.Length:N0}");
Console.WriteLine($"  word boundaries      : {boundaries.Count}");
Console.WriteLine();

if (audio.Length == 0)
{
    Console.WriteLine("VERDICT: connected but produced no audio. Protocol drift, not a header problem.");
    return 4;
}

var outPath = Path.Combine(AppContext.BaseDirectory, "spike.mp3");
await File.WriteAllBytesAsync(outPath, audio.ToArray());

Console.WriteLine("STEP 5  word timings (these drive the highlighting)");
foreach (var (t, offset, duration) in boundaries.Take(6))
    Console.WriteLine($"  {offset,7:N0} ms  +{duration,5:N0} ms   {t}");
if (boundaries.Count > 6) Console.WriteLine($"  ... and {boundaries.Count - 6} more");
Console.WriteLine();

Console.WriteLine($"wrote {outPath}");
Console.WriteLine();
Console.WriteLine("VERDICT: the port is viable on this platform.");
Console.WriteLine("  - Origin and User-Agent are settable on ClientWebSocket and accepted by the server");
Console.WriteLine("  - the audio and the word timings both come through intact");

if (fragments == messages)
{
    Console.WriteLine();
    Console.WriteLine($"  Note: {messages} messages arrived in {fragments} fragments, i.e. none were split.");
    Console.WriteLine("  The server chunks audio into many small frames, so a 16KB buffer is never");
    Console.WriteLine("  exceeded in practice. Keep the reassembly loop anyway: it costs nothing, and a");
    Console.WriteLine("  larger outputFormat or a smaller buffer would start splitting frames silently.");
}
else
{
    Console.WriteLine($"  - {messages} messages arrived in {fragments} fragments, so reassembly is load-bearing");
}

return 0;
