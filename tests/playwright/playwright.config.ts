import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

function harnessProjects(): NonNullable<PlaywrightTestConfig["projects"]> {
  const matrix = process.env.HARNESS_BASE_URLS;
  if (matrix === undefined || matrix.trim() === "") {
    return [
      {
        name: "default",
        use: {
          baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173",
        },
      },
    ];
  }

  const seenIds = new Set<string>();
  return matrix.split(",").map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(`invalid HARNESS_BASE_URLS entry: ${entry}`);
    }

    const id = entry.slice(0, separator);
    const target = entry.slice(separator + 1);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error(`invalid HARNESS_BASE_URLS contestant id: ${id}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`duplicate HARNESS_BASE_URLS contestant id: ${id}`);
    }
    seenIds.add(id);

    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new Error(`invalid HARNESS_BASE_URLS target: ${target}`);
    }
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.port === "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error(`HARNESS_BASE_URLS target must use http://127.0.0.1:<port>: ${target}`);
    }

    return {
      name: id,
      use: {
        baseURL: url.origin,
      },
    };
  });
}

function acceptanceSpec(): string {
  const spec = process.env.HARNESS_ACCEPTANCE_SPEC ?? "todo.spec.ts";
  if (!/^[a-z0-9][a-z0-9-]*\.spec\.ts$/.test(spec)) {
    throw new Error(`invalid HARNESS_ACCEPTANCE_SPEC: ${spec}`);
  }
  return spec;
}

export default defineConfig({
  testDir: ".",
  testMatch: acceptanceSpec(),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  projects: harnessProjects(),
  use: {
    trace: "retain-on-failure",
  },
});
