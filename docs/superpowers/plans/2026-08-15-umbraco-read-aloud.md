# BaryoDev.Umbraco.ReadAloud Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Umbraco package that adds a working "listen to this article" button to a site, with audio generated from Microsoft Edge's neural voices and cached on the site's own disk.

**Architecture:** A C# port of the existing TypeScript Edge TTS engine sits behind an `IReadAloudEngine` seam. A controller at the site root resolves an Umbraco node, reads a configured property, hashes the text plus voice into a cache key, and either streams a cached MP3 or synthesizes one lazily. The browser client is compiled from the existing TypeScript and served as a single file, so the site owner needs no build step.

**Tech Stack:** .NET 9 and .NET 10 (multi-targeted), Umbraco 16, 17 and 18, `ClientWebSocket`, xUnit, Shouldly, `WebApplicationFactory`, SQLite.

**Spec:** `docs/superpowers/specs/2026-08-15-umbraco-read-aloud-design.md`

## Global Constraints

- **Multi-target `net9.0;net10.0`.** Umbraco 16 runs on .NET 9; 17 and 18 run on .NET 10. Reference `Umbraco.Cms.Api.Management` with `[16.0.0, 17.0.0)` on net9.0 and `[17.0.0, 19.0.0)` on net10.0.
- **Pick APIs that exist in all three Umbraco majors.** `IPublishedContentCache.GetAtRoot` and `GetByRoute` were obsoleted in 16 and removed in 17. Verify any Umbraco API against the shipped `Umbraco.Core.xml` for 16.5.1, 17.6.1 and 18.1.0 before using it.
- **No build step for the site owner.** Browser assets ship compiled inside the package. Any backoffice UI is a plain custom element using the `uui-*` components Umbraco already ships. No npm, no bundler.
- **Nothing about a listener is ever stored.** No database table, no migration, no IP, no user agent, no identity. The only persisted state is derived audio on disk.
- **Nothing leaves the server except the synthesis call itself.** No analytics, no telemetry, no third-party call at runtime.
- **v1 is configuration only.** No property editor, no backoffice extension, no schema of this package's own.
- **Package id** `BaryoDev.Umbraco.ReadAloud`. Tags must include `umbraco-marketplace`. Licence MIT.
- **Every change needs a test that fails without it.**
- **No em dashes in any prose, code comment, commit message or document.**

---

### Task 1: The Sec-MS-GEC token

The endpoint authenticates with a time-based hash rather than a key. Getting this wrong produces a connection that opens and then returns nothing, so it is pinned first and separately.

**Files:**
- Create: `src/BaryoDev.Umbraco.ReadAloud/Engine/EdgeTtsProtocol.cs`
- Create: `src/BaryoDev.Umbraco.ReadAloud/BaryoDev.Umbraco.ReadAloud.csproj`
- Create: `tests/Directory.Packages.props`
- Create: `tests/BaryoDev.Umbraco.ReadAloud.Tests/BaryoDev.Umbraco.ReadAloud.Tests.csproj`
- Test: `tests/BaryoDev.Umbraco.ReadAloud.Tests/EdgeTtsProtocolTests.cs`

**Interfaces:**
- Consumes: nothing
- Produces: `internal static class EdgeTtsProtocol` with
  - `const string TrustedClientToken = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"`
  - `const string ChromiumVersion = "134.0.3124.66"`
  - `const string ExtensionOrigin = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"`
  - `const string WssUrl = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"`
  - `static string SecMsGecToken(DateTimeOffset now)`
  - `static string UserAgent()`
  - `static string EscapeXml(string s)`

- [ ] **Step 1: Write the failing test**

`tests/BaryoDev.Umbraco.ReadAloud.Tests/EdgeTtsProtocolTests.cs`:

```csharp
using BaryoDev.Umbraco.ReadAloud.Engine;
using Shouldly;

namespace BaryoDev.Umbraco.ReadAloud.Tests;

public class EdgeTtsProtocolTests
{
    [Fact]
    public void The_token_is_stable_within_a_five_minute_window()
    {
        // The TypeScript rounds the clock down to a 300 second window before hashing, so every
        // call inside one window must produce the same token. Without the rounding the token
        // changes every second, the handshake still succeeds, and the server simply never
        // replies, which is a miserable thing to debug.
        var start = new DateTimeOffset(2026, 8, 15, 10, 0, 0, TimeSpan.Zero);

        EdgeTtsProtocol.SecMsGecToken(start)
            .ShouldBe(EdgeTtsProtocol.SecMsGecToken(start.AddSeconds(299)));
    }

    [Fact]
    public void The_token_changes_in_the_next_window()
    {
        var start = new DateTimeOffset(2026, 8, 15, 10, 0, 0, TimeSpan.Zero);

        EdgeTtsProtocol.SecMsGecToken(start)
            .ShouldNotBe(EdgeTtsProtocol.SecMsGecToken(start.AddSeconds(300)));
    }

    [Fact]
    public void The_token_is_uppercase_hex_of_a_sha256()
    {
        var token = EdgeTtsProtocol.SecMsGecToken(DateTimeOffset.UtcNow);

        token.Length.ShouldBe(64);
        token.ShouldBe(token.ToUpperInvariant());
        token.ShouldAllBe(c => Uri.IsHexDigit(c));
    }

    [Fact]
    public void Xml_special_characters_are_escaped_so_ssml_cannot_be_broken()
    {
        // The text goes inside an SSML document. Unescaped content silently corrupts the
        // request, and an ampersand in an article title is enough to do it.
        EdgeTtsProtocol.EscapeXml("Tom & Jerry <b>\"quoted\"</b> 'x'")
            .ShouldBe("Tom &amp; Jerry &lt;b&gt;&quot;quoted&quot;&lt;/b&gt; &apos;x&apos;");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests`
Expected: FAIL to compile, `EdgeTtsProtocol` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`src/BaryoDev.Umbraco.ReadAloud/Engine/EdgeTtsProtocol.cs`:

```csharp
using System.Security.Cryptography;
using System.Text;

namespace BaryoDev.Umbraco.ReadAloud.Engine;

/// <summary>
/// Constants and pure helpers for the Edge read-aloud WebSocket protocol.
/// </summary>
/// <remarks>
/// Separated from the socket work so the fiddly parts are testable without a network. The token
/// is the piece most likely to be got wrong: it is a hash of a Windows file time rounded down to
/// a five minute window, and an incorrect one produces a socket that opens and then stays silent
/// rather than an error.
/// </remarks>
internal static class EdgeTtsProtocol
{
    internal const string TrustedClientToken = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    internal const string ChromiumVersion = "134.0.3124.66";
    internal const string ExtensionOrigin = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
    internal const string WssUrl =
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";

    /// <summary>
    /// The Sec-MS-GEC query value: SHA256 of (Windows file time, floored to 300 seconds) plus the
    /// trusted client token, uppercase hex.
    /// </summary>
    /// <remarks>
    /// The TypeScript computes (unixSeconds + 11644473600) * 10^7 with BigInt. That constant is
    /// the 1601-to-1970 epoch offset, which means the expression is a Windows file time and .NET
    /// has ToFileTimeUtc built in.
    /// </remarks>
    internal static string SecMsGecToken(DateTimeOffset now)
    {
        var seconds = now.ToUnixTimeSeconds();
        seconds -= seconds % 300;

        var fileTime = DateTimeOffset.FromUnixTimeSeconds(seconds).UtcDateTime.ToFileTimeUtc();
        var hash = SHA256.HashData(Encoding.ASCII.GetBytes($"{fileTime}{TrustedClientToken}"));

        return Convert.ToHexString(hash);
    }

    internal static string UserAgent() =>
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        + $"Chrome/{ChromiumVersion} Safari/537.36 Edg/{ChromiumVersion}";

    internal static string EscapeXml(string s) => s
        .Replace("&", "&amp;")
        .Replace("<", "&lt;")
        .Replace(">", "&gt;")
        .Replace("\"", "&quot;")
        .Replace("'", "&apos;");
}
```

`src/BaryoDev.Umbraco.ReadAloud/BaryoDev.Umbraco.ReadAloud.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net9.0;net10.0</TargetFrameworks>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <GenerateDocumentationFile>true</GenerateDocumentationFile>
    <PackageId>BaryoDev.Umbraco.ReadAloud</PackageId>
    <Version>0.1.0</Version>
    <Title>Read Aloud for Umbraco</Title>
    <Authors>BaryoDev</Authors>
    <PackageLicenseExpression>MIT</PackageLicenseExpression>
    <PackageTags>umbraco umbraco-marketplace text-to-speech read-aloud accessibility tts</PackageTags>
    <PackageProjectUrl>https://github.com/BaryoDev/umbraco-read-aloud</PackageProjectUrl>
    <StaticWebAssetBasePath>App_Plugins/BaryoDev.ReadAloud</StaticWebAssetBasePath>
  </PropertyGroup>

  <ItemGroup Condition="'$(TargetFramework)' == 'net9.0'">
    <PackageReference Include="Umbraco.Cms.Api.Management" Version="[16.0.0, 17.0.0)" />
  </ItemGroup>
  <ItemGroup Condition="'$(TargetFramework)' == 'net10.0'">
    <PackageReference Include="Umbraco.Cms.Api.Management" Version="[17.0.0, 19.0.0)" />
  </ItemGroup>

  <ItemGroup>
    <InternalsVisibleTo Include="BaryoDev.Umbraco.ReadAloud.Tests" />
  </ItemGroup>
</Project>
```

