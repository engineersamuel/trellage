import path from "node:path"
import {
  FIRSTMATE_MAX_REQUEST_BYTES,
  FIRSTMATE_MAX_RESPONSE_BYTES,
  ProfileGuideValidationError,
  canonicalFirstmateJson,
  firstmateSubmissionDigest,
  parseFirstmateReceiptRequestV1,
  parseFirstmateSubmissionReceiptV1,
  parseFirstmateSubmissionRequestV1,
  sameFirstmateFleet,
  type FirstmateSubmissionReceiptV1,
  type FirstmateSubmissionRequestV1,
} from "@trellage/guide-core"
import {
  CommandRunnerError,
  parseSelectedProfile,
  type CommandRunner,
  type NativeSelectedProfile,
} from "./guide-launch.ts"
import {
  firstmateInstanceControlArgs, firstmateInstanceSelectorArgs, selectedFirstmateInstance,
} from "./guide-firstmate-instance-selection.ts"

export type FirstmateSubmissionOutcome =
  | {
      readonly status: "accepted"
      readonly receipt: FirstmateSubmissionReceiptV1
      readonly message: string
    }
  | {
      readonly status: "not-found"
      readonly receipt: FirstmateSubmissionReceiptV1
      readonly message: string
    }
  | {
      readonly status: "rejected" | "unknown"
      readonly receipt?: FirstmateSubmissionReceiptV1
      readonly message: string
    }

const unknown = (message: string): FirstmateSubmissionOutcome => ({ status: "unknown", message })
const rejected = (message: string): FirstmateSubmissionOutcome => ({ status: "rejected", message })
const noReceipt = "Firstmate returned no valid receipt. Check the receipt with the same request ID; do not submit again."
const outputTooLarge = "Firstmate output exceeded its byte limit. Check the receipt with the same request ID."

const supervisorStatusText: Readonly<Record<FirstmateSubmissionReceiptV1["supervisorState"] | "unknown", string>> = {
  running: "supervisor running",
  stopped: "waiting for supervisor start",
  stale: "waiting for supervisor recovery",
  unsafe: "supervisor unsafe; operator review required",
  unknown: "supervisor status unknown; inspect the owned fleet",
}

export const firstmateSupervisorStatusText = (state: FirstmateSubmissionReceiptV1["supervisorState"] | "unknown"): string =>
  supervisorStatusText[state]

const canonicalReceiptBytes = (receipt: FirstmateSubmissionReceiptV1): number => {
  // Sorting does not change size. The shared canonical serializer is typed for requests only.
  const json = JSON.stringify(receipt)
  return json.length + (json.match(/[\u007f-\uffff]/g)?.length ?? 0) * 5
}

const acceptedMessage = (receipt: FirstmateSubmissionReceiptV1): string => {
  const accepted = `Firstmate accepted the request. Receipt snapshot: ${firstmateSupervisorStatusText(receipt.supervisorState)}. ` +
    "This does not confirm dispatch or task completion."
  if (receipt.announcement === "failed") {
    return `${accepted} The supervisor announcement failed: ${receipt.error!.message}`
  }
  if (receipt.announcement === "pending") return `${accepted} The supervisor announcement is pending.`
  if (receipt.announcement === "sent") return `${accepted} The wake was accepted or queued.`
  return accepted
}

/** Classify only shared-schema receipts bound to this exact request. Also used when reading the journal. */
export const firstmateOutcomeFromReceipt = (
  request: FirstmateSubmissionRequestV1,
  value: unknown,
): FirstmateSubmissionOutcome => {
  let receipt: FirstmateSubmissionReceiptV1
  try {
    receipt = parseFirstmateSubmissionReceiptV1(value)
  } catch (cause) {
    if (!(cause instanceof ProfileGuideValidationError)) throw cause
    return unknown(noReceipt)
  }
  if (canonicalReceiptBytes(receipt) > FIRSTMATE_MAX_RESPONSE_BYTES) return unknown(outputTooLarge)
  if (receipt.requestId !== request.requestId) {
    return unknown("Firstmate receipt request ID does not match. Acceptance is unknown; the receipt was refused.")
  }
  if (receipt.fleet !== null && !sameFirstmateFleet(receipt.fleet, request.expectedFleet)) {
    return unknown("Firstmate receipt fleet identity does not match. Acceptance is unknown; the receipt was refused.")
  }
  if (receipt.digest !== null && receipt.digest !== firstmateSubmissionDigest(request)) {
    return unknown("Firstmate receipt digest does not match the original request. Acceptance is unknown; the receipt was refused.")
  }
  if (receipt.state === "saved" || receipt.state === "handled") {
    return { status: "accepted", receipt, message: acceptedMessage(receipt) }
  }
  if (receipt.state === "rejected") {
    return { status: "rejected", receipt, message: `Firstmate rejected the request: ${receipt.error!.message}` }
  }
  if (receipt.fleet === null) return unknown("Firstmate did not identify the fleet for its receipt lookup.")
  return {
    status: "not-found",
    receipt,
    message: "Firstmate has no receipt for this request ID. This does not authorize another submission.",
  }
}

const outputOutcome = (
  request: FirstmateSubmissionRequestV1,
  stdout: string,
  stderr: string,
): FirstmateSubmissionOutcome => {
  if (
    Buffer.byteLength(stdout, "utf8") > FIRSTMATE_MAX_RESPONSE_BYTES ||
    Buffer.byteLength(stderr, "utf8") > FIRSTMATE_MAX_RESPONSE_BYTES
  ) {
    return unknown(outputTooLarge)
  }
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause
    return unknown(noReceipt)
  }
  return firstmateOutcomeFromReceipt(request, value)
}

