// desk-dv: the dynamic-variables webhook. Telnyx calls it once at the start of every
// conversation (assistant.initialization). It recognises the caller, reads their case from the
// Trip actor, reads flags and the active incident from the Config actor, and returns variables that both
// personalise the conversation and drive the workflow's variable-comparison edges. It also mints
// conversation to a CallSession actor under Telnyx's W3C trace id, which the MCP server reads.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readConfigFast } from "../../../shared/config";
import { makeLogger } from "../../../shared/log";
import { pss, type PssBooking } from "../../../shared/pss-client";
import type { TripState } from "../../../shared/types";
import { AIRLINE } from "../../../shared/seed";
import { maskPhone, spell, spokenDate, spokenFlight, spokenTime, traceFrom } from "../../../shared/util";

// Telnyx stops waiting for this webhook after about 1.2 s, whatever the assistant's configured
// timeout says (DEBUGLOG #7), and then runs the call on default variables. Answer within budget:
// past it, fall back to the anonymous path instead of answering late.
const BUDGET_MS = 900;
const within = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Telnyx signs webhooks with Ed25519 over "{timestamp}|{raw body}". */
function signatureValid(req: Request, raw: string): boolean {
  const sig = req.headers.get("telnyx-signature-ed25519");
  const ts = req.headers.get("telnyx-timestamp");
  if (!sig || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(process.env.TELNYX_PUBLIC_KEY ?? "", "base64")]), format: "der", type: "spki" });
    return verify(null, Buffer.from(`${ts}|${raw}`), key, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

const yes = (b: boolean) => (b ? "true" : "false");

/** The choices every caller hears at the end of the verbatim opening (a speak node), worded for
 *  what we already know about them: rebook, cancel, or a person. */
export const OFFER_ANYONE = "I can rebook or cancel your flight, or connect you with a person. How can I help?";
export function openingOffer(o: { name?: string; city?: string; status?: string; hold?: string; rebooked?: string; seatOffered?: boolean }): string {
  if (!o.name) return OFFER_ANYONE;
  const hi = `Hi ${o.name}.`;
  if (o.seatOffered) return `${hi} We're calling back because a seat has opened up for you, and it's on hold. Would you like me to confirm it, or would you rather speak to a person?`;
  if (o.hold) return `${hi} You have a seat on hold for your new flight. Would you like me to confirm it, choose another flight, or connect you with a person?`;
  if (o.rebooked) return `${hi} You're already rebooked, under the same booking code, ${o.rebooked}. I can change that flight, cancel it, or connect you with a person. What would you like to do?`;
  if (o.status === "cancelled") return `${hi} Your flight to ${o.city} is cancelled. I can rebook you onto another flight for free, cancel it for a full refund, or connect you with a person. What would you like to do?`;
  return `${hi} I can rebook or cancel your flight to ${o.city}, or connect you with a person. What would you like to do?`;
}

export default {
  async fetch(req: Request, env: any): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health" || url.pathname.startsWith("/health/")) return new Response("ok");
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const log = makeLogger("dv", env);
    const t0 = Date.now();
    const raw = await req.text();
    try {
      // A malformed body must not 500 the one hop that must never fail: the parse sits inside
      // the fail-soft try, so the fallback variable set at the bottom always goes out.
      const body = JSON.parse(raw || "{}");
      const p = body?.data?.payload ?? {};
      const channel: string = p.telnyx_conversation_channel ?? "unknown";
      const callId: string = p.call_control_id ?? p.telnyx_conversation_id ?? body?.data?.id ?? `${Date.now()}`;
      // Telnyx's W3C trace id is our trace id: its MCP client sends the same one, so the webhook,
      // the MCP tool calls and everything they touch land in one trace.
      // Later webhook calls in the same conversation echo earlier variables: keep the first trace id.
      const trace = /^[0-9a-f]{32}$|^c[0-9a-f]{12}$/.test(p.trace_id ?? "")
        ? p.trace_id
        : traceFrom(req.headers.get("traceparent"), `c${createHash("sha1").update(callId).digest("hex").slice(0, 12)}`);
      const signed = signatureValid(req, raw);
      const turnTrace = traceFrom(req.headers.get("traceparent"), "");

      // Flags come from memory; on a cold process we don't wait for the Config actor past the budget and leave
      // the flag variables out, so the assistant's own defaults (kept in sync by desk-ops) apply.
      const cfg = await readConfigFast(env, 500);
      const flags = cfg?.flags ?? { disruption_mode: "off", human_queue: "open", hold_ttl_secs: 600, web_calls_as_demo_caller: "off" as const, handoff: "transfer", fault: "off" };
      const scenario = cfg?.scenario ?? null;
      let caller: string = p.telnyx_end_user_target ?? "";
      // A browser (widget) call has no phone number, only a SIP identity, even though its channel
      // reads phone_call: the caller id, not the channel, is what tells it apart.
      if (!caller.startsWith("+") && flags.web_calls_as_demo_caller === "on") caller = process.env.DEMO_CALLER_NUMBER ?? "";
      // An unsigned request gets the anonymous path: the call still works, but no booking data leaves.
      const left = () => BUDGET_MS - (Date.now() - t0);
      const booking: PssBooking | null = signed && caller ? await within(pss(env, trace, log).bookingByPhone(caller), left(), null) : null;
      const tripStub = booking ? env.TRIP.idFromName(booking.code) : null;
      const [t, flight] = await Promise.all([
        tripStub ? within(tripStub.startCall(trace) as Promise<TripState | null>, left(), null) : null,
        booking ? within(pss(env, trace, log).flight(booking.flight, booking.date), left(), null) : null,
        // Bind this conversation for the MCP server: who called, which booking caller ID found,
        // and link this turn's trace id to the conversation's (MCP may start on any turn).
        within(
          Promise.all([
            env.CALL.idFromName(trace).start(caller, booking?.code ?? ""),
            turnTrace && turnTrace !== trace ? env.CALL.idFromName(turnTrace).link(trace) : null,
          ]) as Promise<unknown>,
          left(),
          undefined,
        ),
      ]);
      const degraded = !!(signed && caller && (!booking || !flight || !t)) && Date.now() - t0 >= BUDGET_MS;
      const hold = t?.hold && t.hold.expiresAt > Date.now() ? t.hold : undefined;
      const offerFresh = !!(t?.offer && t.offer.expiresAt > Date.now() && t.callback?.placedAt);

      const flagVars: Record<string, string> = cfg
        ? { disruption_mode: flags.disruption_mode, incident_notice: flags.disruption_mode === "on" ? scenario?.notice ?? "" : "", human_queue: flags.human_queue, handoff: flags.handoff }
        : {};
      const vars: Record<string, string> = {
        trace_id: trace,
        channel,
        ...flagVars,
        caller_known: yes(!!booking),
        first_name: booking?.first_name ?? "",
        booking_code: booking?.code ?? "",
        booking_code_spelled: booking ? spell(booking.code) : "",
        pax_count: String(booking?.pax ?? ""),
        flight_spoken: flight ? `${spokenFlight(flight.number)} from ${AIRLINE.cities[flight.origin]} to ${AIRLINE.cities[flight.dest]} on ${spokenDate(flight.date)} at ${spokenTime(flight.dep)}` : "",
        flight_status: flight?.status ?? "",
        flight_disrupted: yes(flight?.status === "cancelled" || flight?.status === "delayed"),
        tier: booking?.tier ?? "none",
        special_assistance: yes(!!booking?.assistance),
        assistance_detail: booking?.assistance ?? "",
        case_status: t?.status ?? "none",
        has_active_hold: yes(!!hold),
        hold_minutes_left: hold ? String(Math.max(1, Math.round((hold.expiresAt - Date.now()) / 60000))) : "",
        hold_flight: hold ? hold.flightId : "",
        rebooked_confirmation: t?.rebookedTo ? spell(t.rebookedTo.confirmation) : "",
        callback_reason: offerFresh ? "seat_available" : "",
        opening_offer: openingOffer({
          name: booking?.first_name, city: flight ? AIRLINE.cities[flight.dest] : "", status: flight?.status, seatOffered: offerFresh,
          hold: hold?.flightId, rebooked: t?.rebookedTo ? spell(t.rebookedTo.confirmation) : "",
        }),
        calls_count: String(t?.calls ?? 0),
      };
      const ms = Date.now() - t0;
      log.span({ trace, op: "webhook", outcome: !signed ? "unsigned" : degraded ? "degraded" : "ok", ms, detail: `${channel} known=${vars.caller_known} status=${vars.flight_status}` });
      log.info("dv", { trace, channel, caller: maskPhone(caller), booking: vars.booking_code, signed, config: cfg ? "memory" : "assistant-defaults", disruption: flagVars.disruption_mode ?? "default", ms });
      if (!req.headers.get("x-canary")) env.METRICS.idFromName("global").callStarted({ trace, at: Date.now(), caller: maskPhone(caller), booking: vars.booking_code, last: "webhook", outcome: "in_progress" }).catch(() => {});
      return Response.json({ dynamic_variables: vars, conversation: { metadata: { trace_id: trace } } });
    } catch (e: any) {
      // Fail soft: an anonymous call is better than a dead line. The error is visible in logs,
      // the trace and the console's error tile.
      const trace = traceFrom(req.headers.get("traceparent"), `dv-${Date.now()}`);
      log.span({ trace, op: "webhook", outcome: "error", ms: Date.now() - t0, detail: String(e?.message ?? e).slice(0, 200) });
      return Response.json({
        // Flag variables are left out so the assistant's defaults (synced by desk-ops) apply.
        dynamic_variables: { trace_id: trace, caller_known: "false", special_assistance: "false", flight_disrupted: "false", has_active_hold: "false", tier: "none", case_status: "none", opening_offer: OFFER_ANYONE },
      });
    }
  },
};
