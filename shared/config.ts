// Flags and the active scenario live in KV: read on every call, written rarely by one
// operator, so last-write-wins and a little staleness are fine. A KV read costs over a second
// from a function, so each process keeps them in memory for 10 s: a flag flipped on the console
// reaches new calls within about 10 seconds, with no redeploy.
export interface Flags {
  disruption_mode: "on" | "off";
  human_queue: "open" | "full";
  hold_ttl_secs: number;
  /** Web/chat calls carry no phone number; treat them as the demo caller so testers see the identified path. */
  web_calls_as_demo_caller: "on" | "off";
  /** On a demo line a transfer would ring a real number mid-demo; end_call says the handoff line and hangs up. */
  handoff: "transfer" | "end_call";
  fault: "off" | "mcp_down";
}
export interface Scenario {
  id: string; // "normal" | "typhoon"
  baseDate: string; // YYYY-MM-DD the seed's day 0 maps to
  notice: string;
  cancelled: string[]; // flight ids
  loadedAt: number;
}

const DEFAULTS: Flags = { disruption_mode: "off", human_queue: "open", hold_ttl_secs: 600, web_calls_as_demo_caller: "off", handoff: "transfer", fault: "off" };
let cache: { at: number; flags: Flags; scenario: Scenario | null } | null = null;

export async function readConfig(env: any, force = false): Promise<{ flags: Flags; scenario: Scenario | null }> {
  if (!force && cache && Date.now() - cache.at < 10_000) return cache;
  const [raw, sc] = await Promise.all([env.KV.get("flags/all"), env.KV.get("scenario/active")]);
  const flags = { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) } as Flags;
  const scenario = sc ? (JSON.parse(sc) as Scenario) : null;
  cache = { at: Date.now(), flags, scenario };
  return cache;
}

/**
 * For the webhook's hot path: never wait more than `budgetMs` for KV. Serves the last value
 * this process saw (even if stale) and refreshes it in the background; returns null on a cold
 * process whose first KV read is slower than the budget, or fails. Never throws.
 */
let refreshing: Promise<unknown> | null = null;
export async function readConfigFast(env: any, budgetMs: number): Promise<{ flags: Flags; scenario: Scenario | null } | null> {
  const fresh = cache && Date.now() - cache.at < 10_000;
  if (fresh) return cache;
  // A failed refresh must never reject: with a cache, nothing awaits it, and an unhandled
  // rejection took the process (and a hold_seats in flight) down during a KV outage (DEBUGLOG #23).
  const load = (refreshing ??= readConfig(env, true)
    .catch((e) => console.error(JSON.stringify({ ts: new Date().toISOString(), svc: "config", lvl: "error", ev: "kv_refresh_failed", err: String(e?.message ?? e).slice(0, 160) })))
    .finally(() => (refreshing = null)));
  if (cache) return cache; // stale-while-revalidate
  return Promise.race([load.then(() => cache), new Promise<null>((r) => setTimeout(() => r(null), budgetMs))]);
}

export async function writeFlags(env: any, patch: Partial<Flags>): Promise<Flags> {
  const { flags } = await readConfig(env);
  const next = { ...flags, ...patch };
  await env.KV.put("flags/all", JSON.stringify(next));
  cache = null;
  return next;
}

export const resetConfigCache = () => {
  cache = null;
};
