// One actor per flight per date. It owns the seat count, holds and the waitlist. Every change
// is a read-modify-write that hundreds of callers race on during a disruption; the actor runs
// one call at a time, so there is no lock and no oversell. KV can't do this: it is
// last-write-wins with no compare-and-swap.
import { StatefulActor } from "@telnyx/edge-runtime";
import type { FlightSnapshot, FlightState, FlightStatus, Hold } from "../../../shared/types";
import { newId } from "../../../shared/util";

const OFFER_TTL_MS = 15 * 60_000;

export class Flight extends StatefulActor {
  private async load(): Promise<FlightState | null> {
    return (await this.ctx.storage.get<FlightState>("s")) ?? null;
  }
  private async save(s: FlightState) {
    await this.ctx.storage.put("s", s);
  }
  private held(s: FlightState) {
    return Object.values(s.holds).reduce((n, h) => n + h.pax, 0);
  }
  private seatsLeft(s: FlightState) {
    const confirmed = Object.values(s.confirmed).reduce((n, p) => n + p, 0);
    return s.capacity - s.sold - this.held(s) - confirmed;
  }
  /** Holds also expire on read, so correctness never depends on the alarm firing. */
  private expire(s: FlightState, now = Date.now()) {
    const gone: Hold[] = [];
    for (const [id, h] of Object.entries(s.holds)) if (h.expiresAt <= now) (gone.push(h), delete s.holds[id]);
    for (const h of gone) if (s.offers[h.booking] === h.id) delete s.offers[h.booking];
    return gone;
  }
  private async scheduleAlarm(s: FlightState, soon = false) {
    const next = Object.values(s.holds).map((h) => h.expiresAt);
    if (soon) next.push(Date.now() + 1000);
    if (next.length) await this.ctx.storage.setAlarm(Math.min(...next));
  }
  private snap(s: FlightState): FlightSnapshot {
    return {
      id: s.id, number: s.number, date: s.date, dep: s.dep, arr: s.arr, from: s.from, to: s.to, status: s.status,
      capacity: s.capacity, seatsLeft: Math.max(0, this.seatsLeft(s)), held: this.held(s), waitlist: s.waitlist.length,
    };
  }

  async init(def: Pick<FlightState, "id" | "number" | "date" | "dep" | "arr" | "from" | "to" | "status" | "capacity" | "sold">): Promise<FlightSnapshot> {
    const s: FlightState = { ...def, holds: {}, confirmed: {}, waitlist: [], offers: {} };
    await this.ctx.storage.deleteAlarm();
    await this.save(s);
    return this.snap(s);
  }

  async setStatus(status: FlightStatus): Promise<FlightSnapshot | null> {
    const s = await this.load();
    if (!s) return null;
    s.status = status;
    await this.save(s);
    return this.snap(s);
  }

  async snapshot(): Promise<FlightSnapshot | null> {
    const s = await this.load();
    if (!s) return null;
    if (this.expire(s).length) await this.save(s);
    return this.snap(s);
  }

  async hold(booking: string, pax: number, ttlSecs: number) {
    const s = await this.load();
    if (!s) return { ok: false as const, reason: "unknown_flight", seatsLeft: 0 };
    this.expire(s);
    if (s.status === "cancelled") return { ok: false as const, reason: "cancelled", seatsLeft: 0 };
    // Idempotent: a retried tool call returns the hold the booking already has.
    const existing = Object.values(s.holds).find((h) => h.booking === booking);
    if (existing) return { ok: true as const, holdId: existing.id, expiresAt: existing.expiresAt, seatsLeft: this.seatsLeft(s), reused: true };
    const left = this.seatsLeft(s);
    if (left < pax) {
      await this.save(s);
      return { ok: false as const, reason: left === 0 ? "sold_out" : "not_enough_seats", seatsLeft: Math.max(0, left) };
    }
    const h: Hold = { id: newId("hold"), booking, pax, expiresAt: Date.now() + ttlSecs * 1000 };
    s.holds[h.id] = h;
    await this.save(s);
    await this.scheduleAlarm(s);
    return { ok: true as const, holdId: h.id, expiresAt: h.expiresAt, seatsLeft: this.seatsLeft(s) };
  }

