import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { acquireProfileGuard, profileGuardProfiles, type ProfileGuard } from "./lifecycle-guard.ts";
import {
  lifecycleRuntime,
  lifecycleRuntimeCommand,
  profileOperationArguments,
  type LifecycleRuntime,
} from "./lifecycle-runtime.ts";
import { ensureFxProvider } from "./adapters.ts";
import { main as runNative } from "./run.ts";
import { inventoryCodexGoalFeatures, inventoryComposition } from "./inventory.ts";

type CancellationSignal = "SIGTERM" | "SIGINT" | "SIGHUP";

interface ChildSignalLifecycle {
  readonly setChild: (child: ChildProcess) => void;
  readonly signal: (signal: NodeJS.Signals) => void;
  readonly cancellation: () => CancellationSignal | undefined;
  readonly install: () => void;
  readonly remove: () => void;
}

interface LifecycleExecutionContext {
  readonly operation: string;
  readonly harness: string;
  readonly runtime: LifecycleRuntime;
  readonly command: string;
  readonly argv: ReadonlyArray<string>;
  readonly guard: ProfileGuard;
  readonly grouped: boolean;
  readonly json: boolean;
}

interface ChildRunState {
  guardError: unknown;
  output: string;
}

interface JsonOutput {
  launcher?: string;
  harness?: string;
  profiles?: Array<{ name: string }>;
  profile?: unknown;
}

const cancellationSignals: readonly CancellationSignal[] = ["SIGTERM", "SIGINT", "SIGHUP"];

const fxVersion = () =>
  spawnSync(process.env.TRELLAGE_FX_BIN ?? "fx", ["--version"], { encoding: "utf8" });

const runFxSetup = async (operation: string): Promise<number> => {
  await ensureFxProvider(process.env);
  const result = fxVersion();
  if (result.status !== 0) throw new Error("Fx is not installed or cannot be executed");
  process.stdout.write(`trx ${operation} fx: ready (${result.stdout.trim()})\n`);
  return 0;
};

const runFxDoctor = async (): Promise<number> => {
  await ensureFxProvider(process.env);
  const result = fxVersion();
  if (result.status !== 0) throw new Error("Fx is not installed or cannot be executed");
  process.stdout.write(`trx doctor fx: OK (${result.stdout.trim()}, shared host ~/.fx)\n`);
  return 0;
};

const runFxHarnessVersion = async (): Promise<number> => {
  const result = fxVersion();
  const installed =
    result.status === 0
      ? (result.stdout.trim().match(/[0-9]+\.[0-9]+\.[0-9]+/)?.[0] ?? null)
      : null;
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      launcher: "fx",
      harness: "fx",
      installed,
      latest: null,
      latestKnown: false,
    }),
  );
  return 0;
};


const runFxSkills = async (): Promise<number> => {
  process.stdout.write("default: Fx uses host ~/.fx skills; no Trellage-managed skill state\n");
  return 0;
};

const runFxUpgrade = async (args: ReadonlyArray<string>): Promise<number> => {
  if (args.includes("--skills-only")) return runFxSkills();
  throw new Error(
    "Fx upgrades are managed by its installed package manager; replace the fx binary, then run trx doctor fx default",
  );
};

const runFxList = async (): Promise<number> => {
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      launcher: "fx",
      harness: "fx",
      profiles: [
        { name: "default", description: "Fx with shared host context through copilot-proxy-rs" },
      ],
    }),
  );
  return 0;
};

type FxOperation = (args: ReadonlyArray<string>) => Promise<number>;

const fxOperations: Readonly<Record<string, FxOperation>> = {
  setup: () => runFxSetup("setup"),
  repair: () => runFxSetup("repair"),
  doctor: runFxDoctor,
  "harness-version": runFxHarnessVersion,
  "skills-update": runFxSkills,
  "skills-check": runFxSkills,
  upgrade: runFxUpgrade,
  list: runFxList,
};

const runFxOperation = async (operation: string, args: ReadonlyArray<string>): Promise<number> => {
  const profile = args.find((argument) => !argument.startsWith("-")) ?? "default";
  if (profile !== "default") throw new Error(`unknown Fx profile: ${profile}`);
  const handler = fxOperations[operation];
  if (!handler) throw new Error(`Fx does not support lifecycle operation ${operation}`);
  return handler(args);
};