`tests/Directory.Packages.props`:

```xml
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />
    <PackageVersion Include="xunit" Version="2.9.3" />
    <PackageVersion Include="xunit.runner.visualstudio" Version="3.1.4" />
    <PackageVersion Include="Shouldly" Version="4.3.0" />
    <PackageVersion Include="coverlet.collector" Version="6.0.4" />
    <PackageVersion Include="Umbraco.Cms" Version="$(UmbracoVersion)" />
    <PackageVersion Include="Microsoft.AspNetCore.Mvc.Testing" Version="10.0.0" />
  </ItemGroup>
</Project>
```

`tests/BaryoDev.Umbraco.ReadAloud.Tests/BaryoDev.Umbraco.ReadAloud.Tests.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <UmbracoVersion Condition="'$(UmbracoVersion)' == ''">18.1.0</UmbracoVersion>
    <UmbracoMajor>$(UmbracoVersion.Split('.')[0])</UmbracoMajor>
    <TargetFramework Condition="'$(UmbracoMajor)' == '16'">net9.0</TargetFramework>
    <TargetFramework Condition="'$(TargetFramework)' == ''">net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <IsPackable>false</IsPackable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" />
    <PackageReference Include="xunit" />
    <PackageReference Include="xunit.runner.visualstudio" />
    <PackageReference Include="Shouldly" />
    <PackageReference Include="coverlet.collector" />
    <ProjectReference Include="..\..\src\BaryoDev.Umbraco.ReadAloud\BaryoDev.Umbraco.ReadAloud.csproj" />
  </ItemGroup>
</Project>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "port the edge tts protocol helpers"
```

---

### Task 2: The engine contract and its models

A seam before an implementation, so Azure Speech drops in later without anything above it changing.

**Files:**
- Create: `src/BaryoDev.Umbraco.ReadAloud/Engine/IReadAloudEngine.cs`
- Test: `tests/BaryoDev.Umbraco.ReadAloud.Tests/SynthesisRequestTests.cs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `public sealed record WordBoundary(string Text, double OffsetMs, double DurationMs)`
  - `public sealed record SynthesisResult(byte[] Audio, IReadOnlyList<WordBoundary> Boundaries, string ContentType)`
  - `public sealed record SynthesisRequest { string Text; string Voice = "en-US-JennyNeural"; string Rate = "+0%"; string Pitch = "+0Hz"; string Volume = "+0%"; bool WordBoundaries = true; string CacheKey() }`
  - `public interface IReadAloudEngine { Task<SynthesisResult> SynthesizeAsync(SynthesisRequest request, CancellationToken ct = default); }`

- [ ] **Step 1: Write the failing test**

`tests/BaryoDev.Umbraco.ReadAloud.Tests/SynthesisRequestTests.cs`:

```csharp
using BaryoDev.Umbraco.ReadAloud.Engine;
using Shouldly;

namespace BaryoDev.Umbraco.ReadAloud.Tests;

public class SynthesisRequestTests
{
    private static SynthesisRequest Request(string text = "Hello world.") =>
        new() { Text = text };

    [Fact]
    public void The_same_text_and_voice_produce_the_same_key()
    {
        // The whole cache depends on this. The spike proved synthesis is deterministic: the same
        // sentence gave byte-identical output on Ubuntu, Windows and macOS, 20,736 bytes each.
        Request().CacheKey().ShouldBe(Request().CacheKey());
    }

    [Fact]
    public void Different_text_produces_a_different_key()
    {
        // This is what makes the cache self-invalidating. Editing a page changes the text, which
        // changes the key, so a stale recording can never be served.
        Request("Hello world.").CacheKey().ShouldNotBe(Request("Goodbye world.").CacheKey());
    }

    [Fact]
    public void Every_field_that_changes_the_audio_changes_the_key()
    {
        var baseline = Request().CacheKey();

        (Request() with { Voice = "en-GB-SoniaNeural" }).CacheKey().ShouldNotBe(baseline);
        (Request() with { Rate = "+20%" }).CacheKey().ShouldNotBe(baseline);
        (Request() with { Pitch = "-2st" }).CacheKey().ShouldNotBe(baseline);
        (Request() with { Volume = "-10%" }).CacheKey().ShouldNotBe(baseline);
    }

    [Fact]
    public void The_key_is_safe_to_use_as_a_file_name()
    {
        // It becomes a path under App_Data, so anything outside hex would be a traversal risk.
        var key = Request("../../etc/passwd \\ : * ?").CacheKey();

        key.Length.ShouldBe(64);
        key.ShouldAllBe(c => Uri.IsHexDigit(c));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests --filter SynthesisRequestTests`
Expected: FAIL to compile, `SynthesisRequest` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`src/BaryoDev.Umbraco.ReadAloud/Engine/IReadAloudEngine.cs`:

```csharp
using System.Security.Cryptography;
using System.Text;

namespace BaryoDev.Umbraco.ReadAloud.Engine;

/// <summary>One spoken word and when it is spoken, in milliseconds from the start.</summary>
public sealed record WordBoundary(string Text, double OffsetMs, double DurationMs);

/// <summary>Synthesized audio and the timings that drive word highlighting.</summary>
public sealed record SynthesisResult(
    byte[] Audio,
    IReadOnlyList<WordBoundary> Boundaries,
    string ContentType);

/// <summary>What to say and how to say it.</summary>
public sealed record SynthesisRequest
{
    public required string Text { get; init; }
    public string Voice { get; init; } = "en-US-JennyNeural";
    public string Rate { get; init; } = "+0%";
    public string Pitch { get; init; } = "+0Hz";
    public string Volume { get; init; } = "+0%";
    public bool WordBoundaries { get; init; } = true;

    /// <summary>
    /// A stable identifier for this exact audio, used as the cache file name.
    /// </summary>
    /// <remarks>
    /// Every field that can change the resulting audio is in the hash, and nothing else is.
    /// Because the text is included, editing a page changes the key, so the cache invalidates
    /// itself and no stale recording can be served. Hex output keeps it safe as a path segment.
    /// </remarks>
    public string CacheKey()
    {
        var material = $"{Voice}{Rate}{Pitch}{Volume}{Text}";
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(material)));
    }
}

