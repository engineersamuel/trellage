// Client for the guided goal page: the coordinator's /api/goal-page/* routes (coordinator/src/goalPage.ts).
// Every call is real: models.goal_page through SF_PROXY_URL, and the factory's decision engine (Jev).
;(() => {
  const API = "/api/goal-page"
  // One shared controller: abortAll() cancels every call in flight (e.g. on Reset or a new discover).
  let ctl = new AbortController()
  const post = async (path, body) => {
    const r = await fetch(API + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
    if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`)
    return data
  }

  /** POST that streams server-sent events: onEvent(type, data) for progress; resolves with the `done` payload. */
  const stream = async (path, body, onEvent = () => {}) => {
    const r = await fetch(API + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const type = /^event: (.*)$/m.exec(chunk)?.[1]
        const raw = /^data: (.*)$/m.exec(chunk)?.[1]
        if (!type || raw === undefined) continue
        const data = JSON.parse(raw)
        if (type === "done") return data
        if (type === "error") throw new Error(data.error)
        onEvent(type, data)
      }
    }
    throw new Error("stream ended without a result")
  }

  /** Doc as the server wants it: plain arrays of strings. */
  const cleanDoc = (d) => ({
    title: String(d.title ?? ""),
    id: String(d.id ?? ""),
    task: String(d.task ?? ""),
    inputs: [...(d.inputs ?? [])].map(String),
    constraints: [...(d.constraints ?? [])].map(String),
    criteria: [...(d.criteria ?? [])].map(String),
    checks: [...(d.checks ?? [])].map(String),
  })

  /** Expectations (as returned by expectations(), after the human's flips) → GoalSpec `expect`. */
  const toExpect = (e) => ({
    steps: Object.fromEntries(
      e.steps.filter((s) => s.on).map((s) => [s.id, s.max == null ? { min: s.min } : { min: s.min, max: s.max }]),
    ),
    skills: [],
    pr: {
      state: e.pr.state ?? "OPEN",
      ...(e.pr.checks ? { checks: e.pr.checks } : {}),
      bodyIncludes: [...(e.pr.bodyIncludes ?? [])],
      untouched: [...(e.pr.untouched ?? [])],
    },
    sdlc: {
      criteriaProven: true,
      gatesRun: e.gates.filter((g) => g.run).map((g) => g.id),
      gatesSkipped: e.gates.filter((g) => !g.run).map((g) => g.id),
      maxTier: e.tier.value,
    },
  })

  window.GoalLive = {
    /** Cancel every call in flight; their promises reject with an AbortError (err.name === "AbortError"). */
    abortAll: () => {
      ctl.abort()
      ctl = new AbortController()
    },
    info: () => fetch(API + "/info").then((r) => r.json()),
    repos: () => fetch(API + "/repos").then((r) => r.json()),
    discover: (repo, seed, onEvent) => stream("/discover", { repo, seed }, onEvent),
    patch: (doc, question, answer) => post("/patch", { doc: cleanDoc(doc), question, answer }),
    suggest: (doc, facts) => post("/suggest", { doc: cleanDoc(doc), facts: facts ?? [] }),
    enhance: (doc) => post("/enhance", { doc: cleanDoc(doc) }),
    inspiration: (repo, doc) => post("/inspiration", { repo, doc: cleanDoc(doc) }),
    research: (action, repo, doc, onEvent) => stream("/research", { action, repo, doc: cleanDoc(doc) }, onEvent),
    expectations: (doc) => post("/expectations", { doc: cleanDoc(doc) }),
    readiness: (doc, notes = true) => post("/readiness", { doc: cleanDoc(doc), notes }),
    launch: ({ repo, base, doc, expectations, override, research }) =>
      post("/launch", {
        repo,
        base,
        doc: cleanDoc(doc),
        expect: toExpect(expectations),
        approvals: expectations.approvals,
        limits: expectations.limits,
        override: override || null,
        research: research || null,
      }),
    /** history: [{role:"user"|"assistant", content}] — the newest user turn last. → {reply} */
    ask: (doc, question, options, history) => post("/ask", { doc: cleanDoc(doc), question, options, history }),
    /** → {fixes:[{title, why, section, op:"add"|"replace"|"remove", index|null, text}]} */
    refine: (doc, dim, note) => post("/refine", { doc: cleanDoc(doc), dim, note }),
    /** Jev what-if. items: [{id, label, doc}] (doc = with that change applied) → {base:[{dim,p}], items:[{id, worth, scores, delta[]}]} */
    impact: (doc, items) =>
      post("/impact", {
        doc: cleanDoc(doc),
        items: items.map((i) => ({ id: i.id, label: i.label, doc: cleanDoc(i.doc) })),
      }),
    /** Jev: is deep research needed, is the scope stable, how deep. → {need:{p,threshold,yes}, stable:{...}, depth:{value,p,probabilities}, available} */
    deepDecide: (doc) => post("/deep/decide", { doc: cleanDoc(doc) }),
    /** Starts a real hve-core rpi-research factory worker (a draft in the Inbox). → {threadId, workerId, worktree, reportPath} */
    deepStart: (repo, doc, depth) => post("/deep/start", { repo, doc: cleanDoc(doc), depth }),
    /** Poll every ~5 s. → {state:"running"|"mapping"|"done"|"failed", elapsed, ..., result?:{summary, readiness, artifactPath, findings[], decisions[]}} */
    deepStatus: (threadId, doc) => post("/deep/status", { threadId, doc: cleanDoc(doc) }),
    deepCancel: (threadId) => post("/deep/cancel", { threadId }),
    toExpect,
    cleanDoc,
  }
})()