/**
 * Transport only. Persist and begin the journal entry before submit.
 * Unknown results require an explicit receipt(originalRequest); neither method replays submit.
 */
export class FirstmateSubmissionClient {
  private readonly executable: string
  private readonly profileName: string
  private readonly sourceRevision: string
  private readonly maximumRequestBytes: number
  private readonly profile: NativeSelectedProfile

  constructor(
    private readonly runner: CommandRunner,
    profile: NativeSelectedProfile,
    private readonly cwd: string,
  ) {
    const selected = parseSelectedProfile(profile)
    if (selected.surface !== "native" || selected.launcher !== "fmx" || selected.orchestration === undefined) {
      throw new Error("Firstmate submission requires a native fmx profile with static orchestration.")
    }
    if (!path.isAbsolute(cwd) || /[\u0000-\u001f\u007f-\u009f]/u.test(cwd)) {
      throw new Error("Firstmate submission requires an absolute working directory without control characters.")
    }
    this.executable = selected.commandPath
    this.profile = selected
    this.profileName = selected.profile
    this.sourceRevision = selected.orchestration.sourceRevision
    this.maximumRequestBytes = Math.min(FIRSTMATE_MAX_REQUEST_BYTES, selected.orchestration.submission.maxRequestBytes)
  }

  submit(request: FirstmateSubmissionRequestV1, signal?: AbortSignal): Promise<FirstmateSubmissionOutcome> {
    return this.invoke("submit", request, signal).then((outcome) => outcome.status === "not-found"
      ? unknown("Submission returned lookup-only not-found evidence. Acceptance remains unknown; check the receipt with the same request ID.")
      : outcome)
  }

  receipt(request: FirstmateSubmissionRequestV1, signal?: AbortSignal): Promise<FirstmateSubmissionOutcome> {
    return this.invoke("receipt", request, signal).then((outcome) => outcome.status === "rejected"
      ? unknown(`Receipt lookup was refused. Original acceptance remains unknown. ${outcome.message}`)
      : outcome)
  }

  private async invoke(
    operation: "submit" | "receipt",
    original: FirstmateSubmissionRequestV1,
    signal?: AbortSignal,
  ): Promise<FirstmateSubmissionOutcome> {
    let request: FirstmateSubmissionRequestV1
    let stdin: string
    let args: ReadonlyArray<string>
    try {
      request = parseFirstmateSubmissionRequestV1(original)
      const serialized = canonicalFirstmateJson(request)
      if (serialized !== canonicalFirstmateJson(original)) {
        return rejected("Firstmate request fields must be valid without normalization. Nothing was sent.")
      }
      if (
        request.expectedFleet.profile !== this.profileName ||
        request.expectedFleet.sourceRevision !== this.sourceRevision
      ) {
        return rejected("Firstmate request fleet does not match the selected profile and source revision. Nothing was sent.")
      }
      selectedFirstmateInstance(this.profile, request.expectedFleet)
      args = [operation, this.profileName, "--json", ...(operation === "submit"
        ? firstmateInstanceControlArgs(this.profile) : firstmateInstanceSelectorArgs(this.profile))]
      stdin = operation === "submit"
        ? serialized
        : canonicalFirstmateJson(parseFirstmateReceiptRequestV1({
            schemaVersion: 1,
            requestId: request.requestId,
            expectedFleet: request.expectedFleet,
          }))
      if (Buffer.byteLength(stdin, "utf8") > this.maximumRequestBytes) {
        return rejected("Firstmate request exceeds the profile's canonical byte limit. Nothing was sent.")
      }
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause
      return rejected(cause instanceof ProfileGuideValidationError
        ? "Firstmate request is invalid or exceeds its byte limit. Nothing was sent."
        : `${cause.message} Nothing was sent.`)
    }
    return this.transport(request, stdin, args, signal)
  }

  private async transport(
    request: FirstmateSubmissionRequestV1,
    stdin: string,
    args: ReadonlyArray<string>,
    signal?: AbortSignal,
  ): Promise<FirstmateSubmissionOutcome> {
    const controller = new AbortController()
    const commandSignal = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    const outputBytes = { stdout: 0, stderr: 0 }
    let overflow = false
    try {
      const result = await this.runner.run(this.executable, args, {
        cwd: this.cwd,
        stdin,
        signal: commandSignal,
        timeoutMs: 30_000,
        outputOverflow: "terminate",
        onOutput: (text, stream) => {
          if (overflow) return
          outputBytes[stream] += Buffer.byteLength(text, "utf8")
          if (outputBytes[stream] > FIRSTMATE_MAX_RESPONSE_BYTES) {
            overflow = true
            controller.abort()
          }
        },
      })
      return overflow ? unknown(outputTooLarge) : outputOutcome(request, result.stdout, result.stderr)
    } catch (error) {
      if (overflow || (error instanceof CommandRunnerError && error.kind === "output-limit")) {
        return unknown(outputTooLarge)
      }
      if (error instanceof CommandRunnerError) {
        const outcome = outputOutcome(request, error.stdout, error.stderr)
        return outcome.status === "not-found"
          ? unknown("Firstmate command did not complete successfully. Its response does not prove absence. Check the receipt with the same request ID.")
          : outcome
      }
      throw new Error("Firstmate command failed without structured output. Check the same request ID before further action.", { cause: error })
    }
  }
}
