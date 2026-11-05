// Extension host shared by both UIs. Plain DOM, no framework.
// The UI renders empty slot containers ([data-slot="<name>"]); this module owns
// everything inside them, so React/Foldkit never patch extension DOM.

export type Extension = { slot: string; js: string; css: string; enabled: boolean; description?: string };
type Api = {
  settings: unknown;
  palette: Record<string, string>;
  workers: unknown[];
  onSettings: (cb: (s: any) => void) => () => void;
  onWorkers: (cb: (w: any[]) => void) => () => void;
};
type Mounted = { key: string; el: HTMLElement; style: HTMLStyleElement; cleanup?: () => void };

const mounted = new Map<string, Mounted>();
const settingsSubs = new Set<(s: any) => void>();
const workerSubs = new Set<(w: any[]) => void>();
let current: any = null;
let workers: unknown[] = [];
let ui = "unknown";
/** Slot elements a host registered with attachSlot. Hosts that do not register are found by query. */
const slots = new Map<string, HTMLElement>();

const report = (extension: string, error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`[extension ${extension}]`, error);
  fetch("/api/extension-errors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ extension, ui, error: message }),
  }).catch(() => {});
};

const unmount = (name: string) => {
  const m = mounted.get(name);
  if (!m) return;
  try {
    m.cleanup?.();
  } catch (e) {
    report(name, e);
  }
  m.el.remove();
  m.style.remove();
  mounted.delete(name);
};

const guard = (name: string, f: (...a: any[]) => unknown) => (...a: any[]) => {
  try {
    return f(...a);
  } catch (e) {
    report(name, e);
  }
};

const mount = (name: string, x: Extension) => {
  const host = slots.get(x.slot) ?? document.querySelector<HTMLElement>(`[data-slot="${x.slot}"]`);
  if (!host) return; // slot not rendered (yet): retried on the next sync
  const el = document.createElement("div");
  el.dataset.ext = name;
  if (x.slot.endsWith("background") || x.slot === "overlay") el.style.cssText = "position:absolute;inset:0;overflow:hidden;";
  host.appendChild(el);
  const style = document.createElement("style");
  style.dataset.ext = name;
  style.textContent = x.css;
  document.head.appendChild(style);
  const m: Mounted = { key: x.slot + "\u0000" + x.js + "\u0000" + x.css, el, style };
  mounted.set(name, m);
  const subs: Array<() => void> = [];
  const api: Api = {
    settings: current,
    palette: current?.themes?.[current?.theme] ?? {},
    workers,
    onSettings: (cb) => {
      const g = guard(name, cb);
      settingsSubs.add(g);
      const off = () => settingsSubs.delete(g);
      subs.push(off);
      return off;
    },
    onWorkers: (cb) => {
      const g = guard(name, cb);
      workerSubs.add(g);
      const off = () => workerSubs.delete(g);
      subs.push(off);
      return off;
    },
  };
  // Catch async errors from this extension (timers, rAF) as well as sync ones.
  const wrap = <T extends (...a: any[]) => any>(f: T) => ((cb: any, ...rest: any[]) => f(typeof cb === "function" ? guard(name, cb) : cb, ...rest)) as T;
  try {
    const fn = new Function("el", "api", "setTimeout", "setInterval", "requestAnimationFrame", `"use strict";\n${x.js}\n//# sourceURL=extension:${name}.js`);
    const cleanup = fn(el, api, wrap(window.setTimeout.bind(window)), wrap(window.setInterval.bind(window)), wrap(window.requestAnimationFrame.bind(window)));
    m.cleanup = () => {
      subs.forEach((off) => off());
      if (typeof cleanup === "function") cleanup();
    };
  } catch (e) {
    m.cleanup = () => subs.forEach((off) => off());
    report(name, e);
  }
};

/** Reconcile mounted extensions with settings. Call after every render. */
export function syncExtensions(settings: any, uiName: string) {
  ui = uiName;
  if (settings !== current) {
    current = settings;
    settingsSubs.forEach((cb) => cb(settings));
  }
  const want: Record<string, Extension> = Object.fromEntries(
    Object.entries<Extension>(settings?.extensions ?? {}).filter(([, x]) => x.enabled),
  );
  for (const name of [...mounted.keys()]) {
    const x = want[name];
    const m = mounted.get(name)!;
    // Remount when code changed or the slot element was replaced by a re-render.
    if (!x || m.key !== x.slot + "\u0000" + x.js + "\u0000" + x.css || !m.el.isConnected) unmount(name);
  }
  for (const [name, x] of Object.entries(want)) if (!mounted.has(name)) mount(name, x);
}

export function setExtensionWorkers(w: unknown[]) {
  workers = w;
  workerSubs.forEach((cb) => cb(w));
}

/** Register slot element `el` and mount the extensions that target it. Call the returned function when `el` leaves the page. */
export function attachSlot(name: string, el: HTMLElement): () => void {
  slots.set(name, el);
  syncExtensions(current, ui);
  return () => {
    if (slots.get(name) === el) slots.delete(name);
    // The element leaves the page after this call: reconcile once it is gone.
    queueMicrotask(() => syncExtensions(current, ui));
  };
}
