import type { ReadAloud } from "./read-aloud.js";

/**
 * Trigger a browser download of the reader's current audio. The reader must have loaded
 * (call `preload()` or `play()` first). Returns false if there's nothing to download.
 *
 *   await reader.preload();
 *   downloadRecording(reader, "chapter-1.mp3");
 */
export function downloadRecording(reader: ReadAloud, filename = "read-aloud.mp3"): boolean {
  const url = reader.objectUrl;
  if (!url || typeof document === "undefined") return false;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
}
