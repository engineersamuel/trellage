// Typed HTTP for Commands. Every failure (network, non-2xx status, wrong payload) is a typed
// string reason, so a Command turns it into a Failed* Message instead of crashing the app.
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { Http } from "foldkit";

const toReason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A non-2xx response fails with the server's text, or the status when the body is empty. */
const requireOk = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : response.text.pipe(Effect.flatMap((text) => Effect.fail(new Error(text || `HTTP ${response.status}`))));

/** GET `url` and decode its JSON body with `schema`. */
export const getJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
  url: string,
  schema: S,
): Effect.Effect<S["Type"], string> =>
  HttpClient.get(url).pipe(
    Effect.flatMap(requireOk),
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(toReason),
    Effect.provide(Http.layer),
  );

/** Send a request whose response body is not needed. `body` is sent as JSON. */
export const send = (method: "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Effect.Effect<void, string> => {
  const request = HttpClientRequest.make(method)(url);
  return HttpClient.execute(body === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, body)).pipe(
    Effect.flatMap(requireOk),
    Effect.asVoid,
    Effect.mapError(toReason),
    Effect.provide(Http.layer),
  );
};
