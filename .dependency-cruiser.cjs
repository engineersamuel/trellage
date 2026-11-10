const fs = require("node:fs")
const path = require("node:path")

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const packages = fs.readdirSync("packages").filter((name) => fs.existsSync(`packages/${name}/package.json`))
const publicSources = packages.flatMap((name) => {
  const manifest = JSON.parse(fs.readFileSync(`packages/${name}/package.json`, "utf8"))
  return Object.values(manifest.exports ?? {})
    .filter((entry) => typeof entry === "string")
    .map((entry) => escape(path.posix.join("packages", name, entry)))
})

module.exports = {
  forbidden: [
    { name: "no-cycles", severity: "error", from: { path: "^packages/" }, to: { circular: true } },
    { name: "no-unresolved-imports", severity: "error", from: { path: "^packages/" }, to: { couldNotResolve: true } },
    ...packages.map((name) => ({
      name: `public-exports-of-${name}`,
      severity: "error",
      comment: "Cross-package imports must resolve to a declared public export.",
      from: { pathNot: `^packages/${escape(name)}/` },
      to: {
        path: `^packages/${escape(name)}/src/`,
        pathNot: `^(?:${publicSources.join("|")})$`,
      },
    })),
  ],
  options: {
    parser: "swc",
    doNotFollow: { path: "node_modules" },
    exclude: "(^|/)(node_modules|coverage|dist)/",
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "types", "default"] },
  },
}
