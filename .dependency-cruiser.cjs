module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-private-guide-core-imports",
      severity: "error",
      from: { path: "^packages/(?!trellage-guide-core/)[^/]+/" },
      to: { path: "^packages/trellage-guide-core/src/(?!index\\.ts$|conversation\\.ts$)" },
    },
    {
      name: "no-private-conversation-source-imports",
      severity: "error",
      from: { path: "^packages/(?!trellage-conversation-source/)[^/]+/" },
      to: {
        path: "^packages/trellage-conversation-source/src/(?!index\\.ts$|cli\\.ts$|conversation-(?:capture|parser|policy|reader|state|validation)\\.ts$|herdr\\.ts$|source-context\\.ts$|transcripts\\.ts$|transcript-format\\.ts$|trellage-(?:root|session)\\.ts$)",
      },
    },
    {
      name: "no-private-launcher-imports",
      severity: "error",
      from: { path: "^packages/(?!trellage-launcher/)[^/]+/" },
      to: { path: "^packages/trellage-launcher/src/(?!cli\\.tsx$|run-catalog\\.ts$)" },
    },
    {
      name: "no-private-runtime-imports",
      severity: "error",
      from: { path: "^packages/(?!trellage-runtime/)[^/]+/" },
      to: {
        path: "^packages/trellage-runtime/src/(?!index\\.ts$|native-config\\.ts$|native-run/(?:index|source|paths|inventory)\\.ts$|workspace\\.ts$|skill-(?:config|update)\\.ts$)",
      },
    },
  ],
  options: {
    parser: "swc",
    tsConfig: { fileName: "tsconfig.base.json" },
  },
}
