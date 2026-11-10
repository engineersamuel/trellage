// System prompts. Text lives in defaults/prompts/*.md; ~/.config/trellage/factory/prompts/<name>.md overrides one.
// Read them at use time so edits apply to the next session.
import { loadPrompt } from "./prompt.ts"

export const coordinatorPrompt = () => loadPrompt("coordinator")
export const globalPrompt = () => loadPrompt("global")
export const researchPrompt = () => loadPrompt("research")
export const deskPrompt = () => loadPrompt("desk")
export const cardsPrompt = () => loadPrompt("cards")

/** System prompt addition for a repo conversation's sub-coordinator. */
export const subPrompt = (
  folder: string,
  repo: string,
  worktree: string,
  branch: string,
  prBase?: string,
  lessons: string[] = [],
) =>
  loadPrompt("sub-coordinator", {
    folder,
    repo,
    worktree,
    branch,
    prBase: prBase ?? "",
    lessons: lessons.map((l) => `- ${l}`).join("\n"),
  })

// Tool description: stays in code with the tool's parameters.
export const SETTINGS_TOOL_DOC =
  'Change the factory UI and your own configuration with a JSON merge patch (RFC 7386). Objects merge, arrays replace (to add or remove one navbar item or disabled tool, send the full new list built from get_settings), null deletes a map entry (or clears `banner`). Every open UI updates live. Fields:\n- theme: name of a theme in `themes`.\n- themes: {name: {bg, surface, border, text, muted, accent}} hex colors. Add a new theme by adding an entry, then set `theme` to it.\n- navbar: ordered list from status, workers, model, context, auth, crons.\n- animations: bool (pulse while you work).\n- diffStyle: terminal|gutter|split|github, how chats draw file diffs.\n- inboxCritters: bool (animated critter per agent in the Inbox conversation tree and canvas, shows its status and step).\n- treeStyle: classic|tree|vine, connector lines of the Inbox conversation tree (tree = growing tree, vine = ivy vine).\n- hotkeys: {key: action}; actions toggleSettings, cycleTheme, focusCoordinator, abortCoordinator.\n- focus: agent id the Inbox shows.\n- banner: string pinned under the navbar, or null.\n- agent: {model, reasoningEffort: default|low|medium|high|xhigh, disabledTools: subset of shell|write|read|url|mcp, instructions}. Changing model/reasoningEffort switches your live session.\n- subAgent: {model, reasoningEffort} of the repo sub-coordinators (default claude-opus-5.5, high); `agent` is the desk and General chats.\n- workers: {harness: auto|copilot|claude|pi}. auto: each step decides (Copilot SDK by default); copilot, claude or pi forces that agent SDK for every worker (finish workers stay on Copilot).\n- supervisor: {enabled, everySeconds >= 30, stallSeconds >= 60, offTrackCheck}: periodic worker check; issues come to you as a [supervisor] prompt.\n- repo: absolute path of the target git repository, or "" for none. Changing it starts a new run worktree on the next worker.\n- crons: {name: {everySeconds >= 30, prompt, enabled}}; each fires the prompt to you on schedule while you are idle.\n- extensions: {name: {slot, js, css, enabled, description}}. Arbitrary UI code, mounted live in the UI. Use this for anything the fixed fields cannot express (animations, canvases, widgets, custom styling, clocks, effects). slot is one of chat-background (full-size layer behind the chat), page-background (behind everything), navbar (inline item in the top bar), banner (strip under the navbar), overlay (fixed full-screen layer, pointer-events none). js is the BODY of `function (el, api) { ... }`: el is an empty div you own inside the slot (background slots are already position:absolute; inset:0; z-index:0); return a cleanup function that stops timers/animation frames/listeners. api = {settings, palette (current theme colors), workers, onSettings(cb), onWorkers(cb)} (onX returns an unsubscribe). css is global; scope selectors under [data-ext="<name>"] or the stable hooks .sf-chat (chat column), .sf-nav. To let a background show through the chat, make the chat surfaces transparent in css, e.g. `.sf-chat .openui-agent-container, .sf-chat .openui-agent-thread-container { background: transparent !important; }`. After any extension change, call extension_errors and fix what it reports. Never claim you cannot change the UI: write an extension.\nExample: {"theme": "nord", "navbar": ["status", "context"], "crons": {"digest": null}}'
