import { CopilotClient, type CopilotClientOptions } from "@github/copilot-sdk"
import { TypeSafeClient } from "@typesafe-ai/sdk"
import { assertLiveProviderAllowed } from "./provider-isolation.ts"

export const createLiveCopilotClient = (options: CopilotClientOptions): CopilotClient => {
  assertLiveProviderAllowed("Copilot")
  return new CopilotClient(options)
}

export const createLiveTypeSafeClient = (
  options: ConstructorParameters<typeof TypeSafeClient>[0],
): TypeSafeClient => {
  assertLiveProviderAllowed("TypeSafe")
  return new TypeSafeClient(options)
}
