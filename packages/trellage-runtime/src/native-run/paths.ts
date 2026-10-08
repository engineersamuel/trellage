import os from "node:os"
import path from "node:path"

export type NativeRunErrorCode =
  | "usage"
  | "config"
  | "unknown-profile"
  | "source-unavailable"
  | "skill-not-found"
  | "conflict"
  | "isolation"
  | "unsupported"
  | "unsafe-path"
  | "launch"

export class NativeRunError extends Error {
  readonly code: NativeRunErrorCode
  constructor(code: NativeRunErrorCode, message: string) {
    super(message)
    this.name = "NativeRunError"
    this.code = code
  }
}

export interface NativeRunPaths {
  readonly cache: string
  readonly data: string
  readonly state: string
}

export interface NativeRunPathOptions {
  readonly environment?: NodeJS.ProcessEnv
  readonly home?: string | undefined
}

const absoluteOr = (value: string | undefined, fallback: string): string =>
  value !== undefined && path.isAbsolute(value) ? value : fallback

export const resolveNativeRunPaths = (options: NativeRunPathOptions = {}): NativeRunPaths => {
  const environment = options.environment ?? process.env
  const home = options.home ?? os.homedir()
  return {
    cache: path.join(absoluteOr(environment.XDG_CACHE_HOME, path.join(home, ".cache")), "trellage", "native-run"),
    data: path.join(absoluteOr(environment.XDG_DATA_HOME, path.join(home, ".local", "share")), "trellage", "native-run"),
    state: path.join(
      absoluteOr(environment.XDG_STATE_HOME, path.join(home, ".local", "state")),
      "trellage",
      "native-run",
    ),
  }
}