/// <summary>
/// The seam between the package and whichever text-to-speech service is configured.
/// </summary>
/// <remarks>
/// Everything above this interface is unaware of which implementation is running, which is what
/// lets a site swap the free Edge endpoint for Azure Speech with a config change when it needs a
/// contract rather than a favour.
/// </remarks>
public interface IReadAloudEngine
{
    Task<SynthesisResult> SynthesizeAsync(SynthesisRequest request, CancellationToken ct = default);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests --filter SynthesisRequestTests`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "add the engine contract and cache key"
```

---

### Task 3: Parsing what the endpoint sends back

The wire format is parsed without a socket, so the tests never depend on Microsoft being reachable.

**Files:**
- Create: `src/BaryoDev.Umbraco.ReadAloud/Engine/EdgeTtsFrames.cs`
- Test: `tests/BaryoDev.Umbraco.ReadAloud.Tests/EdgeTtsFrameTests.cs`

**Interfaces:**
- Consumes: `WordBoundary` from Task 2
- Produces: `internal static class EdgeTtsFrames` with
  - `static ReadOnlySpan<byte> AudioPayload(ReadOnlySpan<byte> binaryFrame)`
  - `static IReadOnlyList<WordBoundary> ParseWordBoundaries(string textFrame)`
  - `static bool IsTurnEnd(string textFrame)`

- [ ] **Step 1: Write the failing test**

`tests/BaryoDev.Umbraco.ReadAloud.Tests/EdgeTtsFrameTests.cs`:

```csharp
using System.Text;
using BaryoDev.Umbraco.ReadAloud.Engine;
using Shouldly;

namespace BaryoDev.Umbraco.ReadAloud.Tests;

public class EdgeTtsFrameTests
{
    /// <summary>Builds a binary frame the way the service does: 2-byte big-endian header length, header, audio.</summary>
    private static byte[] BinaryFrame(string header, byte[] audio)
    {
        var headerBytes = Encoding.UTF8.GetBytes(header);
        var frame = new byte[2 + headerBytes.Length + audio.Length];
        frame[0] = (byte)(headerBytes.Length >> 8);
        frame[1] = (byte)(headerBytes.Length & 0xFF);
        headerBytes.CopyTo(frame, 2);
        audio.CopyTo(frame, 2 + headerBytes.Length);
        return frame;
    }

    [Fact]
    public void Audio_is_taken_from_after_the_declared_header_length()
    {
        var audio = new byte[] { 0xFF, 0xFB, 0x90, 0x64 };
        var frame = BinaryFrame("Path:audio\r\nContent-Type:audio/mpeg\r\n\r\n", audio);

        EdgeTtsFrames.AudioPayload(frame).ToArray().ShouldBe(audio);
    }

    [Fact]
    public void A_frame_with_a_header_and_no_audio_yields_nothing()
    {
        // Real streams contain these. Treating the header as audio corrupts the MP3 silently.
        var frame = BinaryFrame("Path:audio\r\n\r\n", []);

        EdgeTtsFrames.AudioPayload(frame).Length.ShouldBe(0);
    }

    [Fact]
    public void A_truncated_frame_yields_nothing_rather_than_throwing()
    {
        EdgeTtsFrames.AudioPayload(new byte[] { 0x00 }).Length.ShouldBe(0);
        EdgeTtsFrames.AudioPayload([]).Length.ShouldBe(0);
    }

    [Fact]
    public void Word_boundaries_are_converted_from_ticks_to_milliseconds()
    {
        // The service reports 100-nanosecond ticks. Skipping the divide makes highlighting run
        // ten thousand times too slow, which looks like the feature is simply broken.
        const string frame =
            "X-RequestId:abc\r\nPath:audio.metadata\r\n\r\n" +
            """
            {"Metadata":[{"Type":"WordBoundary","Data":{"Offset":1000000,"Duration":5000000,"text":{"Text":"Hello"}}}]}
            """;

        var boundaries = EdgeTtsFrames.ParseWordBoundaries(frame);

        boundaries.Count.ShouldBe(1);
        boundaries[0].Text.ShouldBe("Hello");
        boundaries[0].OffsetMs.ShouldBe(100);
        boundaries[0].DurationMs.ShouldBe(500);
    }

    [Fact]
    public void Non_word_metadata_is_ignored()
    {
        const string frame =
            "Path:audio.metadata\r\n\r\n" +
            """
            {"Metadata":[{"Type":"SentenceBoundary","Data":{"Offset":0,"Duration":10,"text":{"Text":"x"}}}]}
            """;

        EdgeTtsFrames.ParseWordBoundaries(frame).ShouldBeEmpty();
    }

    [Fact]
    public void Malformed_metadata_is_ignored_rather_than_failing_the_synthesis()
    {
        // Losing highlighting is a degradation. Losing the audio is a failure.
        EdgeTtsFrames.ParseWordBoundaries("Path:audio.metadata\r\n\r\n{not json").ShouldBeEmpty();
    }

    [Fact]
    public void Turn_end_is_recognised()
    {
        EdgeTtsFrames.IsTurnEnd("X-RequestId:abc\r\nPath:turn.end\r\n\r\n{}").ShouldBeTrue();
        EdgeTtsFrames.IsTurnEnd("Path:turn.start\r\n\r\n{}").ShouldBeFalse();
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests --filter EdgeTtsFrameTests`
Expected: FAIL to compile, `EdgeTtsFrames` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`src/BaryoDev.Umbraco.ReadAloud/Engine/EdgeTtsFrames.cs`:

```csharp
using System.Text.Json;

namespace BaryoDev.Umbraco.ReadAloud.Engine;

/// <summary>
/// Parses the frames the Edge read-aloud service sends.
/// </summary>
/// <remarks>
/// Deliberately free of any socket, so the wire format can be tested without depending on
/// Microsoft being reachable. Two shapes arrive: binary frames carrying a header then audio, and
/// text frames carrying either word timings or a turn marker.
/// </remarks>
internal static class EdgeTtsFrames
{
    /// <summary>
    /// The audio in a binary frame, which follows a 2-byte big-endian header length and the
    /// header itself.
    /// </summary>
    internal static ReadOnlySpan<byte> AudioPayload(ReadOnlySpan<byte> frame)
    {
        if (frame.Length < 2) return default;

        var headerLength = (frame[0] << 8) | frame[1];
        var start = 2 + headerLength;

        return start >= frame.Length ? default : frame[start..];
    }

    /// <summary>Word timings from a Path:audio.metadata frame, in milliseconds.</summary>
    internal static IReadOnlyList<WordBoundary> ParseWordBoundaries(string frame)
    {
        var separator = frame.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        if (separator < 0) return [];

        var boundaries = new List<WordBoundary>();

        try
        {
            using var document = JsonDocument.Parse(frame[(separator + 4)..]);

            if (!document.RootElement.TryGetProperty("Metadata", out var metadata)) return [];

            foreach (var entry in metadata.EnumerateArray())
            {
                if (!entry.TryGetProperty("Type", out var type)
                    || type.GetString() != "WordBoundary"
                    || !entry.TryGetProperty("Data", out var data))
                {
                    continue;
                }

                var text = data.TryGetProperty("text", out var textNode)
                           && textNode.TryGetProperty("Text", out var value)
                    ? value.GetString() ?? ""
                    : "";

                // The service reports 100-nanosecond ticks; everything above this works in ms.
                var offset = data.TryGetProperty("Offset", out var o) ? o.GetDouble() / 10000 : 0;
                var duration = data.TryGetProperty("Duration", out var d) ? d.GetDouble() / 10000 : 0;

                boundaries.Add(new WordBoundary(text, offset, duration));
            }
        }
        catch (JsonException)
        {
            // Losing highlighting is a degradation; losing the audio would be a failure.
            return [];
        }

        return boundaries;
    }

    internal static bool IsTurnEnd(string frame) =>
        frame.Contains("Path:turn.end", StringComparison.Ordinal);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests --filter EdgeTtsFrameTests`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "parse the edge tts wire format"
```

---

### Task 4: The Edge engine

Wires the protocol helpers and the frame parser to a real socket.

**Files:**
- Create: `src/BaryoDev.Umbraco.ReadAloud/Engine/EdgeTtsEngine.cs`
- Test: `tests/BaryoDev.Umbraco.ReadAloud.Tests/EdgeTtsEngineTests.cs`

**Interfaces:**
- Consumes: `EdgeTtsProtocol`, `EdgeTtsFrames`, `IReadAloudEngine`, `SynthesisRequest`, `SynthesisResult`
- Produces: `public sealed class EdgeTtsEngine : IReadAloudEngine` with `EdgeTtsEngine(ILogger<EdgeTtsEngine> logger)`

- [ ] **Step 1: Write the failing test**

`tests/BaryoDev.Umbraco.ReadAloud.Tests/EdgeTtsEngineTests.cs`:

```csharp
using BaryoDev.Umbraco.ReadAloud.Engine;
using Microsoft.Extensions.Logging.Abstractions;
using Shouldly;

namespace BaryoDev.Umbraco.ReadAloud.Tests;

public class EdgeTtsEngineTests
{
    private static EdgeTtsEngine Engine() => new(NullLogger<EdgeTtsEngine>.Instance);

    [Fact]
    public async Task Empty_text_is_rejected_before_a_socket_is_opened()
    {
        // Cheap guard. Opening a connection to send nothing is rude and the server just hangs.
        await Should.ThrowAsync<ArgumentException>(async () =>
            await Engine().SynthesizeAsync(new SynthesisRequest { Text = "   " }));
    }

    [Fact]
    public async Task A_cancelled_request_does_not_hang()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Should.ThrowAsync<OperationCanceledException>(async () =>
            await Engine().SynthesizeAsync(new SynthesisRequest { Text = "Hello." }, cts.Token));
    }

