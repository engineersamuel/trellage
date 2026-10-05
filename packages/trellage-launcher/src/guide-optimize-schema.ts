import type { RestrictedGuideModelRequest } from "./copilot-guide-provider.ts"

type ResponseFormat = NonNullable<RestrictedGuideModelRequest["responseFormat"]>
type Schema = ResponseFormat["jsonSchema"]["schema"]

const object = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
})

const string = (maxLength?: number): Schema => ({
  type: "string",
  minLength: 1,
  ...(maxLength === undefined ? {} : { maxLength }),
})

const array = (items: Schema, minItems: number, maxItems: number): Schema => ({
  type: "array",
  items,
  minItems,
  maxItems,
})

const citations = array(
  object({
    source: string(),
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
  }),
  1,
  3,
)

const replies = (
  dispositions: ReadonlyArray<string>,
  reasonLength: number,
  requiredFindingIds: ReadonlyArray<string>,
): Schema =>
  array(
    object({
      findingId: {
        type: "string",
        minLength: 1,
        maxLength: 100,
        ...(requiredFindingIds.length === 0 ? {} : { enum: [...requiredFindingIds] }),
      },
      disposition: { type: "string", enum: [...dispositions] },
      reason: string(reasonLength),
      citations,
    }),
    requiredFindingIds.length,
    requiredFindingIds.length,
  )

const format = (name: string, schema: Schema): ResponseFormat => ({
  type: "json_schema",
  jsonSchema: { name, strict: true, schema },
})

export const optimizeResponseFormats = {
  report: format(
    "optimize_report",
    object({
      summary: string(800),
      limitations: array(string(400), 0, 6),
      findings: array(
        object({
          title: string(160),
          proposal: string(800),
          benefit: string(400),
          risk: string(600),
          verification: string(600),
          paths: array(string(4096), 1, 16),
          citations,
        }),
        0,
        4,
      ),
    }),
  ),
  challenge: (requiredFindingIds: ReadonlyArray<string>) =>
    format(
      "optimize_challenge",
      object({
        responses: replies(["support", "reject", "uncertain"], 600, requiredFindingIds),
      }),
    ),
  verdict: (requiredFindingIds: ReadonlyArray<string>) =>
    format(
      "optimize_verdict",
      object({
        summary: string(1600),
        decisions: replies(["recommended", "rejected", "unresolved"], 800, requiredFindingIds),
      }),
    ),
} as const
