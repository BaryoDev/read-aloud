/** One spoken word and when it is spoken, in milliseconds from the start of the audio. */
export interface WordBoundary {
  text: string;
  offset: number;
  duration: number;
}

export type ReadAloudState =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "ended"
  | "error";

/** What the controller POSTs to your endpoint (or to a custom `fetchAudio`). */
export interface FetchPayload {
  text: string;
  voice?: string;
  rate?: string;
  pitch?: string;
  volume?: string;
}

export interface FetchResult {
  /** base64 string, ArrayBuffer, or raw bytes. */
  audio: string | ArrayBuffer | Uint8Array;
  boundaries?: WordBoundary[];
  contentType?: string;
}
