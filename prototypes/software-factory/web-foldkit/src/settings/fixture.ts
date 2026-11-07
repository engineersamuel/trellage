// A loaded settings document for tests.
import type { SettingsDocument } from "../domain";

export const document: SettingsDocument = {
  settings: {
    theme: "dark",
    themes: {
      dark: { bg: "#000", surface: "#111", border: "#222", text: "#eee", muted: "#999", accent: "#66f" },
      nord: { bg: "#2e3440", surface: "#3b4252", border: "#4c566a", text: "#eceff4", muted: "#d8dee9", accent: "#88c0d0" },
    },
    layout: { panel: "right", panelWidth: 40 },
    navbar: ["status"],
    animations: true,
    diffStyle: "terminal",
    hotkeys: { ",": "toggleSettings", t: "cycleTheme" },
    focus: "coordinator",
    banner: null,
    agent: { model: "gpt", reasoningEffort: "low", disabledTools: [], instructions: "" },
    subAgent: { model: "opus", reasoningEffort: "high" },
    workers: { harness: "auto" },
    crons: {},
    extensions: {},
    repo: "",
  },
  css: ":root{}",
  options: { navbarItems: ["status", "repo"], panelPositions: ["left", "right", "hidden"], efforts: ["low"], toolKinds: ["shell"], models: ["gpt"] },
};