  async confirm(holdId: string, booking: string) {
    const s = await this.load();
    if (!s) return { ok: false as const, reason: "unknown_flight" };
    const expired = this.expire(s).some((h) => h.id === holdId);
    const h = s.holds[holdId];
    if (!h || h.booking !== booking) {
      await this.save(s);
      return { ok: false as const, reason: expired ? "hold_expired" : "hold_not_found" };
    }
    delete s.holds[holdId];
    delete s.offers[booking];
    s.confirmed[booking] = (s.confirmed[booking] ?? 0) + h.pax;
    await this.save(s);
    await this.scheduleAlarm(s);
    return { ok: true as const, pax: h.pax, seatsLeft: this.seatsLeft(s) };
  }

  async release(holdId: string) {
    const s = await this.load();
    if (!s || !s.holds[holdId]) return { ok: false };
    const h = s.holds[holdId];
    delete s.holds[holdId];
    if (s.offers[h.booking] === holdId) delete s.offers[h.booking];
    await this.save(s);
    await this.scheduleAlarm(s, true); // a seat came back: let the alarm offer it to the waitlist
    return { ok: true, seatsLeft: this.seatsLeft(s) };
  }

  /** A passenger leaves this flight (refund, or moved by a voluntary change). */
  async returnSeats(booking: string, pax: number) {
    const s = await this.load();
    if (!s) return { ok: false };
    if (s.confirmed[booking]) delete s.confirmed[booking];
    else s.sold = Math.max(0, s.sold - pax);
    await this.save(s);
    await this.scheduleAlarm(s, true);
    return { ok: true, seatsLeft: this.seatsLeft(s) };
  }

  async joinWaitlist(booking: string, pax: number) {
    const s = await this.load();
    if (!s) return { ok: false as const, reason: "unknown_flight", position: 0 };
    let i = s.waitlist.findIndex((w) => w.booking === booking);
    if (i < 0) i = s.waitlist.push({ booking, pax, at: Date.now() }) - 1;
    await this.save(s);
    return { ok: true as const, position: i + 1 };
  }

  /** Expire holds, then offer freed seats to the waitlist and ask the Trip actor to call them. */
  async alarm(): Promise<void> {
    const s = await this.load();
    if (!s) return;
    const expired = this.expire(s);
    const offered: { booking: string; pax: number; holdId: string; expiresAt: number }[] = [];
    while (s.waitlist.length && this.seatsLeft(s) >= s.waitlist[0].pax) {
      const w = s.waitlist.shift()!;
      const h: Hold = { id: newId("offer"), booking: w.booking, pax: w.pax, expiresAt: Date.now() + OFFER_TTL_MS };
      s.holds[h.id] = h;
      s.offers[w.booking] = h.id;
      offered.push({ booking: w.booking, pax: w.pax, holdId: h.id, expiresAt: h.expiresAt });
    }
    await this.save(s);
    await this.scheduleAlarm(s);
    console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "flight", ev: "alarm", flight: s.id, expired: expired.length, offered: offered.length }));
    // At-least-once: seatOffered is idempotent per holdId. One failed Trip actor must not stop
    // the remaining offers, and must not silently demote the passenger whose call failed: put
    // them back at the head of the waitlist so the next alarm tries again.
    for (const o of offered) {
      try {
        await (this.env as any).TRIP.idFromName(o.booking).seatOffered(s.id, o.holdId, o.expiresAt);
      } catch {
        const cur = await this.load();
        if (!cur) return;
        if (cur.holds[o.holdId]) delete cur.holds[o.holdId];
        delete cur.offers[o.booking];
        cur.waitlist.unshift({ booking: o.booking, pax: o.pax, at: Date.now() });
        await this.save(cur);
        console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "flight", ev: "offer_retry", flight: s.id, booking: o.booking }));
      }
    }
  }
}
