import path from "node:path"
import { readTrellageConfig, type NativeCatalog, type TrellageConfigLocation } from "../native-config.ts"

export interface EffectiveRunConfig {
  readonly catalog: NativeCatalog
  readonly shipped: NativeCatalog
  readonly configPath: string
  readonly shippedRoot: string
  readonly seeded: boolean
}

/** Mirrors launch initialization in memory; never creates or repairs configuration. */
export const loadEffectiveRunConfig = async (
  options: TrellageConfigLocation & { readonly shippedConfigPath: string },
): Promise<EffectiveRunConfig> => {
  const environment = options.environment ?? process.env
  const loaded = await readTrellageConfig({ ...options, environment })
  const shipped = (
    await readTrellageConfig({
      ...options,
      environment: { ...environment, TRELLAGE_CONFIG: options.shippedConfigPath },
    })
  ).config.native
  const seeded = !environment.TRELLAGE_CONFIG && !loaded.nativeDeclared
  return {
    catalog: seeded ? shipped : loaded.config.native,
    shipped,
    configPath: seeded ? options.shippedConfigPath : loaded.path,
    shippedRoot: path.dirname(options.shippedConfigPath),
    seeded,
  }
}
