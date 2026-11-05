import "./spec.css"
// Worker spec dialog, shared by both UIs: what a worker was started with and what its runtime loaded.
// Data comes from GET /api/workers/<id>/spec.

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

type Spec = {
  id: string; name: string; role: string; model: string; auth: string; owner: string; home: string; step: string | null
  worktree: { path: string | null; repository: string | null; branch: string | null; base: string | null; head: string | null; folder: string | null; conversation: { id: string; title: string } | null }
  skills: { name: string; dir: string | null; healed: boolean; loaded: boolean }[]
  loadedSkills: { name: string; source: string; enabled: boolean; requested: boolean; path: string | null }[]
  mcpServers: { name: string; status: string; source: string | null }[]
  plugins: string[]; customTools: string[]; skillDirectories: string[]; extraPath: string[]
  systemPrompt: string | null; sessionId: string | null
}

const copyBtn = (text: string) => {
  const b = el("button", "sfs-copy", "Copy")
  b.title = text
  b.onclick = () => void navigator.clipboard?.writeText(text).then(() => ((b.textContent = "Copied"), setTimeout(() => (b.textContent = "Copy"), 1200)))
  return b
}

const row = (label: string, value: string | null, copy = false) => {
  const r = el("div", "sfs-row")
  const v = el("span", "sfs-val", value ?? "—")
  r.append(el("span", "sfs-key", label), v)
  if (copy && value) r.append(copyBtn(value))
  return r
}

const section = (title: string, ...body: HTMLElement[]) => {
  const s = el("section", "sfs-sec")
  s.append(el("h3", "", title), ...body)
  return s
}

const empty = (text: string) => el("p", "sfs-muted", text)

const short = (sha: string | null) => (sha ? sha.slice(0, 8) : null)

export const renderSpec = (s: Spec): HTMLElement => {
  const out = el("div", "sfs-body")
  const wt = s.worktree
  out.append(
    section(
      "Worktree",
      row("Repository", wt.repository ?? wt.folder),
      row("Branch", wt.branch, true),
      row("Based on", short(wt.base)),
      row("HEAD at start", short(wt.head)),
      row("Path", wt.path, true),
      row("Conversation", wt.conversation?.title ?? null),
    ),
    section("Agent", row("Role", s.role), row("Step", s.step), row("Model", `${s.model} · ${s.auth}`), row("Owner", s.owner), row("Session", s.sessionId), row("Home", s.home, true)),
  )
  const req = s.skills.length
    ? s.skills.map((k) => {
        const r = el("div", `sfs-skill ${k.loaded ? "ok" : "bad"}`)
        r.append(el("span", "sfs-mark", k.loaded ? "✓" : "✗"), el("b", "", k.name), el("span", "sfs-muted", `${k.loaded ? "loaded" : "NOT loaded"}${k.healed ? " · healed copy" : ""}`))
        if (k.dir) r.title = k.dir
        return r
      })
    : [empty("This step names no skills.")]
  out.append(section("Skills the step requires", ...req))
  const others = s.loadedSkills.filter((k) => !k.requested)
  const det = el("details", "sfs-more")
  det.append(el("summary", "", `${s.loadedSkills.length} skills the runtime loaded (${others.length} not requested)`))
  for (const k of s.loadedSkills) {
    const r = el("div", "sfs-skill")
    r.append(el("span", "sfs-mark", k.enabled ? "•" : "○"), el("span", "", k.name), el("span", "sfs-muted", k.source))
    if (k.path) r.title = k.path
    det.append(r)
  }
  out.append(section("Loaded skills", s.loadedSkills.length ? det : empty("The runtime has not reported its skills yet.")))
  out.append(
    section("MCP servers", ...(s.mcpServers.length ? s.mcpServers.map((m) => row(m.name, `${m.status}${m.source ? ` · ${m.source}` : ""}`)) : [empty("None.")])),
    section("Plugins", ...(s.plugins.length ? s.plugins.map((p) => row("", p)) : [empty("None.")])),
    section("Custom tools", s.customTools.length ? el("p", "sfs-mono", s.customTools.join(", ")) : empty("None.")),
    section("Environment", row("Skill folders", s.skillDirectories.join("\n") || null), row("Extra PATH", s.extraPath.join("\n") || null), row("System prompt", s.systemPrompt)),
  )
  return out
}

/** Open the spec dialog for one worker. Esc or the backdrop closes it. */
export const openSpec = (id: string): void => {
  document.querySelector(".sfs-backdrop")?.remove()
  const back = el("div", "sfs-backdrop")
  const box = el("div", "sfs-modal")
  box.setAttribute("role", "dialog")
  box.setAttribute("aria-label", "Worker spec")
  const head = el("header", "sfs-head")
  const close = el("button", "sfs-x", "✕")
  close.setAttribute("aria-label", "Close")
  head.append(el("b", "", `⚙ Spec · ${id}`), close)
  const body = el("div", "sfs-body")
  body.append(empty("Loading…"))
  box.append(head, body)
  back.append(box)
  const done = () => (back.remove(), window.removeEventListener("keydown", onKey, true))
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), done())
  close.onclick = done
  // A handler that returns false cancels the click, so this must not return the comparison.
  back.onclick = (e) => {
    if (e.target === back) done()
  }
  window.addEventListener("keydown", onKey, true)
  document.body.append(back)
  fetch(`/api/workers/${encodeURIComponent(id)}/spec`)
    .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(await r.text()))))
    .then((s: Spec) => {
      head.firstChild!.textContent = `⚙ Spec · ${s.name}`
      body.replaceWith(renderSpec(s))
    })
    .catch((e) => body.replaceChildren(el("p", "sfs-error", String(e?.message ?? e))))
}
