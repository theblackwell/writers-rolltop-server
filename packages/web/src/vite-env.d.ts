/// <reference types="vite/client" />

declare global {
  interface Window {
    /** A test knob, read only in a dev or test build: how often the studio asks the server for changes, in milliseconds. Not set in normal use. */
    __ROLLTOP_POLL_MS__?: number;
  }
}
export {};
