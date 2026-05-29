/// <reference types="vite/client" />

import type { FlowWeaveApi } from "./types";

declare global {
  interface Window {
    flowweave?: FlowWeaveApi;
  }
}

export {};