    [Fact(Skip = "Hits the live Microsoft endpoint. Run manually, never in CI.")]
    [Trait("Category", "Live")]
    public async Task Live_synthesis_returns_mp3_and_word_timings()
    {
        var result = await Engine().SynthesizeAsync(new SynthesisRequest
        {
            Text = "There is a listen button on this article.",
            Voice = "en-US-JennyNeural",
        });

        result.ContentType.ShouldBe("audio/mpeg");
        result.Audio.Length.ShouldBeGreaterThan(1000);
        result.Boundaries.ShouldNotBeEmpty();
        result.Boundaries[0].DurationMs.ShouldBeGreaterThan(0);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests --filter EdgeTtsEngineTests`
Expected: FAIL to compile, `EdgeTtsEngine` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`src/BaryoDev.Umbraco.ReadAloud/Engine/EdgeTtsEngine.cs`:

```csharp
using System.Net.WebSockets;
using System.Text;
using Microsoft.Extensions.Logging;

namespace BaryoDev.Umbraco.ReadAloud.Engine;

/// <summary>
/// Speaks the Edge read-aloud WebSocket protocol.
/// </summary>
/// <remarks>
/// This is server-side by necessity, not by preference. The endpoint requires an Origin naming a
/// specific Edge extension and a matching User-Agent, and browsers put both on the forbidden
/// header list precisely so a page cannot claim to be something else. A spike confirmed
/// ClientWebSocket accepts both on .NET, which is the only reason this port is possible.
///
/// The endpoint is not a supported Microsoft API. See SECURITY.md and the README.
/// </remarks>
public sealed class EdgeTtsEngine : IReadAloudEngine
{
    private readonly ILogger<EdgeTtsEngine> _logger;

    public EdgeTtsEngine(ILogger<EdgeTtsEngine> logger) => _logger = logger;

    public async Task<SynthesisResult> SynthesizeAsync(
        SynthesisRequest request,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Text))
        {
            throw new ArgumentException("Text is empty.", nameof(request));
        }

        ct.ThrowIfCancellationRequested();

        const string format = "audio-24khz-48kbitrate-mono-mp3";
        var connectionId = Guid.NewGuid().ToString("N");

        var url =
            $"{EdgeTtsProtocol.WssUrl}?TrustedClientToken={EdgeTtsProtocol.TrustedClientToken}"
            + $"&Sec-MS-GEC={EdgeTtsProtocol.SecMsGecToken(DateTimeOffset.UtcNow)}"
            + $"&Sec-MS-GEC-Version=1-{EdgeTtsProtocol.ChromiumVersion}"
            + $"&ConnectionId={connectionId}";

        using var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader("Origin", EdgeTtsProtocol.ExtensionOrigin);
        socket.Options.SetRequestHeader("User-Agent", EdgeTtsProtocol.UserAgent());

        await socket.ConnectAsync(new Uri(url), ct);

        var timestamp = DateTimeOffset.UtcNow.ToString("O");

        // Built by concatenation rather than interpolation. In an interpolated string every brace
        // in this JSON would need doubling, and getting one wrong closes the object a brace short.
        // The server then accepts the connection and simply never replies.
        var config =
            "X-Timestamp:" + timestamp + "\r\n"
            + "Content-Type:application/json; charset=utf-8\r\n"
            + "Path:speech.config\r\n\r\n"
            + "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{"
            + "\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\""
            + (request.WordBoundaries ? "true" : "false")
            + "\"},\"outputFormat\":\"" + format + "\"}}}}";

        await SendAsync(socket, config, ct);

        var ssml =
            "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>"
            + $"<voice name='{request.Voice}'>"
            + $"<prosody pitch='{request.Pitch}' rate='{request.Rate}' volume='{request.Volume}'>"
            + EdgeTtsProtocol.EscapeXml(request.Text)
            + "</prosody></voice></speak>";

        await SendAsync(socket,
            $"X-RequestId:{connectionId}\r\nX-Timestamp:{timestamp}\r\n"
            + "Content-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n" + ssml, ct);

        var audio = new MemoryStream();
        var boundaries = new List<WordBoundary>();
        var buffer = new byte[16 * 1024];

        while (socket.State == WebSocketState.Open)
        {
            var frame = new MemoryStream();
            WebSocketReceiveResult received;

            do
            {
                received = await socket.ReceiveAsync(buffer, ct);
                if (received.MessageType == WebSocketMessageType.Close) break;
                frame.Write(buffer, 0, received.Count);
            }
            while (!received.EndOfMessage);

            if (received.MessageType == WebSocketMessageType.Close) break;

            if (received.MessageType == WebSocketMessageType.Binary)
            {
                var payload = EdgeTtsFrames.AudioPayload(frame.GetBuffer().AsSpan(0, (int)frame.Length));
                if (payload.Length > 0) audio.Write(payload);
                continue;
            }

            var text = Encoding.UTF8.GetString(frame.GetBuffer(), 0, (int)frame.Length);

            if (request.WordBoundaries && text.Contains("Path:audio.metadata", StringComparison.Ordinal))
            {
                boundaries.AddRange(EdgeTtsFrames.ParseWordBoundaries(text));
            }

            if (EdgeTtsFrames.IsTurnEnd(text)) break;
        }

        if (audio.Length == 0)
        {
            throw new InvalidOperationException("The service closed the connection before sending any audio.");
        }

        return new SynthesisResult(audio.ToArray(), boundaries, "audio/mpeg");
    }

    private static Task SendAsync(ClientWebSocket socket, string message, CancellationToken ct) =>
        socket.SendAsync(Encoding.UTF8.GetBytes(message), WebSocketMessageType.Text, true, ct);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests --filter EdgeTtsEngineTests`
Expected: PASS, 2 tests, 1 skipped.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "add the edge tts engine"
```

---

### Task 5: The disk cache

**Files:**
- Create: `src/BaryoDev.Umbraco.ReadAloud/Caching/IAudioCache.cs`
- Create: `src/BaryoDev.Umbraco.ReadAloud/Caching/DiskAudioCache.cs`
- Test: `tests/BaryoDev.Umbraco.ReadAloud.Tests/DiskAudioCacheTests.cs`

**Interfaces:**
- Consumes: `SynthesisResult`, `WordBoundary`
- Produces:
  - `public interface IAudioCache { Task<SynthesisResult?> GetAsync(string key, CancellationToken ct = default); Task SetAsync(string key, SynthesisResult result, CancellationToken ct = default); }`
  - `public sealed class DiskAudioCache : IAudioCache` with `DiskAudioCache(string rootPath, ILogger<DiskAudioCache> logger)`

- [ ] **Step 1: Write the failing test**

`tests/BaryoDev.Umbraco.ReadAloud.Tests/DiskAudioCacheTests.cs`:

```csharp
using BaryoDev.Umbraco.ReadAloud.Caching;
using BaryoDev.Umbraco.ReadAloud.Engine;
using Microsoft.Extensions.Logging.Abstractions;
using Shouldly;

namespace BaryoDev.Umbraco.ReadAloud.Tests;

public class DiskAudioCacheTests : IDisposable
{
    private readonly string _root =
        Path.Combine(Path.GetTempPath(), $"readaloud-tests-{Guid.NewGuid():N}");

    private DiskAudioCache Cache() => new(_root, NullLogger<DiskAudioCache>.Instance);

    private static SynthesisResult Result() => new(
        [0xFF, 0xFB, 0x90, 0x64],
        [new WordBoundary("Hello", 100, 500)],
        "audio/mpeg");

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { /* best effort */ }
    }

    [Fact]
    public async Task A_miss_returns_null_rather_than_throwing()
    {
        (await Cache().GetAsync("A".PadLeft(64, 'A'))).ShouldBeNull();
    }

    [Fact]
    public async Task What_goes_in_comes_back_out()
    {
        var key = "B".PadLeft(64, 'B');
        var cache = Cache();

        await cache.SetAsync(key, Result());
        var found = await cache.GetAsync(key);

        found.ShouldNotBeNull();
        found.Audio.ShouldBe(Result().Audio);
        found.ContentType.ShouldBe("audio/mpeg");
        found.Boundaries.Count.ShouldBe(1);
        found.Boundaries[0].Text.ShouldBe("Hello");
        found.Boundaries[0].OffsetMs.ShouldBe(100);
    }

    [Fact]
    public async Task A_key_that_is_not_hex_is_refused()
    {
        // The key becomes a file name. Anything but hex is either a bug or a traversal attempt.
        var cache = Cache();

        await Should.ThrowAsync<ArgumentException>(async () =>
            await cache.GetAsync("../../../etc/passwd"));
        await Should.ThrowAsync<ArgumentException>(async () =>
            await cache.SetAsync("../../../etc/passwd", Result()));
    }

    [Fact]
    public async Task A_half_written_entry_is_treated_as_a_miss()
    {
        // Audio written but timings missing, which is what a crash mid-write leaves behind.
        // Serving that would give audio with no highlighting and no way to notice.
        var key = "C".PadLeft(64, 'C');
        Directory.CreateDirectory(_root);
        await File.WriteAllBytesAsync(Path.Combine(_root, $"{key}.mp3"), [1, 2, 3]);

        (await Cache().GetAsync(key)).ShouldBeNull();
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests --filter DiskAudioCacheTests`
Expected: FAIL to compile, `DiskAudioCache` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`src/BaryoDev.Umbraco.ReadAloud/Caching/IAudioCache.cs`:

```csharp
using BaryoDev.Umbraco.ReadAloud.Engine;

namespace BaryoDev.Umbraco.ReadAloud.Caching;

/// <summary>Stores synthesized audio so the same text is never paid for twice.</summary>
public interface IAudioCache
{
    Task<SynthesisResult?> GetAsync(string key, CancellationToken ct = default);

    Task SetAsync(string key, SynthesisResult result, CancellationToken ct = default);
}
```

`src/BaryoDev.Umbraco.ReadAloud/Caching/DiskAudioCache.cs`:

```csharp
using System.Text.Json;
using BaryoDev.Umbraco.ReadAloud.Engine;
using Microsoft.Extensions.Logging;

namespace BaryoDev.Umbraco.ReadAloud.Caching;

/// <summary>
/// Caches audio as a pair of files per key: the MP3 and its word timings.
/// </summary>
/// <remarks>
/// Disk rather than the database, because these are binary blobs that would bloat a backup and
/// which SQLite in particular handles poorly. Everything here is derived data: deleting the
/// folder is always safe and the next request regenerates what is needed.
/// </remarks>
public sealed class DiskAudioCache : IAudioCache
{
    private readonly string _root;
    private readonly ILogger<DiskAudioCache> _logger;

    public DiskAudioCache(string rootPath, ILogger<DiskAudioCache> logger)
    {
        _root = rootPath;
        _logger = logger;
    }

    public async Task<SynthesisResult?> GetAsync(string key, CancellationToken ct = default)
    {
        var (audioPath, timingsPath) = Paths(key);

        // Both halves or neither. A crash between the two writes leaves audio with no timings,
        // and serving that gives a reader audio with silently broken highlighting.
        if (!File.Exists(audioPath) || !File.Exists(timingsPath)) return null;

        try
        {
            var audio = await File.ReadAllBytesAsync(audioPath, ct);
            var json = await File.ReadAllTextAsync(timingsPath, ct);
            var boundaries = JsonSerializer.Deserialize<List<WordBoundary>>(json) ?? [];

            return new SynthesisResult(audio, boundaries, "audio/mpeg");
        }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            _logger.LogWarning(ex, "Discarding an unreadable read-aloud cache entry.");
            return null;
        }
    }

    public async Task SetAsync(string key, SynthesisResult result, CancellationToken ct = default)
    {
        var (audioPath, timingsPath) = Paths(key);

        Directory.CreateDirectory(_root);

        // Audio last, because Get treats a missing MP3 as a miss. Written the other way round, a
        // crash between the writes would leave a complete-looking entry with no audio.
        await File.WriteAllTextAsync(timingsPath, JsonSerializer.Serialize(result.Boundaries), ct);
        await File.WriteAllBytesAsync(audioPath, result.Audio, ct);
    }

    private (string Audio, string Timings) Paths(string key)
    {
        if (key.Length != 64 || !key.All(Uri.IsHexDigit))
        {
            throw new ArgumentException("A cache key must be 64 hex characters.", nameof(key));
        }

        return (Path.Combine(_root, $"{key}.mp3"), Path.Combine(_root, $"{key}.json"));
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests --filter DiskAudioCacheTests`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "add the disk audio cache"
```

---

### Task 6: One synthesis per key, however many readers

**Files:**
- Create: `src/BaryoDev.Umbraco.ReadAloud/Caching/CoalescingAudioSource.cs`
- Test: `tests/BaryoDev.Umbraco.ReadAloud.Tests/CoalescingAudioSourceTests.cs`

**Interfaces:**
- Consumes: `IAudioCache`, `IReadAloudEngine`, `SynthesisRequest`, `SynthesisResult`
- Produces: `public sealed class CoalescingAudioSource` with
  - `CoalescingAudioSource(IReadAloudEngine engine, IAudioCache cache, ILogger<CoalescingAudioSource> logger)`
  - `Task<SynthesisResult> GetOrCreateAsync(SynthesisRequest request, CancellationToken ct = default)`

- [ ] **Step 1: Write the failing test**

`tests/BaryoDev.Umbraco.ReadAloud.Tests/CoalescingAudioSourceTests.cs`:

```csharp
using BaryoDev.Umbraco.ReadAloud.Caching;
using BaryoDev.Umbraco.ReadAloud.Engine;
using Microsoft.Extensions.Logging.Abstractions;
using Shouldly;

namespace BaryoDev.Umbraco.ReadAloud.Tests;

public class CoalescingAudioSourceTests
{
    /// <summary>Counts calls and can be made slow or made to fail.</summary>
    private sealed class CountingEngine : IReadAloudEngine
    {
        public int Calls;
        public TimeSpan Delay = TimeSpan.Zero;
        public Exception? Throws;

