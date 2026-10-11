// The MCP tools. Every tool acts on the booking this call is verified for (bound by the webhook
// from caller ID, or by verify_booking): the model never chooses whose booking to change. Rules
// live here, not in the prompt: no confirm without a live hold, no refund unless the flight was
// disrupted.
import { readConfigFast } from "../../../shared/config";
import { pss, type PssBooking } from "../../../shared/pss-client";
import { rankOptions } from "../../../shared/rank";
import type { CallClaims, FlightSnapshot, TripState } from "../../../shared/types";
import { AIRLINE } from "../../../shared/seed";
import { addDays, departsAt, flightId, newCode, spell, spokenDate, spokenFlight, spokenTime } from "../../../shared/util";

export interface ToolCtx {
  env: any;
  claims: CallClaims;
  log: ReturnType<typeof import("../../../shared/log").makeLogger>;
}

type Args = Record<string, any>;
type Tool = { description: string; inputSchema: object; run: (ctx: ToolCtx, args: Args) => Promise<object> };

const city = (iata: string) => AIRLINE.cities[iata] ?? iata;
const policyMemo = new Map<string, { at: number; text: string }>();

const session = (ctx: ToolCtx) => ctx.env.CALL.idFromName(ctx.claims.trace);

/** The booking this call may act on: bound by the webhook (caller ID) or by verify_booking. */
async function sessionBooking(ctx: ToolCtx): Promise<string> {
  if (ctx.claims.booking) return ctx.claims.booking;
  const s = await session(ctx).get();
  if (s.caller && !ctx.claims.caller) ctx.claims.caller = s.caller;
  return s.booking;
}

async function requireBooking(ctx: ToolCtx): Promise<PssBooking> {
  const code = await sessionBooking(ctx);
  if (!code) throw new ToolError("not_verified", "Verify the caller first with verify_booking (booking code and last name).");
  const b = await pss(ctx.env, ctx.claims.trace, ctx.log).booking(code);
  if (!b) throw new ToolError("booking_missing", "The booking could not be found in the reservation system.");
  return b;
}

export class ToolError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const trip = (ctx: ToolCtx, code: string) => ctx.env.TRIP.idFromName(code);
const flight = (ctx: ToolCtx, id: string) => ctx.env.FLIGHT.idFromName(id);

function describeFlight(f: FlightSnapshot | { number: string; date: string; dep: string; arr: string; from: string; to: string }) {
  return `${spokenFlight(f.number)} from ${city(f.from)} to ${city(f.to)}, ${spokenDate(f.date)}, departing ${spokenTime(f.dep)}`;
}

async function caseSummary(ctx: ToolCtx, b: PssBooking) {
  const t: TripState | null = await trip(ctx, b.code).get();
  const orig = await pss(ctx.env, ctx.claims.trace, ctx.log).flight(b.flight, b.date);
  const hold = t?.hold && t.hold.expiresAt > Date.now() ? t.hold : undefined;
  return {
    booking_code: b.code,
    passenger: `${b.first_name} ${b.last_name}`,
    passengers_on_booking: b.pax,
    original_flight: orig ? describeFlight({ ...orig, from: orig.origin, to: orig.dest }) : b.flight,
    original_flight_status: orig?.status ?? "unknown",
    case_status: t?.status ?? "none",
    held_seat: hold ? { flight_id: hold.flightId, minutes_left: Math.max(1, Math.round((hold.expiresAt - Date.now()) / 60000)) } : null,
    rebooked: b.confirmation ? { flight: `${b.new_flight} on ${b.new_date}`, confirmation_code: b.confirmation, spelled: spell(b.confirmation) } : null,
    refund_reference: b.refund_ref,
    waitlisted_for: t?.status === "waitlisted" ? t.waitlist?.flightId : null,
    tier: b.tier,
    special_assistance: b.assistance,
  };
}

