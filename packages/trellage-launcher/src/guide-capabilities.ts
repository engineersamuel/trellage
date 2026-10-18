import type { CompositionCatalog } from "./composition-catalog.ts"
import type { CommandRunner } from "./guide-launch.ts"

/** Composition catalog capabilities are resolved by the shared run catalog loader. */
export const resolveGuideCapabilities = async (
  catalog: CompositionCatalog,
  _runner: CommandRunner,
  _cwd: string,
  signal?: AbortSignal,
): Promise<CompositionCatalog> => {
  signal?.throwIfAborted()
  return catalog
}
