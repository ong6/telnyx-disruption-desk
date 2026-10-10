// Flags and the active scenario live in KV: read on every call, written rarely by one
// operator, so last-write-wins and a second of staleness are fine. Cached in memory for 5 s.
export interface Flags {
  disruption_mode: "on" | "off";
  human_queue: "open" | "full";
  hold_ttl_secs: number;
  /** Web/chat calls carry no phone number; treat them as the demo caller so testers see the identified path. */
  web_calls_as_demo_caller: "on" | "off";
}
export interface Scenario {
  id: string; // "normal" | "typhoon"
  baseDate: string; // YYYY-MM-DD the seed's day 0 maps to
  notice: string;
  cancelled: string[]; // flight ids
  loadedAt: number;
}

const DEFAULTS: Flags = { disruption_mode: "off", human_queue: "open", hold_ttl_secs: 600, web_calls_as_demo_caller: "on" };
let cache: { at: number; flags: Flags; scenario: Scenario | null } | null = null;

export async function readConfig(env: any): Promise<{ flags: Flags; scenario: Scenario | null }> {
  if (cache && Date.now() - cache.at < 5000) return cache;
  const [raw, sc] = await Promise.all([env.KV.get("flags/all"), env.KV.get("scenario/active")]);
  const flags = { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) } as Flags;
  const scenario = sc ? (JSON.parse(sc) as Scenario) : null;
  cache = { at: Date.now(), flags, scenario };
  return cache;
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
