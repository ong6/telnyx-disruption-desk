// The MCP tools. Every tool acts on the booking this call is verified for (bound by the webhook
// from caller ID, or by verify_booking): the model never chooses whose booking to change. Rules
// live here, not in the prompt: only same-route flights can be held, no confirm without a live
// hold, the change fee is computed here, no refund unless the flight was disrupted.
import { readConfigFast } from "../../../shared/config";
import { pss, type PssBooking } from "../../../shared/pss-client";
import { changeFee, REFUND_SGD } from "../../../shared/fees";
import { departuresOn, travelDates, type RankOpts } from "../../../shared/rank";
import type { CallClaims, FlightSnapshot, TripState } from "../../../shared/types";
import { AIRLINE, SCHEDULE_DAYS } from "../../../shared/seed";
import { addDays, flightId, newCode, sgDate, spell, spokenDate, spokenDay, spokenFlight, spokenTime } from "../../../shared/util";

export interface ToolCtx {
  env: any;
  claims: CallClaims;
  log: ReturnType<typeof import("../../../shared/log").makeLogger>;
  /** The tool call's arguments: booking tools may carry booking_code and last_name. */
  args?: Args;
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

/**
 * The booking this call may act on. A booking tool that carries the booking code and last name
 * acts on that booking once they check out (same attempt counter and lockout as verify_booking),
 * and links the turn to it. They win over the turn's link: a link can be lost between turns, or
 * point at another conversation's booking (a parallel chat once confirmed R2D5VK for a caller
 * who had verified K7Q2ZX: DEBUGLOG #25, #27). Without them, the link decides.
 */
async function requireBooking(ctx: ToolCtx): Promise<PssBooking> {
  if (ctx.args?.booking_code && ctx.args?.last_name) {
    const r = await checkPair(ctx, ctx.args.booking_code, ctx.args.last_name);
    if (!("b" in r)) throw new ToolError("not_verified", `The booking code and last name didn't match (${JSON.stringify(r)}). Read them back to the caller and ask which is wrong.`);
    return r.b;
  }
  const code = await sessionBooking(ctx);
  if (!code)
    throw new ToolError("not_verified", "This call isn't linked to a booking yet. Call this tool again with the caller's booking_code and last_name. If you don't have them, ask for them. This is not a system fault: don't say the system is down.");
  const b = await pss(ctx.env, ctx.claims.trace, ctx.log).booking(code);
  if (!b) throw new ToolError("booking_missing", "The booking could not be found in the reservation system.");
  return b;
}

/** verify_booking's check: links the call to the booking on a match, counts a failed attempt otherwise. */
async function checkPair(ctx: ToolCtx, booking_code: unknown, last_name: unknown): Promise<{ b: PssBooking } | { verified: false; reason?: string; attempts_left?: number; next: string }> {
  const code = String(booking_code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const name = letters(last_name);
  // A call made before the caller gave both isn't an attempt.
  if (!code || !name) return { verified: false, reason: "missing_details", next: "ask the caller for their booking code and last name, then call this again" };
  const left = await session(ctx).attemptsLeft();
  if (left <= 0) return { verified: false, attempts_left: 0, next: "transfer the caller to a person" };
  const b = await pss(ctx.env, ctx.claims.trace, ctx.log).booking(code);
  if (!b || letters(b.last_name) !== name) {
    // The call-side MCP client can deliver one tool call several times (DEBUGLOG #22), so
    // the same code and name count as one attempt.
    const { left: attemptsLeft, counted } = await session(ctx).fail(`${code}|${name}`);
    if (b && counted) await trip(ctx, b.code).verifyFailed();
    return { verified: false, attempts_left: attemptsLeft, next: "read back the code and name you used, ask which is wrong, and try again" };
  }
  await session(ctx).bind(b.code);
  return { b };
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
    rebooked: b.confirmation ? { flight: `${b.new_flight} on ${b.new_date}`, booking_code: b.code, spelled: spell(b.code) } : null,
    refund_reference: b.status === "refunded" ? b.refund_ref : null,
    cancellation_refund_reference: b.status === "cancelled" ? b.refund_ref : null,
    waitlisted_for: t?.status === "waitlisted" ? t.waitlist?.flightId : null,
    tier: b.tier,
    special_assistance: b.assistance,
  };
}

/** Everything a rebooking step needs: the booking, its original flight, the fee and the rules
 *  for which flights qualify (same route, not the original or current flight, not about to leave). */
async function rebookContext(ctx: ToolCtx) {
  const b = await requireBooking(ctx);
  const orig = await pss(ctx.env, ctx.claims.trace, ctx.log).flight(b.flight, b.date);
  if (!orig) throw new ToolError("flight_missing", "Original flight not found");
  const scenario = (await readConfigFast(ctx.env, 300))?.scenario;
  const exclude = [flightId(orig.number, orig.date), ...(b.new_flight && b.new_date ? [flightId(b.new_flight, b.new_date)] : [])];
  const rules: RankOpts = { from: orig.origin, to: orig.dest, pax: b.pax, notBefore: Date.now() + 90 * 60_000, exclude };
  return { b, orig, rules, fee: changeFee(orig, scenario?.id) };
}

/** Live seat counts (from the Flight actors) for the route's schedule between two dates. */
async function liveFlights(ctx: ToolCtx, origin: string, dest: string, from: string, to: string): Promise<FlightSnapshot[]> {
  const schedule = await pss(ctx.env, ctx.claims.trace, ctx.log).flights(origin, dest, from, to);
  const snaps = await Promise.all(schedule.map((f) => flight(ctx, flightId(f.number, f.date)).snapshot() as Promise<FlightSnapshot | null>));
  return snaps.filter((s): s is FlightSnapshot => !!s);
}

/** Names compared on letters only: a spelled "O-N-G" from a call is "Ong". */
const letters = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^\p{L}]/gu, "");