        public async Task<SynthesisResult> SynthesizeAsync(SynthesisRequest request, CancellationToken ct = default)
        {
            Interlocked.Increment(ref Calls);
            if (Delay > TimeSpan.Zero) await Task.Delay(Delay, ct);
            if (Throws is not null) throw Throws;
            return new SynthesisResult([1, 2, 3], [], "audio/mpeg");
        }
    }

    private sealed class MemoryCache : IAudioCache
    {
        private readonly Dictionary<string, SynthesisResult> _entries = new();
        public int Writes;

        public Task<SynthesisResult?> GetAsync(string key, CancellationToken ct = default) =>
            Task.FromResult(_entries.GetValueOrDefault(key));

        public Task SetAsync(string key, SynthesisResult result, CancellationToken ct = default)
        {
            lock (_entries) { _entries[key] = result; Writes++; }
            return Task.CompletedTask;
        }
    }

    private static SynthesisRequest Request() => new() { Text = "Hello world." };

    [Fact]
    public async Task A_second_request_is_served_from_cache_without_synthesizing_again()
    {
        var engine = new CountingEngine();
        var source = new CoalescingAudioSource(engine, new MemoryCache(), NullLogger<CoalescingAudioSource>.Instance);

        await source.GetOrCreateAsync(Request());
        await source.GetOrCreateAsync(Request());

        engine.Calls.ShouldBe(1);
    }

    [Fact]
    public async Task Two_hundred_simultaneous_readers_cause_one_synthesis()
    {
        // The scenario this class exists for. A new article shared widely means many readers
        // press Listen at once, and without coalescing that is one WebSocket each.
        var engine = new CountingEngine { Delay = TimeSpan.FromMilliseconds(150) };
        var source = new CoalescingAudioSource(engine, new MemoryCache(), NullLogger<CoalescingAudioSource>.Instance);

        await Task.WhenAll(Enumerable.Range(0, 200).Select(_ => source.GetOrCreateAsync(Request())));

        engine.Calls.ShouldBe(1);
    }

    [Fact]
    public async Task A_failure_is_not_cached()
    {
        // Otherwise one outage poisons that article permanently.
        var cache = new MemoryCache();
        var engine = new CountingEngine { Throws = new InvalidOperationException("service down") };
        var source = new CoalescingAudioSource(engine, cache, NullLogger<CoalescingAudioSource>.Instance);

        await Should.ThrowAsync<InvalidOperationException>(async () => await source.GetOrCreateAsync(Request()));

        cache.Writes.ShouldBe(0);
    }

    [Fact]
    public async Task A_failure_does_not_block_the_next_attempt()
    {
        var engine = new CountingEngine { Throws = new InvalidOperationException("transient") };
        var source = new CoalescingAudioSource(engine, new MemoryCache(), NullLogger<CoalescingAudioSource>.Instance);

        await Should.ThrowAsync<InvalidOperationException>(async () => await source.GetOrCreateAsync(Request()));

        engine.Throws = null;
        (await source.GetOrCreateAsync(Request())).Audio.Length.ShouldBe(3);
        engine.Calls.ShouldBe(2);
    }