const assertMaintenanceSupported = (
  harness: string,
  command: string,
  argv: ReadonlyArray<string>,
): void => {
  const verb = argv[0];
  if (verb !== "harness-update" && verb !== "skills-update") return;
  const help = spawnSync(command, ["--help"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const text = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
  if (help.status !== 0 || !new RegExp(`\\b${verb}\\b`).test(text))
    throw new Error(
      `${harness} does not support ${verb}. Refresh the installed Trellage runtime first.`,
    );
};

const createChildSignalLifecycle = (
  grouped: boolean,
  guard: ProfileGuard,
): ChildSignalLifecycle => {
  let child: ChildProcess | undefined;
  let cancelledBy: CancellationSignal | undefined;
  const signal = (requested: NodeJS.Signals): void => {
    if (child?.pid === undefined) return;
    if (!grouped) {
      guard.signalTree(child.pid, requested);
      return;
    }
    try {
      process.kill(-child.pid, requested);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const forwards = cancellationSignals.map((requested) => () => {
    cancelledBy ??= requested;
    signal(requested);
  });
  return {
    setChild: (value) => {
      child = value;
    },
    signal,
    cancellation: () => cancelledBy,
    install: () =>
      cancellationSignals.forEach((requested, index) => process.on(requested, forwards[index]!)),
    remove: () =>
      cancellationSignals.forEach((requested, index) => process.off(requested, forwards[index]!)),
  };
};

const spawnLifecycleChild = (
  context: LifecycleExecutionContext,
  capture: boolean,
  lifecycle: ChildSignalLifecycle,
  reject: (reason?: unknown) => void,
): ChildProcess | undefined => {
  try {
    const child = spawn(context.command, context.argv, {
      stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
      detached: context.grouped,
    });
    lifecycle.setChild(child);
    return child;
  } catch (error) {
    lifecycle.remove();
    reject(error);
    return undefined;
  }
};

const translatePresetName = (harness: string, runtime: LifecycleRuntime, name: string): string =>
  profileGuardProfiles("run", harness, []).find(
    (profile) => runtime.profileName(profile) === name,
  ) ?? name;

const nativePublicProfile = (harness: string, runtimeProfile: string): string => {
  const runtime = lifecycleRuntime(harness);
  if (!runtime) return runtimeProfile;
  return translatePresetName(harness, runtime, runtimeProfile);
};

const emitJsonOutput = (harness: string, runtime: LifecycleRuntime, output: string): void => {
  try {
    const value = JSON.parse(output) as JsonOutput;
    if (value.launcher === runtime.runtimeName) value.launcher = harness;
    if (value.harness === "oh-my-pi") value.harness = "omp";
    if (Array.isArray(value.profiles))
      for (const profile of value.profiles)
        profile.name = nativePublicProfile(harness, profile.name);
    if (typeof value.profile === "string")
      value.profile = nativePublicProfile(harness, value.profile);
    console.log(JSON.stringify(value));
  } catch {
    process.stdout.write(output);
  }
};

const emitCapturedOutput = (context: LifecycleExecutionContext, output: string): void => {
  if (!output) return;
  if (context.operation === "list" && !context.json) {
    const translated = output
      .split("\n")
      .map((line) => {
        const fields = line.split("\t");
        if (fields[0] !== undefined) fields[0] = nativePublicProfile(context.harness, fields[0]);
        return fields.join("\t");
      })
      .join("\n");
    process.stdout.write(translated);
    return;
  }
  if (context.json) emitJsonOutput(context.harness, context.runtime, output);
};

const calculateExitStatus = (
  cancelledBy: CancellationSignal | undefined,
  code: number | null,
  signal: NodeJS.Signals | null,
): number => {
  if (cancelledBy === undefined && code !== null) return code;
  const termination = cancelledBy ?? signal;
  if (termination === "SIGTERM") return 143;
  if (termination === "SIGINT") return 130;
  if (termination === "SIGHUP") return 129;
  return 1;
};

const handleChildSpawn = (
  context: LifecycleExecutionContext,
  lifecycle: ChildSignalLifecycle,
  state: ChildRunState,
  child: ChildProcess,
): void => {
  try {
    if (child.pid !== undefined) context.guard.attachChild(child.pid, context.grouped);
  } catch (error) {
    state.guardError = error;
    lifecycle.signal("SIGTERM");
    return;
  }
  const cancellation = lifecycle.cancellation();
  if (cancellation !== undefined) lifecycle.signal(cancellation);
};

const handleChildClose = (
  context: LifecycleExecutionContext,
  lifecycle: ChildSignalLifecycle,
  state: ChildRunState,
  code: number | null,
  signal: NodeJS.Signals | null,
  resolve: (value: number | PromiseLike<number>) => void,
  reject: (reason?: unknown) => void,
): void => {
  lifecycle.remove();
  if (state.guardError !== undefined) {
    reject(state.guardError);
    return;
  }
  emitCapturedOutput(context, state.output);
  resolve(calculateExitStatus(lifecycle.cancellation(), code, signal));
};

const runLifecycleProcess = (context: LifecycleExecutionContext): Promise<number> => {
  const capture = context.json || context.operation === "list";
  const lifecycle = createChildSignalLifecycle(context.grouped, context.guard);
  const state: ChildRunState = { guardError: undefined, output: "" };
  return new Promise<number>((resolve, reject) => {
    lifecycle.install();
    const child = spawnLifecycleChild(context, capture, lifecycle, reject);
    if (!child) return;
    child.once("spawn", () => handleChildSpawn(context, lifecycle, state, child));
    child.stdout?.on("data", (chunk) => {
      state.output += String(chunk);
    });
    child.once("error", (error) => {
      lifecycle.remove();
      reject(error);
    });
    child.once("close", (code, signal) =>
      handleChildClose(context, lifecycle, state, code, signal, resolve, reject),
    );
  });
};

const runCompositionInventory = async (
  harness: string,
  args: ReadonlyArray<string>,
): Promise<number> => {
  if (!args.includes("--json")) throw new Error("inventory requires HARNESS [PROFILE...] --json");
  const unsupported = args.filter(
    (argument) => argument.startsWith("-") && argument !== "--json" && argument !== "--no-always",
  );
  if (unsupported.length > 0) throw new Error(`unknown inventory option: ${unsupported[0]}`);
  const profiles = args.filter((argument) => !argument.startsWith("-"));
  const inventory = await inventoryComposition({
    harness,
    profiles,
    noAlways: args.includes("--no-always"),
  });
  console.log(JSON.stringify(inventory));
  return 0;
};

const runCodexGoalFeatures = async (args: ReadonlyArray<string>): Promise<number> => {
  if (!args.includes("--goal-features")) throw new Error("inventory codex requires PROFILE --goal-features");
  const unsupported = args.filter(
    (argument) => argument.startsWith("-") && argument !== "--goal-features" && argument !== "--no-always",
  );
  if (unsupported.length > 0) throw new Error(`unknown inventory option: ${unsupported[0]}`);
  const profiles = args.filter((argument) => !argument.startsWith("-"));
  if (profiles.length === 0) throw new Error("inventory codex requires PROFILE --goal-features");
  const result = await inventoryCodexGoalFeatures({
    harness: "codex",
    profiles,
    noAlways: args.includes("--no-always"),
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.timedOut) throw new Error("codex features list timed out");
  return result.status ?? 1;
};

const externallyManagedHarnesses = new Set(["codex", "grok", "headlong", "pi", "uji"]);

const externalManagementError = (harness: string, args: ReadonlyArray<string>): Error => {
  const profile = args.find((argument) => !argument.startsWith("-")) ?? "PROFILE";
  return new Error(
    `${harness} is installed and updated outside Trellage; use trx inventory ${harness} ${profile} --json`,
  );
};

export const runProfileOperation = async (
  operation: string,
  harness: string,
  args: ReadonlyArray<string>,
): Promise<number> => {
  if (operation === "inventory") {
    if (harness === "codex" && args.includes("--goal-features")) return runCodexGoalFeatures(args);
    return runCompositionInventory(harness, args);
  }
  if (operation === "run") throw new Error("profile lifecycle cannot launch agents; use trx run");
  if (harness === "fx") return runFxOperation(operation, args);
  const runtime = lifecycleRuntime(harness);
  if (!runtime && externallyManagedHarnesses.has(harness)) throw externalManagementError(harness, args);
  if (!runtime) throw new Error(`unknown managed profile harness: ${harness}`);
  const command = lifecycleRuntimeCommand(runtime);
  const argv = profileOperationArguments(operation, harness, args);
  if (operation === "skill" && harness === "jcode") {
    const prompt = spawnSync(command, argv, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    if (prompt.status !== 0)
      throw new Error(prompt.stderr.trim() || "JCode manual skill preparation failed");
    return runNative(["jcode", "default", "--", "run", "--", prompt.stdout.trimEnd()]);
  }
  if (argv.includes("--dry-run")) {
    console.log(
      JSON.stringify(
        { harness, command, args: argv.filter((argument) => argument !== "--dry-run") },
        null,
        2,
      ),
    );
    return 0;
  }
  assertMaintenanceSupported(harness, command, argv);
  const guardedProfiles = profileGuardProfiles(operation, harness, args);
  const guard = acquireProfileGuard(harness, guardedProfiles, operation);
  const context: LifecycleExecutionContext = {
    operation,
    harness,
    runtime,
    command,
    argv,
    guard,
    grouped: guardedProfiles.length > 0,
    json:
      args.includes("--json") ||
      args.includes("--goal-features") ||
      operation === "workflow-check" ||
      operation === "harness-version",
  };
  try {
    return await runLifecycleProcess(context);
  } finally {
    guard.release();
  }
};

if (import.meta.main) {
  const [operation, harness, ...args] = process.argv.slice(2);
  try {
    if (!operation || !harness) throw new Error("expected OPERATION HARNESS [PROFILE] [ARGS...]");
    process.exitCode = await runProfileOperation(operation, harness, args);
  } catch (error) {
    console.error(`trx: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
