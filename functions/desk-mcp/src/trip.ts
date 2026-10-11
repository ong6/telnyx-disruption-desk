// One actor per booking. It remembers the passenger's case across calls (what was held,
// rebooked, refunded, how many verification attempts failed) and owns the callback alarm.
// Read by desk-dv to greet a returning caller, written by desk-mcp tools: a shared actor.
import { StatefulActor } from "@telnyx/edge-runtime";
import type { BookingDef, TripState } from "../../../shared/types";

const CALLBACK_DELAY_MS = 5000;

export class Trip extends StatefulActor {
  private async load(): Promise<TripState | null> {
    return (await this.ctx.storage.get<TripState>("s")) ?? null;
  }
  private async mutate(ev: string, fn: (s: TripState) => void, detail?: string): Promise<TripState | null> {
    const s = await this.load();
    if (!s) return null;
    fn(s);
    s.events = [...s.events, { at: Date.now(), ev, detail }].slice(-20);
    await this.ctx.storage.put("s", s);
    return s;
  }

  async init(booking: BookingDef, date: string): Promise<TripState> {
    const s: TripState = { booking, date, status: "none", verifyFailures: 0, calls: 0, events: [{ at: Date.now(), ev: "init" }] };
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.put("s", s);
    return s;
  }
  /** Clear this trip's state. Used to clean up simulated passengers after a surge run: a few
   *  hundred idle Trip instances evicted at once crashed the actor host once (DEBUGLOG #14). */
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
  async get() {
    return this.load();
  }
  async startCall(trace: string) {
    return this.mutate("call", (s) => ((s.calls += 1), (s.lastTrace = trace)), trace);
  }
  async verifyFailed() {
    return this.mutate("verify_failed", (s) => (s.verifyFailures += 1));
  }
  async held(flightId: string, holdId: string, expiresAt: number) {
    return this.mutate("held", (s) => ((s.status = "held"), (s.hold = { flightId, holdId, expiresAt })), flightId);
  }
  async rebooked(flightId: string, confirmation: string) {
    return this.mutate("rebooked", (s) => {
      s.status = "rebooked";
      s.rebookedTo = { flightId, confirmation };
      delete s.hold;
      delete s.offer;
      delete s.waitlist;
    }, flightId);
  }
  async refunded(reference: string) {
    return this.mutate("refunded", (s) => ((s.status = "refunded"), (s.refund = { reference }), delete s.hold), reference);
  }
  async waitlisted(flightId: string) {
    return this.mutate("waitlisted", (s) => ((s.status = "waitlisted"), (s.waitlist = { flightId, at: Date.now() })), flightId);
  }
  async escalated(reason: string) {
    return this.mutate("escalated", (s) => (s.status = "escalated"), reason);
  }

  /** Called by a Flight alarm when a seat frees up for this waitlisted booking. Idempotent. */
  async seatOffered(flightId: string, holdId: string, expiresAt: number) {
    const s = await this.load();
    if (!s || s.offer?.holdId === holdId) return s;
    const next = await this.mutate("seat_offered", (t) => {
      t.offer = { flightId, holdId, expiresAt };
      t.hold = { flightId, holdId, expiresAt };
      t.status = "held";
      t.callback = { reason: "seat_available", at: Date.now() + CALLBACK_DELAY_MS };
    }, flightId);
    await this.ctx.storage.setAlarm(Date.now() + CALLBACK_DELAY_MS);
    return next;
  }

  /** Place the callback: an outbound AI call to the passenger with the offer in its variables. */
  async alarm(): Promise<void> {
    const s = await this.load();
    if (!s?.callback || s.callback.placedAt) return;
    const env = this.env as any;
    const cfg = JSON.parse((await env.KV.get("config/outbound")) ?? "null");
    const apiKey = await env.SECRETS.get("TELNYX_KEY");
    let result = "skipped: no outbound config";
    if (cfg && apiKey && s.booking.phone.startsWith("+")) {
      const res = await fetch(`https://api.telnyx.com/v2/texml/ai_calls/${cfg.texmlAppId}`, {
        method: "POST",
        // A hung outbound-call API must not leave this alarm unplaced forever.
        signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          From: cfg.from,
          To: s.booking.phone,
          AIAssistantId: cfg.assistantId,
          AIAssistantDynamicVariables: { callback_reason: s.callback.reason, outbound_booking: s.booking.code },
        }),
      });
      result = `${res.status}`;
      if (!res.ok) result += ` ${(await res.text()).slice(0, 200)}`;
    }
    await this.mutate("callback_placed", (t) => t.callback && ((t.callback.placedAt = Date.now()), (t.callback.result = result)), result);
    console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "trip", ev: "callback", booking: s.booking.code, result }));
  }
}
