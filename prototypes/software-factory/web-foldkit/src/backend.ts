import type { Schema } from "effect";
import { agUiWire, identityMessageFormat } from "@plana-solutions/agent-interface";
import { markdownAsOpenUi } from "./command";

/** The chat backend. The coordinator answers in OpenUI Lang for this frontend, rendered natively by agent-interface. */
export const BACKEND_URLS = {
  artifacts: "/api/artifacts",
  chat: "/api/agui?answer=openui",
  threads: "/api/threads",
  storageFormat: { ...identityMessageFormat, fromApi: (data: Schema.Json, seed: string) => markdownAsOpenUi(identityMessageFormat.fromApi(data, seed)) },
  wire: agUiWire,
};