export const TOOLS: Record<string, Tool> = {
  verify_booking: {
    description:
      "Verify an unrecognised caller. Ask for their 6-character booking code (read it back letter by letter) and last name, then call this. On success the call is linked to that booking.",
    inputSchema: {
      type: "object",
      properties: {
        booking_code: { type: "string", description: "6 characters, letters and digits, e.g. K7Q2ZX" },
        last_name: { type: "string" },
      },
      required: ["booking_code", "last_name"],
    },
    async run(ctx, { booking_code, last_name }) {
      const left = await session(ctx).attemptsLeft();
      if (left <= 0) return { verified: false, attempts_left: 0, next: "transfer the caller to a person" };
      const code = String(booking_code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const b = code ? await pss(ctx.env, ctx.claims.trace, ctx.log).booking(code) : null;
      const ok = !!b && b.last_name.toLowerCase() === String(last_name ?? "").trim().toLowerCase();
      if (!ok) {
        if (b) await trip(ctx, b.code).verifyFailed();
        return { verified: false, attempts_left: await session(ctx).fail(), next: "ask the caller to check the code and try again" };
      }
      await session(ctx).bind(b!.code);
      return { verified: true, ...(await caseSummary(ctx, b!)) };
    },
  },

  get_trip_status: {
    description: "The verified caller's booking: original flight and its status, anything held, rebooked, refunded or waitlisted.",
    inputSchema: { type: "object", properties: {} },
    async run(ctx) {
      return caseSummary(ctx, await requireBooking(ctx));
    },
  },

  find_alternatives: {
    description:
      "Up to 3 flights the caller can move to, earliest first, each with enough seats for everyone on the booking. Offer at most two at a time. Only ever offer flights this tool returned.",
    inputSchema: { type: "object", properties: {} },
    async run(ctx) {
      const b = await requireBooking(ctx);
      const orig = await pss(ctx.env, ctx.claims.trace, ctx.log).flight(b.flight, b.date);
      if (!orig) throw new ToolError("flight_missing", "Original flight not found");
      const schedule = await pss(ctx.env, ctx.claims.trace, ctx.log).flights(orig.origin, orig.dest, b.date, addDays(b.date, 2));
      const snaps: FlightSnapshot[] = (
        await Promise.all(schedule.map((f) => flight(ctx, flightId(f.number, f.date)).snapshot() as Promise<FlightSnapshot | null>))
      ).filter((s): s is FlightSnapshot => !!s);
      const options = rankOptions(snaps, {
        from: orig.origin, to: orig.dest, pax: b.pax, notBefore: Date.now() + 90 * 60_000, exclude: flightId(orig.number, orig.date),
      });
      return {
        passengers_on_booking: b.pax,
        options: options.map((f) => ({ flight_id: f.id, say: describeFlight(f), seats_left: f.seatsLeft })),
        none_available: options.length === 0,
        if_none: "offer the waitlist on the earliest flight (join_waitlist) or a refund (request_refund)",
      };
    },
  },

  hold_seats: {
    description:
      "Hold seats for everyone on the booking on one flight, all or nothing, for a few minutes while the caller decides. Use the flight_id from find_alternatives.",
    inputSchema: { type: "object", properties: { flight_id: { type: "string", description: "e.g. NB862-2026-10-12" } }, required: ["flight_id"] },
    async run(ctx, { flight_id }) {
      const b = await requireBooking(ctx);
      // Never wait on a KV read mid-conversation: last known flags, refreshed in the background.
      const ttl = (await readConfigFast(ctx.env, 300))?.flags.hold_ttl_secs ?? 600;
      const t: TripState | null = await trip(ctx, b.code).get();
      // Hold the new flight first: if it just filled up, the caller keeps the hold they have.
      const r = await flight(ctx, flight_id).hold(b.code, b.pax, ttl);
      if (!r.ok) {
        return { held: false, reason: r.reason, seats_left: r.seatsLeft, next: "say that flight just filled up, then offer the next option from find_alternatives" };
      }
      if (t?.hold && t.hold.flightId !== flight_id) await flight(ctx, t.hold.flightId).release(t.hold.holdId);
      await trip(ctx, b.code).held(flight_id, r.holdId, r.expiresAt);
      return { held: true, flight_id, passengers: b.pax, minutes_to_confirm: Math.round((r.expiresAt - Date.now()) / 60000), next: "read back the flight and ask the caller to confirm" };
    },
  },

  confirm_rebooking: {
    description: "Confirm the held seats after the caller clearly says yes. Returns the new confirmation code; read it back letter by letter.",
    inputSchema: { type: "object", properties: {} },
    async run(ctx) {
      const b = await requireBooking(ctx);
      const t: TripState | null = await trip(ctx, b.code).get();
      if (!t?.hold) return { confirmed: false, reason: "no_hold", next: "hold a flight first" };
      const r = await flight(ctx, t.hold.flightId).confirm(t.hold.holdId, b.code);
      if (!r.ok) return { confirmed: false, reason: r.reason, next: "apologise that the hold expired, run find_alternatives again" };
      const target: FlightSnapshot = await flight(ctx, t.hold.flightId).snapshot();
      const confirmation = newCode(6);
      let ticketing = "issued";
      try {
        await pss(ctx.env, ctx.claims.trace, ctx.log).rebook(b.code, { flight: target.number, date: target.date, confirmation });
      } catch (e: any) {
        ticketing = "pending"; // the seat is ours in the actor; the write-back is retried by an agent
        ctx.log.error("pss_writeback_failed", { trace: ctx.claims.trace, booking: b.code, err: String(e?.message ?? e) });
      }
      // A voluntary change frees the original seats; a cancelled flight has none to free.
      const origId = flightId(b.flight, b.date);
      if (origId !== target.id) await flight(ctx, origId).returnSeats(b.code, b.pax).catch(() => {});
      await trip(ctx, b.code).rebooked(target.id, confirmation);
      const receipt = { confirmation, booking: b.code, passenger: `${b.first_name} ${b.last_name}`, pax: b.pax, flight: target, ticketing, at: new Date().toISOString(), trace: ctx.claims.trace };
      ctx.env.DOCS?.put(`receipts/${confirmation}.json`, JSON.stringify(receipt, null, 2), { httpMetadata: { contentType: "application/json" } }).catch(() => {});
      return {
        confirmed: true, confirmation_code: confirmation, spelled: spell(confirmation), flight: describeFlight(target), passengers: b.pax, ticketing,
        say: `You're confirmed on ${describeFlight(target)}. Your new confirmation code is ${spell(confirmation)}.`,
      };
    },
  },

  request_refund: {
    description:
      "Refund the booking in full when the caller does not want to travel. Only allowed when their flight was cancelled or heavily delayed. Deliver the refund-rights statement before calling this.",
    inputSchema: { type: "object", properties: { reason: { type: "string" } } },
    async run(ctx, { reason }) {
      const b = await requireBooking(ctx);
      const orig = await pss(ctx.env, ctx.claims.trace, ctx.log).flight(b.flight, b.date);
      if (orig?.status !== "cancelled" && orig?.status !== "delayed")
        return { refunded: false, reason: "not_eligible", next: "explain the fare is non-refundable for a voluntary cancellation; offer to change the flight instead" };
      const t: TripState | null = await trip(ctx, b.code).get();
      const { refund_ref } = await pss(ctx.env, ctx.claims.trace, ctx.log).refund(b.code, String(reason ?? "flight disrupted"));
      // Only free seats once the refund actually went through, and free whatever the caller was
      // holding or was rebooked onto, so neither a live hold nor confirmed seats leak.
      if (t?.hold) await flight(ctx, t.hold.flightId).release(t.hold.holdId);
      if (t?.rebookedTo) await flight(ctx, t.rebookedTo.flightId).returnSeats(b.code, b.pax).catch(() => {});
      await trip(ctx, b.code).refunded(refund_ref);
      return {
        refunded: true, refund_reference: refund_ref, spelled: spell(refund_ref), timeline: "back on the original card within 7 business days",
        say: `Your refund is done. The reference is ${spell(refund_ref)}. The money will be back on your original card within 7 business days.`,
      };
    },
  },

  join_waitlist: {
    description:
      "Put the booking on the waitlist for a full flight. When a seat frees up, it is held for them and we call them back automatically. Also issues a hotel and meal voucher when they are stranded overnight.",
    inputSchema: { type: "object", properties: { flight_id: { type: "string" } }, required: ["flight_id"] },
    async run(ctx, { flight_id }) {
      const b = await requireBooking(ctx);
      const r = await flight(ctx, flight_id).joinWaitlist(b.code, b.pax);
      if (!r.ok) return { waitlisted: false, reason: r.reason };
      await trip(ctx, b.code).waitlisted(flight_id);
      const orig = await pss(ctx.env, ctx.claims.trace, ctx.log).flight(b.flight, b.date);
      const voucher = orig?.status === "cancelled" ? `VC${newCode(5)}` : null;
      return {
        waitlisted: true, position: r.position, callback: "we'll call the number on the booking as soon as seats free up",
        voucher: voucher ? { code: voucher, spelled: spell(voucher), covers: "one night's hotel near the airport and meals, up to 150 Singapore dollars per person" } : null,
        say: `You're number ${r.position} on the waitlist. If seats free up, we'll hold them and call you straight back.${voucher ? ` Your hotel and meal voucher code is ${spell(voucher)}, worth up to 150 Singapore dollars per person.` : ""}`,
      };
    },
  },

  request_callback: {
    description:
      "Book a callback from a person when the human desk is too busy for a transfer, or the caller prefers to be called back. Uses the number on the booking, or the number they called from.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "one line for the agent who calls back" },
        transfer_failed: { type: "boolean", description: "true only if a transfer to a person was just tried and failed" },
      },
      required: ["reason"],
    },
    async run(ctx, { reason, transfer_failed }) {
      // MCP tools are callable from any node, so the rule lives here: while a person is free,
      // the caller is transferred, not parked on a callback.
      const { flags } = (await readConfigFast(ctx.env, 300)) ?? { flags: { human_queue: "open" } };
      if (flags.human_queue !== "full" && !transfer_failed)
        return { booked: false, reason: "agents_available", next: "a person is free: tell the caller you're connecting them now" };
      const code = await sessionBooking(ctx);
      if (code) await trip(ctx, code).escalated(String(reason ?? "callback requested"));
      const entry = { at: Date.now(), trace: ctx.claims.trace, booking: code, caller: ctx.claims.caller, reason: String(reason ?? "") };
      await ctx.env.METRICS.idFromName("global").callbackBooked(entry);
      return { booked: true, expected_within: "2 hours", number: code ? "the number on the booking" : "the number you are calling from" };
    },
  },

  get_policy: {
    description: "Airline policy text for questions about baggage, refunds, the typhoon waiver, special assistance or vouchers. Answer only from this text.",
    inputSchema: { type: "object", properties: { topic: { type: "string", enum: ["baggage", "refunds", "disruption", "special-assistance", "vouchers"] } }, required: ["topic"] },
    async run(ctx, { topic }) {
      const cached = policyMemo.get(topic);
      if (cached && Date.now() - cached.at < 300_000) return { topic, text: cached.text, source: "memory" };
      const obj = await ctx.env.DOCS.get(`policies/${topic}.md`);
      if (!obj || !("text" in obj)) throw new ToolError("no_policy", `No policy document for ${topic}`);
      const text = await obj.text();
      policyMemo.set(topic, { at: Date.now(), text });
      return { topic, text, source: "cloud-storage" };
    },
  },
};
