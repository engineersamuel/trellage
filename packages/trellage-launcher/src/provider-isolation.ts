import { appendFileSync } from "node:fs"

/** Only explicit offline test configuration disables production clients. */
export const assertLiveProviderAllowed = (provider: string): void => {
  if (process.env.TRELLAGE_TEST_OFFLINE !== "1") return
  const message = `Unmocked ${provider} provider in offline tests; inject a deterministic client`
  const error = new Error(message)
  const receipt = process.env.TRELLAGE_TEST_VIOLATIONS
  if (receipt !== undefined) appendFileSync(receipt, `${error.stack ?? message}\n`)
  throw error
}
