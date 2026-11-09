// Option 2: Foldkit + @plana-solutions/agent-interface.
// The host is a Foldkit (TEA + Effect) app. It embeds the agent-interface chat, the worker panel and the
// settings drawer as Submodels, and feeds them from Subscriptions on the coordinator's raw feed.
import "./secureContextPolyfill";
import "@plana-solutions/agent-interface/styles.layered.css";
import "./page.css";
import "./openUiParity.css";
import "./reportViewer/reportViewer.css";
import "./openUiCard";
import "./diffHighlight";
import { Option } from "effect";
import { Runtime } from "foldkit";
import {
  ChatBackend,
  FlagsSchema,
  NO_ARTIFACTS,
  ThemeSetting,
  memoryNavigation,
  readFlags,
} from "@plana-solutions/agent-interface";
import type { AgentConfig } from "@plana-solutions/agent-interface";
import { startDecisionCenter } from "../../shared/decisions";
import { startFolderSidebar } from "../../shared/folders";
import { startPrototypes } from "../../shared/protos";
import { BACKEND_URLS } from "./backend";
import { changedUrl, requestedUrl } from "./chat";
import { Model } from "./model";
import { onSlow } from "./slowWarnings";
import { subscriptions } from "./subscription";
import { init, update } from "./update";
import { view } from "./view";

const config: AgentConfig = {
  agentName: "General chat",
  artifacts: NO_ARTIFACTS,
  componentLibrary: "openuiChat",
  maybeStarterVariant: Option.none(),
  maybeWelcome: Option.none(),
  navigation: memoryNavigation,
  placeholder: "Type a new request here…",
  starters: [
    { displayText: "Status board", prompt: "Show me a status board of all current workers." },
    {
      displayText: "Parallel workers",
      prompt:
        "Spawn two workers: 'namer' proposes 3 names for a CLI todo app and 'pitcher' writes a one-line pitch. Wait for both, show the results, then stop both.",
    },
  ],
  theme: ThemeSetting.Fixed({ mode: "dark" }),
};

const maybeThreadFromUrl = Option.fromNullishOr(new URL(window.location.href).searchParams.get("thread"));

const application = Runtime.makeApplication({
  Flags: FlagsSchema,
  Model,
  container: document.querySelector("#root")!,
  init: (flags, url) => init(flags, url, maybeThreadFromUrl),
  resources: ChatBackend.layer(BACKEND_URLS),
  routing: {
    onUrlChange: changedUrl,
    onUrlRequest: requestedUrl,
  },
  slow: { onSlow },
  subscriptions,
  update,
  view,
});

Runtime.run(application, { flags: readFlags(config) });
startDecisionCenter();
startFolderSidebar();
startPrototypes();