/** True if the trip's last event of this kind happened in the last two minutes. */
const recently = (t: TripState, ev: string) => [...t.events].reverse().some((e) => e.ev === ev && Date.now() - e.at < 120_000);

const isDate = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

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
      const r = await checkPair(ctx, booking_code, last_name);
      return "b" in r ? { verified: true, ...(await caseSummary(ctx, r.b)) } : r;
    },
  },

  get_trip_status: {
    description: "The verified caller's booking: original flight and its status, anything held, rebooked, refunded or waitlisted.",
    inputSchema: { type: "object", properties: {} },
    async run(ctx) {
      return caseSummary(ctx, await requireBooking(ctx));
    },
  },

  find_dates: {
    description:
      "Rebooking step 1: the dates in the next week that have a flight with seats for everyone on the booking, earliest first, and the change fee. Ask the caller which date they want before you mention any times.",
    inputSchema: { type: "object", properties: {} },
    async run(ctx) {
      const { b, orig, rules, fee } = await rebookContext(ctx);
      const today = sgDate(0);
      const from = orig.date > today ? orig.date : today;
      const dates = travelDates(await liveFlights(ctx, orig.origin, orig.dest, from, addDays(orig.date, SCHEDULE_DAYS - 1)), rules);
      return {
        passengers_on_booking: b.pax,
        dates: dates.map((d) => ({ date: d.date, say: spokenDay(d.date, today), departures_with_seats: d.departures })),
        change_fee_sgd: fee.amount,
        fee_say: fee.say,
        none_available: dates.length === 0,
        next: dates.length
          ? "offer the first two or three dates and ask which day suits them; once they pick a day, call find_flights with that date"
          : "no flight this week has seats for the whole party: offer the waitlist or, if their flight was cancelled, a refund",
      };
    },
  },

  find_flights: {
    description:
      "Rebooking step 2, once the caller has chosen a date: the departure times that day with seats for everyone on the booking, earliest first, each with its change fee. Also lists that day's full flights, for the waitlist.",
    inputSchema: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD, one of the dates find_dates returned" } },
      required: ["date"],
    },
    async run(ctx, { date }) {
      if (!isDate(date)) throw new ToolError("bad_date", "Pass the date as YYYY-MM-DD, from find_dates.");
      const { b, orig, rules, fee } = await rebookContext(ctx);
      const { open, full } = departuresOn(await liveFlights(ctx, orig.origin, orig.dest, date, date), date, rules);
      return {
        date,
        date_say: spokenDay(date, sgDate(0)),
        passengers_on_booking: b.pax,
        options: open.map((f) => ({ flight_id: f.id, say: `${spokenFlight(f.number)}, departing ${spokenTime(f.dep)} and arriving ${spokenTime(f.arr)}`, seats_left: f.seatsLeft, change_fee_sgd: fee.amount })),
        full_flights: full.map((f) => ({ flight_id: f.id, say: `${spokenFlight(f.number)} at ${spokenTime(f.dep)}` })),
        fee_say: fee.say,
        next: open.length
          ? "offer up to three departure times (earliest first, or in the part of the day they asked for), say the change fee once, and ask which time they want"
          : "nothing has seats that day: offer another date from find_dates, or the waitlist on one of the full flights",
      };
    },
  },

  hold_seats: {
    description:
      "Hold seats for everyone on the booking on one flight, all or nothing, for a few minutes while the caller decides. Use a flight_id from find_flights.",
    inputSchema: { type: "object", properties: { flight_id: { type: "string", description: "e.g. NB862-2026-10-12" } }, required: ["flight_id"] },
    async run(ctx, { flight_id }) {
      const { b, rules, fee } = await rebookContext(ctx);
      // Only a flight find_flights could have offered: same route, not the original, not leaving soon.
      const target: FlightSnapshot | null = await flight(ctx, String(flight_id)).snapshot();
      const date = target?.date ?? "";
      if (!target || !departuresOn([target], date, { ...rules, pax: 0 }).open.length)
        return { held: false, reason: "not_offered", next: "only hold a flight_id that find_flights returned for this booking" };
      // Never wait on a KV read mid-conversation: last known flags, refreshed in the background.
      const ttl = (await readConfigFast(ctx.env, 300))?.flags.hold_ttl_secs ?? 600;
      const t: TripState | null = await trip(ctx, b.code).get();
      // Hold the new flight first: if it just filled up, the caller keeps the hold they have.
      const r = await flight(ctx, flight_id).hold(b.code, b.pax, ttl);
      if (!r.ok) {
        return { held: false, reason: r.reason, seats_left: r.seatsLeft, next: "say that flight just filled up, then offer another time from find_flights" };
      }
      if (t?.hold && t.hold.flightId !== flight_id) await flight(ctx, t.hold.flightId).release(t.hold.holdId);
      await trip(ctx, b.code).held(flight_id, r.holdId, r.expiresAt);
      return {
        held: true, flight_id, flight: describeFlight(target), passengers: b.pax, minutes_to_confirm: Math.round((r.expiresAt - Date.now()) / 60000),
        change_fee_sgd: fee.amount, fee_say: fee.amount ? `The change fee is ${fee.amount} Singapore dollars, charged to the card you booked with.` : fee.say,
        next: "read back the flight, date, departure time, the passengers and the change fee, then ask for a clear yes",
      };
    },
  },

  confirm_rebooking: {
    description: "Confirm the held seats after the caller clearly says yes. The booking keeps its booking code; read it back letter by letter.",
    inputSchema: { type: "object", properties: {} },
    async run(ctx) {
      const b = await requireBooking(ctx);
      const t: TripState | null = await trip(ctx, b.code).get();
      if (!t?.hold) {
        // The same confirm delivered twice (DEBUGLOG #22) gets the same answer, not "no hold".
        if (t?.rebookedTo && b.confirmation === t.rebookedTo.confirmation && recently(t, "rebooked"))
          return { confirmed: true, booking_code: b.code, spelled: spell(b.code), say: `You're confirmed. Your booking code stays the same: ${spell(b.code)}.` };
        return { confirmed: false, reason: "no_hold", next: "hold a flight first" };
      }
      const r = await flight(ctx, t.hold.flightId).confirm(t.hold.holdId, b.code);
      if (!r.ok) return { confirmed: false, reason: r.reason, next: "apologise that the hold expired, run find_flights again for the same date" };
      const target: FlightSnapshot = await flight(ctx, t.hold.flightId).snapshot();
      const orig = await pss(ctx.env, ctx.claims.trace, ctx.log).flight(b.flight, b.date);
      const fee = changeFee(orig ?? { status: "scheduled", origin: target.from, dest: target.to }, (await readConfigFast(ctx.env, 300))?.scenario?.id);
      // A change keeps the booking code, as airlines keep the record locator: the caller has one code.
      const confirmation = b.code;
      let ticketing = "issued";
      try {
        await pss(ctx.env, ctx.claims.trace, ctx.log).rebook(b.code, { flight: target.number, date: target.date, confirmation, fee: fee.amount });
      } catch (e: any) {
        ticketing = "pending"; // the seat is ours in the actor; the write-back is retried by an agent
        ctx.log.error("pss_writeback_failed", { trace: ctx.claims.trace, booking: b.code, err: String(e?.message ?? e) });
      }
      // A voluntary change frees the original seats; a cancelled flight has none to free.
      const origId = flightId(b.flight, b.date);
      if (origId !== target.id) await flight(ctx, origId).returnSeats(b.code, b.pax).catch(() => {});
      await trip(ctx, b.code).rebooked(target.id, confirmation);
      const receipt = { confirmation, booking: b.code, passenger: `${b.first_name} ${b.last_name}`, pax: b.pax, flight: target, change_fee_sgd: fee.amount, fee_waived_by: fee.waivedBy, ticketing, at: new Date().toISOString(), trace: ctx.claims.trace };
      ctx.env.DOCS?.put(`receipts/${b.code}-${Date.now()}.json`, JSON.stringify(receipt, null, 2), { httpMetadata: { contentType: "application/json" } }).catch(() => {});
      return {
        confirmed: true, booking_code: b.code, spelled: spell(b.code), flight: describeFlight(target), passengers: b.pax, change_fee_sgd: fee.amount, ticketing,
        say: `You're confirmed on ${describeFlight(target)}. Your booking code stays the same: ${spell(b.code)}.${fee.amount ? ` The ${fee.amount} Singapore dollar change fee goes on the card you booked with.` : " There's no charge for the change."}`,
      };
    },
  },

  request_refund: {
    description:
      "Refund the booking in full when the caller does not want to travel. Only allowed when their flight was cancelled or heavily delayed. Deliver the refund-rights statement before calling this.",
    inputSchema: { type: "object", properties: { reason: { type: "string" } } },
    async run(ctx, { reason }) {
      const b = await requireBooking(ctx);
      // Already refunded (or the same request delivered twice): the same answer, not a second refund.
      if (b.status === "refunded" && b.refund_ref)
        return { refunded: true, refund_sgd: REFUND_SGD, refund_reference: b.refund_ref, spelled: spell(b.refund_ref), timeline: "back on the original card within 7 business days", say: `Your refund of ${REFUND_SGD} Singapore dollars is done. The reference is ${spell(b.refund_ref)}.` };
      const orig = await pss(ctx.env, ctx.claims.trace, ctx.log).flight(b.flight, b.date);
      if (orig?.status !== "cancelled" && orig?.status !== "delayed")
        return { refunded: false, reason: "flight_operating", next: "their flight is operating: use cancel_booking, which also refunds the caller" };
      const t: TripState | null = await trip(ctx, b.code).get();
      const { refund_ref } = await pss(ctx.env, ctx.claims.trace, ctx.log).refund(b.code, String(reason ?? "flight disrupted"));
      // Only free seats once the refund actually went through, and free whatever the caller was
      // holding or was rebooked onto, so neither a live hold nor confirmed seats leak.
      if (t?.hold) await flight(ctx, t.hold.flightId).release(t.hold.holdId);
      if (t?.rebookedTo) await flight(ctx, t.rebookedTo.flightId).returnSeats(b.code, b.pax).catch(() => {});
      await trip(ctx, b.code).refunded(refund_ref);
      return {
        refunded: true, refund_sgd: REFUND_SGD, refund_reference: refund_ref, spelled: spell(refund_ref), timeline: "back on the original card within 7 business days",
        say: `Your refund of ${REFUND_SGD} Singapore dollars is done. The reference is ${spell(refund_ref)}. The money will be back on your original card within 7 business days.`,
      };
    },
  },

  cancel_booking: {
    description:
      `Cancel the booking when the caller no longer wants to travel and their flight is operating. We refund ${REFUND_SGD} Singapore dollars to the original card within 7 business days. Say that and get a clear yes first. If Nimbus Air cancelled or delayed their flight, use request_refund instead.`,
    inputSchema: { type: "object", properties: {} },
    async run(ctx) {
      const b = await requireBooking(ctx);
      if (b.status === "cancelled" && b.refund_ref)
        return { cancelled: true, refund_sgd: REFUND_SGD, refund_reference: b.refund_ref, spelled: spell(b.refund_ref), say: `Your booking is cancelled, and ${REFUND_SGD} Singapore dollars is on its way back to your card. Your reference is ${spell(b.refund_ref)}.` };
      if (b.status === "refunded") return { cancelled: false, reason: "already_refunded", next: "tell the caller the booking was already refunded and give the reference from get_trip_status" };
      const orig = await pss(ctx.env, ctx.claims.trace, ctx.log).flight(b.flight, b.date);
      if (orig?.status === "cancelled" || orig?.status === "delayed")
        return { cancelled: false, reason: "refund_eligible", next: "their flight was disrupted, so they're entitled to a full refund: use request_refund instead" };
      const t: TripState | null = await trip(ctx, b.code).get();
      const { credit_ref } = await pss(ctx.env, ctx.claims.trace, ctx.log).cancel(b.code);
      // The seats go back once the cancellation is recorded: a live hold, and the seats on
      // whichever flight they hold now (the rebooked one if they changed, else the original).
      if (t?.hold) await flight(ctx, t.hold.flightId).release(t.hold.holdId);
      const seatsOn = t?.rebookedTo?.flightId ?? flightId(b.flight, b.date);
      await flight(ctx, seatsOn).returnSeats(b.code, b.pax).catch(() => {});
      await trip(ctx, b.code).cancelled(credit_ref);
      return {
        cancelled: true, refund_sgd: REFUND_SGD, refund_reference: credit_ref, spelled: spell(credit_ref), timeline: "back on the original card within 7 business days",
        say: `Your booking is cancelled, and we'll refund ${REFUND_SGD} Singapore dollars to your original card within 7 business days. Your reference is ${spell(credit_ref)}.`,
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
        caller_chose_callback: { type: "boolean", description: "true if the caller asked for a callback, or picked it when offered a callback or a person" },
        transfer_failed: { type: "boolean", description: "true only if a transfer to a person was just tried and failed" },
      },
      required: ["reason"],
    },
    async run(ctx, { reason, caller_chose_callback, transfer_failed }) {
      // MCP tools are callable from any node, so the rule lives here: while a person is free, a
      // caller who didn't ask for a callback is transferred, not parked. One who chose it gets it
      // (a "yes, call me back" was once answered with a transfer and a hang-up: DEBUGLOG #27).
      const { flags } = (await readConfigFast(ctx.env, 300)) ?? { flags: { human_queue: "open" } };
      if (flags.human_queue !== "full" && !transfer_failed && !caller_chose_callback)
        return { booked: false, reason: "agents_available", next: "a person is free: in this same turn, say you're connecting them and call the transition to a person" };
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

// Every tool that acts on the booking also takes the booking code and last name, so a call whose
// link was lost between turns still works without a separate verify step (see requireBooking).
const IDENTITY = {
  booking_code: { type: "string", description: "the caller's 6-character booking code, if you have it" },
  last_name: { type: "string", description: "the caller's last name, if you have it" },
};
for (const name of ["get_trip_status", "find_dates", "find_flights", "hold_seats", "confirm_rebooking", "request_refund", "cancel_booking", "join_waitlist"]) {
  const schema = TOOLS[name].inputSchema as { properties: Record<string, object> };
  schema.properties = { ...schema.properties, ...IDENTITY };
}
