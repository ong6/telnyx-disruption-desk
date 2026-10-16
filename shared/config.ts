// Flags and the active scenario live in the Config actor (desk-mcp owns it; every function binds
// it as CONFIG). They were in KV, and a KV outage took scenario loads, flag flips and the
// webhook's flags down with it (DEBUGLOG #27). Each process keeps them in memory for 3 s, so a
// flag flipped on the console reaches new calls within a few seconds, with no redeploy.
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
const TTL_MS = 3_000;
let cache: { at: number; flags: Flags; scenario: Scenario | null } | null = null;

const config = (env: any) => env.CONFIG.idFromName("global");

export async function readConfig(env: any, force = false): Promise<{ flags: Flags; scenario: Scenario | null }> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache;
  const c = await config(env).get();
  cache = { at: Date.now(), flags: { ...DEFAULTS, ...(c?.flags ?? {}) } as Flags, scenario: c?.scenario ?? null };
  return cache;
}

/**
 * For hot paths: never wait more than `budgetMs`. Serves the last value this process saw (even
 * if stale) and refreshes it in the background; returns null on a cold process whose first read
 * is slower than the budget, or fails. Never throws.
 */
let refreshing: Promise<unknown> | null = null;
export async function readConfigFast(env: any, budgetMs: number): Promise<{ flags: Flags; scenario: Scenario | null } | null> {
  const fresh = cache && Date.now() - cache.at < TTL_MS;
  if (fresh) return cache;
  // A failed refresh must never reject: with a cache, nothing awaits it, and an unhandled
  // rejection took the process (and a hold_seats in flight) down once (DEBUGLOG #23).
  const load = (refreshing ??= readConfig(env, true)
    .catch((e) => console.error(JSON.stringify({ ts: new Date().toISOString(), svc: "config", lvl: "error", ev: "config_refresh_failed", err: String(e?.message ?? e).slice(0, 160) })))
    .finally(() => (refreshing = null)));
  if (cache) return cache; // stale-while-revalidate
  return Promise.race([load.then(() => cache), new Promise<null>((r) => setTimeout(() => r(null), budgetMs))]);
}

export async function writeFlags(env: any, patch: Partial<Flags>): Promise<Flags> {
  const next = { ...DEFAULTS, ...(await config(env).setFlags(patch)) } as Flags;
  cache = null;
  return next;
}

export async function writeScenario(env: any, scenario: Scenario): Promise<void> {
  await config(env).setScenario(scenario);
  cache = null;
}

/** Deploy settings: `assistants` (ids whose default variables mirror the flags), `outbound`. */
export const readSetting = async <T>(env: any, key: string): Promise<T | null> => (await config(env).setting(key)) as T | null;

export const resetConfigCache = () => {
  cache = null;
};
