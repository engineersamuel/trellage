// Conversation titles: a new conversation first shows its message cut to 48 characters; a short model call then
// names what is specific to it (models.goal_page through SF_PROXY_URL). On any failure the cut text stays.
import { factoryConfig } from "./config.ts"
import { loadPrompt } from "./prompt.ts"

/** A model reply as a list title: first line, no quotes or final period, at most 48 characters; null if empty. */
export const cleanTitle = (reply: string): string | null => {
  const line = reply
    .trim()
    .split("\n")[0]!
    .trim()
    .replace(/^["'`*]+|["'`*.]+$/g, "")
    .trim()
  return line ? [...line].slice(0, 48).join("") : null
}

/** A short title for a conversation's first message, or null when the model call fails. */
export const llmTitle = async (text: string, proxyUrl: string, timeoutMs = 30_000): Promise<string | null> => {
  try {
    const r = await fetch(`${proxyUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: factoryConfig().models.goal_page,
        reasoning_effort: "low",
        messages: [{ role: "user", content: loadPrompt("threads/title", { text: text.slice(0, 4000) }) }],
      }),
    })
    if (!r.ok) return null
    const reply = (await r.json()) as { choices?: { message?: { content?: string | null } }[] }
    return cleanTitle(reply.choices?.[0]?.message?.content ?? "")
  } catch {
    return null
  }
}
