// Flags, the active scenario and the deploy settings (assistant ids, outbound-call config) in one
// actor. They lived in KV until KV failed for hours at a time (DEBUGLOG #23, #27): every call,
// scenario load and flag flip went down with it. Actor storage is the same store that holds the
// seats, so the desk now has one dependency where it had two. Every RPC returns a JSON value
// (DEBUGLOG #26).
import { StatefulActor } from "@telnyx/edge-runtime";
import type { Flags, Scenario } from "../../../shared/config";

export interface ConfigState {
  flags: Partial<Flags>;
  scenario: Scenario | null;
}

export class Config extends StatefulActor {
  async get(): Promise<ConfigState> {
    const [flags, scenario] = await Promise.all([this.ctx.storage.get<Partial<Flags>>("flags"), this.ctx.storage.get<Scenario>("scenario")]);
    return { flags: flags ?? {}, scenario: scenario ?? null };
  }
  async setFlags(patch: Partial<Flags>): Promise<Partial<Flags>> {
    const next = { ...((await this.ctx.storage.get<Partial<Flags>>("flags")) ?? {}), ...patch };
    await this.ctx.storage.put("flags", next);
    return { ...next };
  }
  async setScenario(scenario: Scenario): Promise<{ ok: true }> {
    await this.ctx.storage.put("scenario", scenario);
    return { ok: true };
  }
  /** Deploy settings written by assistant/build.mjs through desk-ops: `assistants`, `outbound`. */
  async setting(key: string): Promise<unknown> {
    return (await this.ctx.storage.get(`setting/${key}`)) ?? null;
  }
  async setSettings(values: Record<string, unknown>): Promise<{ ok: true }> {
    for (const [k, v] of Object.entries(values)) await this.ctx.storage.put(`setting/${k}`, v);
    return { ok: true };
  }
}