    [Fact]
    public async Task Different_text_does_not_share_a_lock()
    {
        var engine = new CountingEngine();
        var source = new CoalescingAudioSource(engine, new MemoryCache(), NullLogger<CoalescingAudioSource>.Instance);

        await source.GetOrCreateAsync(new SynthesisRequest { Text = "One." });
        await source.GetOrCreateAsync(new SynthesisRequest { Text = "Two." });

        engine.Calls.ShouldBe(2);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests --filter CoalescingAudioSourceTests`
Expected: FAIL to compile, `CoalescingAudioSource` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`src/BaryoDev.Umbraco.ReadAloud/Caching/CoalescingAudioSource.cs`:

```csharp
using System.Collections.Concurrent;
using BaryoDev.Umbraco.ReadAloud.Engine;
using Microsoft.Extensions.Logging;

namespace BaryoDev.Umbraco.ReadAloud.Caching;

/// <summary>
/// Returns cached audio, synthesizing it once if it is missing however many callers ask at once.
/// </summary>
/// <remarks>
/// Without this, an article shared widely means every reader who presses Listen before the first
/// synthesis finishes opens their own WebSocket to Microsoft. That is both slow for them and a
/// good way to get an unofficial endpoint closed.
/// </remarks>
public sealed class CoalescingAudioSource
{
    private readonly IReadAloudEngine _engine;
    private readonly IAudioCache _cache;
    private readonly ILogger<CoalescingAudioSource> _logger;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new();

    public CoalescingAudioSource(
        IReadAloudEngine engine,
        IAudioCache cache,
        ILogger<CoalescingAudioSource> logger)
    {
        _engine = engine;
        _cache = cache;
        _logger = logger;
    }

    public async Task<SynthesisResult> GetOrCreateAsync(
        SynthesisRequest request,
        CancellationToken ct = default)
    {
        var key = request.CacheKey();

        var cached = await _cache.GetAsync(key, ct);
        if (cached is not null) return cached;

        var gate = _locks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);

        try
        {
            // Someone may have finished while this caller waited.
            cached = await _cache.GetAsync(key, ct);
            if (cached is not null) return cached;

            var result = await _engine.SynthesizeAsync(request, ct);

            // Only a success is written. Caching a failure would poison the key permanently, and
            // the next reader would inherit an outage that had long since passed.
            await _cache.SetAsync(key, result, ct);

            return result;
        }
        finally
        {
            gate.Release();
            _locks.TryRemove(key, out _);
        }
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests --filter CoalescingAudioSourceTests`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "coalesce concurrent synthesis per cache key"
```

---

### Task 7: Options and markup stripping

**Files:**
- Create: `src/BaryoDev.Umbraco.ReadAloud/ReadAloudOptions.cs`
- Create: `src/BaryoDev.Umbraco.ReadAloud/Content/TextExtractor.cs`
- Test: `tests/BaryoDev.Umbraco.ReadAloud.Tests/TextExtractorTests.cs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `public class ReadAloudOptions { const string SectionName = "BaryoDev:ReadAloud"; bool Enabled = true; List<string> DocumentTypes; string PropertyAlias = "bodyText"; string DefaultVoice = "en-GB-SoniaNeural"; List<string> AllowedVoices; int MaxChars = 8000; string CachePath = "App_Data/BaryoDev/ReadAloud"; int RateLimitPerMinute = 20; string Provider = "Edge"; }`
  - `public static class TextExtractor { static string ToSpeakableText(string? html, int maxChars); }`

- [ ] **Step 1: Write the failing test**

`tests/BaryoDev.Umbraco.ReadAloud.Tests/TextExtractorTests.cs`:

```csharp
using BaryoDev.Umbraco.ReadAloud.Content;
using Shouldly;

namespace BaryoDev.Umbraco.ReadAloud.Tests;

public class TextExtractorTests
{
    [Fact]
    public void Tags_are_removed_and_words_keep_their_spacing()
    {
        TextExtractor.ToSpeakableText("<p>Hello <strong>world</strong>.</p>", 8000)
            .ShouldBe("Hello world.");
    }

    [Fact]
    public void Block_elements_do_not_run_words_together()
    {
        // Without a space at the boundary this reads as "onetwo", which sounds like a mistake.
        TextExtractor.ToSpeakableText("<p>One</p><p>Two</p>", 8000).ShouldBe("One Two");
    }

    [Fact]
    public void Script_and_style_content_is_never_read_aloud()
    {
        TextExtractor.ToSpeakableText(
            "<p>Hello</p><script>var x = 1;</script><style>.a{color:red}</style>", 8000)
            .ShouldBe("Hello");
    }

    [Fact]
    public void Html_entities_are_decoded()
    {
        // "&amp;" must be spoken as "and", not as "ampersand".
        TextExtractor.ToSpeakableText("<p>Tom &amp; Jerry &mdash; friends</p>", 8000)
            .ShouldContain("Tom & Jerry");
    }

    [Fact]
    public void Text_is_truncated_at_a_word_boundary()
    {
        var result = TextExtractor.ToSpeakableText("<p>alpha beta gamma delta</p>", 12);

        result.Length.ShouldBeLessThanOrEqualTo(12);
        result.ShouldNotEndWith("gam");
        result.ShouldBe("alpha beta");
    }

    [Fact]
    public void Empty_and_null_input_give_an_empty_string_rather_than_throwing()
    {
        TextExtractor.ToSpeakableText(null, 8000).ShouldBe("");
        TextExtractor.ToSpeakableText("   ", 8000).ShouldBe("");
        TextExtractor.ToSpeakableText("<p></p>", 8000).ShouldBe("");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests --filter TextExtractorTests`
Expected: FAIL to compile, `TextExtractor` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`src/BaryoDev.Umbraco.ReadAloud/Content/TextExtractor.cs`:

```csharp
using System.Net;
using System.Text.RegularExpressions;

namespace BaryoDev.Umbraco.ReadAloud.Content;

/// <summary>
/// Turns a rich text property into something worth speaking.
/// </summary>
public static partial class TextExtractor
{
    /// <summary>
    /// Strips markup, decodes entities, collapses whitespace and truncates on a word boundary.
    /// </summary>
    /// <remarks>
    /// Truncation cuts at a space rather than mid-word, because a voice reading half a word is
    /// the kind of detail that makes a whole feature feel broken.
    /// </remarks>
    public static string ToSpeakableText(string? html, int maxChars)
    {
        if (string.IsNullOrWhiteSpace(html)) return "";

        var text = ScriptAndStyle().Replace(html, " ");
        text = Tags().Replace(text, " ");
        text = WebUtility.HtmlDecode(text);
        text = Whitespace().Replace(text, " ").Trim();

        if (text.Length <= maxChars) return text;

        var cut = text.LastIndexOf(' ', Math.Min(maxChars, text.Length - 1));
        return (cut > 0 ? text[..cut] : text[..maxChars]).TrimEnd();
    }

    [GeneratedRegex(@"<(script|style)\b[^>]*>.*?</\1>",
        RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex ScriptAndStyle();

    [GeneratedRegex(@"<[^>]+>")]
    private static partial Regex Tags();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();
}
```

`src/BaryoDev.Umbraco.ReadAloud/ReadAloudOptions.cs`:

```csharp
namespace BaryoDev.Umbraco.ReadAloud;

/// <summary>
/// Everything a site can configure. Every value has a working default, so a site that configures
/// nothing still gets a working read-aloud button.
/// </summary>
public class ReadAloudOptions
{
    public const string SectionName = "BaryoDev:ReadAloud";

    public bool Enabled { get; set; } = true;

    /// <summary>Document type aliases this applies to. Empty means all of them.</summary>
    public List<string> DocumentTypes { get; set; } = [];

    /// <summary>The property read aloud, unless a page overrides it.</summary>
    public string PropertyAlias { get; set; } = "bodyText";

    public string DefaultVoice { get; set; } = "en-GB-SoniaNeural";

    /// <summary>Voices a caller may request. Empty means only DefaultVoice is allowed.</summary>
    public List<string> AllowedVoices { get; set; } = [];

    /// <summary>Caps how much text is sent in one request.</summary>
    public int MaxChars { get; set; } = 8000;

    public string CachePath { get; set; } = "App_Data/BaryoDev/ReadAloud";

    /// <summary>Requests per minute per IP, since the endpoint is anonymous.</summary>
    public int RateLimitPerMinute { get; set; } = 20;

    /// <summary>"Edge" (default, free, unsupported) or "AzureSpeech" (paid, contracted).</summary>
    public string Provider { get; set; } = "Edge";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests --filter TextExtractorTests`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "add options and markup stripping"
```

---

### Task 8: Wiring it into Umbraco

The first task that needs a real Umbraco boot, and the first that could break differently on 16, 17 and 18.

**Files:**
- Create: `src/BaryoDev.Umbraco.ReadAloud/ReadAloudComposer.cs`
- Create: `src/BaryoDev.Umbraco.ReadAloud/Controllers/ReadAloudController.cs`
- Create: `tests/TestSite/` (Umbraco host, mirroring the PWA package's test site)
- Test: `tests/BaryoDev.Umbraco.ReadAloud.Tests/UmbracoSiteFixture.cs`
- Test: `tests/BaryoDev.Umbraco.ReadAloud.Tests/EndpointTests.cs`

**Interfaces:**
- Consumes: everything from Tasks 2 to 7
- Produces:
  - `public class ReadAloudComposer : IComposer` registering `IReadAloudEngine`, `IAudioCache`, `CoalescingAudioSource` and options
  - `public class ReadAloudController : Controller` serving `GET /read-aloud/{nodeKey:guid}`
  - `UmbracoSiteFixture` with `HttpClient Client`, `T Resolve<T>()`

- [ ] **Step 1: Write the failing test**

`tests/BaryoDev.Umbraco.ReadAloud.Tests/EndpointTests.cs`:

```csharp
using System.Net;
using Shouldly;

namespace BaryoDev.Umbraco.ReadAloud.Tests;

/// <summary>
/// Boots a real Umbraco rather than mocking one, because route registration, DI and options
/// binding are only exercised by a real boot and a test double passes with all three broken.
/// </summary>
[Collection(UmbracoCollection.Name)]
public class EndpointTests
{
    private readonly UmbracoSiteFixture _site;

    public EndpointTests(UmbracoSiteFixture site) => _site = site;

    [Fact]
    public async Task The_route_is_registered_at_the_url_the_client_calls()
    {
        // A rename here breaks every site silently: the client keeps requesting and the server
        // keeps 404ing, and read-aloud just stops working with nothing in the logs.
        var response = await _site.Client.GetAsync($"/read-aloud/{Guid.NewGuid()}");

        response.StatusCode.ShouldNotBe(HttpStatusCode.NotFound,
            "the route itself must exist even when the node does not");
    }

    [Fact]
    public async Task An_unknown_node_is_not_found_rather_than_a_server_error()
    {
        var response = await _site.Client.GetAsync($"/read-aloud/{Guid.NewGuid()}");

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task A_malformed_key_does_not_reach_the_handler()
    {
        var response = await _site.Client.GetAsync("/read-aloud/not-a-guid");

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public void The_composer_registers_everything_the_controller_needs()
    {
        // Resolving proves the DI graph is complete. A missing registration otherwise appears as
        // a 500 on first use in production rather than at boot.
        _site.Resolve<BaryoDev.Umbraco.ReadAloud.Engine.IReadAloudEngine>().ShouldNotBeNull();
        _site.Resolve<BaryoDev.Umbraco.ReadAloud.Caching.IAudioCache>().ShouldNotBeNull();
        _site.Resolve<BaryoDev.Umbraco.ReadAloud.Caching.CoalescingAudioSource>().ShouldNotBeNull();
    }
}
```

`tests/BaryoDev.Umbraco.ReadAloud.Tests/UmbracoSiteFixture.cs`:

```csharp
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;

namespace BaryoDev.Umbraco.ReadAloud.Tests;

public class UmbracoSiteFixture : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly string _dataDirectory =
        Path.Combine(Path.GetTempPath(), $"readaloud-site-{Guid.NewGuid():N}");

    public HttpClient Client { get; private set; } = default!;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        Directory.CreateDirectory(_dataDirectory);
        var dbPath = Path.Combine(_dataDirectory, "Umbraco.sqlite.db");

        builder.UseSetting("ConnectionStrings:umbracoDbDSN",
            $"Data Source={dbPath};Cache=Shared;Foreign Keys=True;Pooling=True");
        builder.UseSetting("ConnectionStrings:umbracoDbDSN_ProviderName", "Microsoft.Data.Sqlite");

        builder.UseSetting("Umbraco:CMS:Unattended:InstallUnattended", "true");
        builder.UseSetting("Umbraco:CMS:Unattended:UnattendedUserName", "Test Admin");
        builder.UseSetting("Umbraco:CMS:Unattended:UnattendedUserEmail", "test@example.com");
        builder.UseSetting("Umbraco:CMS:Unattended:UnattendedUserPassword", "LocalOnly-ChangeMe-1234!");

        // Pinned rather than inherited, so these tests do not change when the demo config does.
        builder.UseSetting("BaryoDev:ReadAloud:PropertyAlias", "bodyText");
        builder.UseSetting("BaryoDev:ReadAloud:CachePath", Path.Combine(_dataDirectory, "cache"));

        builder.UseEnvironment("Development");
    }

    public async Task InitializeAsync()
    {
        Client = CreateClient();
        using var response = await Client.GetAsync("/");
        _ = response.StatusCode;
    }

    public new async Task DisposeAsync()
    {
        await base.DisposeAsync();
        try { Directory.Delete(_dataDirectory, recursive: true); } catch { /* locked file on CI */ }
    }

    public T Resolve<T>() where T : notnull => Services.GetRequiredService<T>();
}

[CollectionDefinition(Name)]
public class UmbracoCollection : ICollectionFixture<UmbracoSiteFixture>
{
    public const string Name = "umbraco";
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests --filter EndpointTests`
Expected: FAIL to compile, `Program`, `ReadAloudComposer` and `ReadAloudController` do not exist.

- [ ] **Step 3: Write the minimal implementation**

Create `tests/TestSite/` as a stock Umbraco web project referencing the package, with `public partial class Program { }` at the end of `Program.cs` so `WebApplicationFactory` can find it, and `<InternalsVisibleTo>` not required. Mirror `~/repos/BaryoDev.Umbraco.Pwa/tests/TestSite/` for the csproj shape, including the `UmbracoVersion` property and `Directory.Packages.props` at `tests/`.

`src/BaryoDev.Umbraco.ReadAloud/ReadAloudComposer.cs`:

```csharp
using BaryoDev.Umbraco.ReadAloud.Caching;
using BaryoDev.Umbraco.ReadAloud.Engine;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Umbraco.Cms.Core.Composing;
using Umbraco.Cms.Core.DependencyInjection;

namespace BaryoDev.Umbraco.ReadAloud;

public class ReadAloudComposer : IComposer
{
    public void Compose(IUmbracoBuilder builder)
    {
        builder.Services.AddOptions<ReadAloudOptions>()
            .Bind(builder.Config.GetSection(ReadAloudOptions.SectionName));

        builder.Services.AddSingleton<IReadAloudEngine, EdgeTtsEngine>();

        builder.Services.AddSingleton<IAudioCache>(sp =>
        {
            var options = sp.GetRequiredService<IOptionsMonitor<ReadAloudOptions>>().CurrentValue;
            var environment = sp.GetRequiredService<IWebHostEnvironment>();

            var root = Path.IsPathRooted(options.CachePath)
                ? options.CachePath
                : Path.Combine(environment.ContentRootPath, options.CachePath);

            return new DiskAudioCache(root, sp.GetRequiredService<ILogger<DiskAudioCache>>());
        });

        builder.Services.AddSingleton<CoalescingAudioSource>();
    }
}
```

`src/BaryoDev.Umbraco.ReadAloud/Controllers/ReadAloudController.cs`:

```csharp
using BaryoDev.Umbraco.ReadAloud.Caching;
using BaryoDev.Umbraco.ReadAloud.Content;
using BaryoDev.Umbraco.ReadAloud.Engine;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Umbraco.Cms.Core.Services;

namespace BaryoDev.Umbraco.ReadAloud.Controllers;

/// <summary>
/// Serves the audio for one published node.
/// </summary>
/// <remarks>
/// Anonymous by necessity, since every visitor's browser calls it. It accepts no text: the server
/// reads the configured property itself, which is why an arbitrary-text endpoint and its abuse
/// surface are not needed here at all.
/// </remarks>
[Route("read-aloud")]
public class ReadAloudController : Controller
{
    private readonly CoalescingAudioSource _audio;
    private readonly IPublishedContentQuery _content;
    private readonly IOptionsMonitor<ReadAloudOptions> _options;
    private readonly ILogger<ReadAloudController> _logger;

    public ReadAloudController(
        CoalescingAudioSource audio,
        IPublishedContentQuery content,
        IOptionsMonitor<ReadAloudOptions> options,
        ILogger<ReadAloudController> logger)
    {
        _audio = audio;
        _content = content;
        _options = options;
        _logger = logger;
    }

    [HttpGet("{key:guid}")]
    public async Task<IActionResult> Get(Guid key, [FromQuery] string? voice, CancellationToken ct)
    {
        var options = _options.CurrentValue;
        if (!options.Enabled) return NotFound();

        var node = _content.Content(key);
        if (node is null) return NotFound();

        var html = node.Value<string>(options.PropertyAlias);
        var text = TextExtractor.ToSpeakableText(html, options.MaxChars);
        if (string.IsNullOrEmpty(text)) return NotFound();

        var chosen = voice ?? options.DefaultVoice;
        if (options.AllowedVoices.Count > 0 && !options.AllowedVoices.Contains(chosen))
        {
            chosen = options.DefaultVoice;
        }

        try
        {
            var result = await _audio.GetOrCreateAsync(
                new SynthesisRequest { Text = text, Voice = chosen }, ct);

            Response.Headers.Append("X-ReadAloud-Boundaries",
                System.Text.Json.JsonSerializer.Serialize(result.Boundaries));

            return File(result.Audio, result.ContentType);
        }
        catch (Exception ex)
        {
            // 503 rather than 500, because the client treats it as "try browser speech instead"
            // and a reader gets a working, if worse, experience rather than a dead button.
            _logger.LogWarning(ex, "Read-aloud synthesis failed for node {Key}.", key);
            return StatusCode(503);
        }
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests --filter EndpointTests`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify it works on Umbraco 16 as well**

Run: `dotnet build src/BaryoDev.Umbraco.ReadAloud -f net9.0`
Expected: Build succeeded, no errors. `IPublishedContentQuery.Content(Guid)` must exist on all three majors; if it does not, check `Umbraco.Core.xml` for 16.5.1, 17.6.1 and 18.1.0 and choose an API present in all three.

- [ ] **Step 6: Commit**

```bash
git add src tests
git commit -m "serve audio for a published node"
```

---

### Task 9: The browser client

**Files:**
- Create: `src/BaryoDev.Umbraco.ReadAloud/wwwroot/readaloud.js`
- Create: `src/BaryoDev.Umbraco.ReadAloud/wwwroot/umbraco-package.json`
- Test: `tests/BaryoDev.Umbraco.ReadAloud.Tests/ClientAssetTests.cs`

**Interfaces:**
- Consumes: the endpoint from Task 8
- Produces: a `<read-aloud for="#selector">` custom element served at `/App_Plugins/BaryoDev.ReadAloud/readaloud.js`

- [ ] **Step 1: Write the failing test**

`tests/BaryoDev.Umbraco.ReadAloud.Tests/ClientAssetTests.cs`:

```csharp
using System.Net;
using Shouldly;

namespace BaryoDev.Umbraco.ReadAloud.Tests;

[Collection(UmbracoCollection.Name)]
public class ClientAssetTests
{
    private readonly UmbracoSiteFixture _site;

    public ClientAssetTests(UmbracoSiteFixture site) => _site = site;

    private const string ClientPath = "/App_Plugins/BaryoDev.ReadAloud/readaloud.js";

    [Fact]
    public async Task The_client_is_served_as_javascript()
    {
        // Static web assets are served from a manifest, never copied to disk, so a filesystem
        // check would pass while the asset 404s in a real site.
        var response = await _site.Client.GetAsync(ClientPath);

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        response.Content.Headers.ContentType?.MediaType.ShouldBe("text/javascript");
    }

    [Fact]
    public async Task The_client_requests_the_route_the_server_actually_serves()
    {
        // The pairing that breaks silently on a rename. Both halves must move together.
        var client = await _site.Client.GetStringAsync(ClientPath);

        client.ShouldContain("/read-aloud/");
    }

    [Fact]
    public async Task The_client_falls_back_to_browser_speech_on_503()
    {
        // The degradation path. Without it a Microsoft outage leaves a dead button on every site.
        var client = await _site.Client.GetStringAsync(ClientPath);

        client.ShouldContain("speechSynthesis");
        client.ShouldContain("503");
    }

    [Fact]
    public async Task The_element_is_registered_under_a_namespaced_tag()
    {
        var client = await _site.Client.GetStringAsync(ClientPath);

        client.ShouldContain("customElements.define");
        client.ShouldContain("read-aloud");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests --filter ClientAssetTests`
Expected: FAIL, 404 for the asset.

- [ ] **Step 3: Write the minimal implementation**

Compile the existing TypeScript client from `~/repos/read-aloud/src/client/` into a single ES module and place the output at `src/BaryoDev.Umbraco.ReadAloud/wwwroot/readaloud.js`. Adapt it so that:

- It fetches `GET /read-aloud/{nodeKey}?voice=...` rather than POSTing text.
- Word timings are read from the `X-ReadAloud-Boundaries` response header rather than a JSON body.
- On a `503` response it calls `window.speechSynthesis` instead, and sets `data-state="degraded"` on the element so the page can style or explain it.
- It registers `customElements.define("read-aloud", ...)` and reads `for`, `voice` and `node` attributes.
- If neither the endpoint nor `speechSynthesis` is available, it removes itself, because a button that cannot play is worse than no button.

Add `src/BaryoDev.Umbraco.ReadAloud/wwwroot/umbraco-package.json` declaring the package name and version so Umbraco recognises it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `dotnet test tests/BaryoDev.Umbraco.ReadAloud.Tests --filter ClientAssetTests`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "ship the browser client"
```

---

### Task 10: Repository furniture and CI

Done as one task because none of it is independently rejectable and all of it gates a first release.

**Files:**
- Create: `LICENSE`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`
- Create: `.github/workflows/ci.yml`, `.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml`, `.github/PULL_REQUEST_TEMPLATE.md`
- Create: `umbraco-marketplace.json`, `icon.png`
- Create: `.gitleaks.toml`

- [ ] **Step 1: Copy the shape from the PWA package**

Use `~/repos/BaryoDev.Umbraco.Pwa/` as the reference for every file above. Change the package-specific content, keep the structure.

- [ ] **Step 2: State the unsupported-endpoint warning in three places**

The README, `SECURITY.md` and `umbraco-marketplace.json` description must each carry it. Wording from the spec:

> This uses the same free endpoint Microsoft Edge uses for its own read-aloud feature. It is not a supported Microsoft API and could change or stop working without notice. If you need a guarantee, configure the Azure Speech provider, which is the same voices with a contract and a bill.

Alongside it, the evidence that it is not obscure: `edge-tts` on PyPI is at 14,645,228 downloads a month, `node-edge-tts` on npm at 8,603,847, and `rany2/edge-tts` has 11,727 stars with first release in May 2021.

- [ ] **Step 3: Write the CI workflow**

Mirror `~/repos/BaryoDev.Umbraco.Pwa/.github/workflows/ci.yml`, including:
- The matrix over Umbraco 16.5.1 (net9.0), 17.6.1 (net10.0) and 18.1.0 (net10.0)
- **No `-p:TargetFrameworks` override.** Passing it turns the single-target test project into a multi-targeting one, `dotnet test` then discovers nothing, and the job goes green having run zero tests
- The trx assertion that at least 30 tests ran and all passed
- The gitleaks scan over full history using the MIT binary, not the paid Action
- The pack job asserting the nuspec carries the `umbraco-marketplace` tag and a direct `Umbraco.Cms` dependency
- **Exclude the live test:** `--filter "Category!=Live"`

- [ ] **Step 4: Verify CI is green on all three majors**

Push and confirm all matrix legs pass. `Umbraco 16.5.1 (net9.0)` is the one most likely to fail, because APIs removed in 17 still exist there and vice versa.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "add repository furniture and ci"
```

---

### Task 11: The playground

**Files:**
- Create: `tests/TestSite/Dockerfile`
- Modify: `tests/TestSite/appsettings.json`

- [ ] **Step 1: Write the Dockerfile**

Mirror `~/repos/BaryoDev.Umbraco.Pwa/tests/TestSite/Dockerfile`, and **copy `tests/Directory.Packages.props` into the build context**. Without it the restore fails with `NU1015`, because the test site declares versionless `PackageReference` items.

- [ ] **Step 2: Publish content in the demo, which the PWA demo does not have**

This package reads a property off a **published** node. The PWA demo deliberately has nothing published, which is what produced its `StartUrl` bug. Create and publish one article with a `bodyText` property, so the demo has something to read.

- [ ] **Step 3: Build on the VM and deploy**

Build on the Oracle VM (`opc@140.245.103.105`) rather than locally, since it is arm64 and there is no local Docker daemon.

```bash
COPYFILE_DISABLE=1 tar czf /tmp/ra-ctx.tgz --exclude='bin' --exclude='obj' --exclude='._*' \
  src tests/TestSite tests/Directory.Packages.props README.md icon.png
```

`COPYFILE_DISABLE=1` is required. Without it macOS writes AppleDouble `._` files into the archive and the C# compiler rejects them as "a binary file instead of a text file".

Run it as its own container on its own port behind nginx, **not** on the PWA demo instance. That demo's claim is that anything working there works because of that one package.

- [ ] **Step 4: Verify end to end against the live demo**

```bash
curl -s https://<demo-host>/read-aloud/<published-node-key> -o /tmp/ra.mp3 -w "%{http_code} %{content_type}\n"
file /tmp/ra.mp3
```

Expected: `200 audio/mpeg`, and `file` reports `MPEG ADTS, layer III`. Request it twice and confirm the second is materially faster, which proves the cache.

- [ ] **Step 5: Commit**

```bash
git add tests/TestSite
git commit -m "add the demo site and its container"
```

---

## Self-Review

**Spec coverage:** v1 is **configuration only** by decision on 15 August; the per-page override is a named non-goal in the spec with its extension point identified, so no Task 12 is needed. Everything else maps: engine (1 to 4), cache (5, 6), text and options (7), Umbraco wiring (8), client and browser fallback (9), disclosure and furniture (10), playground (11). Listen counts are correctly absent, being a named non-goal.

**Placeholder scan:** Task 9 Step 3 and Task 10 Steps 1 to 3 describe work rather than showing every line. That is deliberate: they adapt existing files that live at known paths in two repos, and reproducing several hundred lines of client TypeScript and boilerplate would obscure rather than help. Every other step carries the code.

**Type consistency:** `SynthesisRequest`, `SynthesisResult`, `WordBoundary`, `IReadAloudEngine`, `IAudioCache` and `CoalescingAudioSource` are used with identical signatures in Tasks 2, 5, 6 and 8. `CacheKey()` returns 64 hex characters in Task 2 and `DiskAudioCache` validates exactly that in Task 5.

**Open risk:** Task 8 uses `IPublishedContentQuery.Content(Guid)`. Verify it exists on Umbraco 16, 17 and 18 before implementing, using the same `Umbraco.Core.xml` diff that found `IDocumentUrlService` for the PWA package. That check is written into Task 8 Step 5.
