// desk-dv: the dynamic-variables webhook. Telnyx calls it once at the start of every
// conversation (assistant.initialization). It recognises the caller, reads their case from the
// Trip actor, reads flags and the active incident from KV, and returns variables that both
// personalise the conversation and drive the workflow's variable-comparison edges. It also mints
// the per-call MCP credential.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readConfig } from "../../../shared/config";
import { makeLogger } from "../../../shared/log";
import { pss, type PssBooking } from "../../../shared/pss-client";
import { encryptForTelnyx, signClaims } from "../../../shared/token";
import type { TripState } from "../../../shared/types";
import { AIRLINE } from "../../../shared/seed";
import { maskPhone, spell, spokenDate, spokenFlight, spokenTime } from "../../../shared/util";

const TOKEN_TTL_MS = 2 * 3600_000;
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

export default {
  async fetch(req: Request, env: any): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health" || url.pathname.startsWith("/health/")) return new Response("ok");
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const log = makeLogger("dv", env);
    const t0 = Date.now();
    const raw = await req.text();
    const body = JSON.parse(raw || "{}");
    const p = body?.data?.payload ?? {};
    const channel: string = p.telnyx_conversation_channel ?? "unknown";
    const callId: string = p.call_control_id ?? p.telnyx_conversation_id ?? body?.data?.id ?? `${Date.now()}`;
    const trace = `c${createHash("sha1").update(callId).digest("hex").slice(0, 12)}`;
    const signed = signatureValid(req, raw);

    try {
      const { flags, scenario } = await readConfig(env);
      let caller: string = p.telnyx_end_user_target ?? "";
      if (!caller.startsWith("+") && channel !== "phone_call" && flags.web_calls_as_demo_caller === "on") caller = process.env.DEMO_CALLER_NUMBER ?? "";
      // An unsigned request gets the anonymous path: the call still works, but no booking data leaves.
      const booking: PssBooking | null = signed && caller ? await pss(env, trace, log).bookingByPhone(caller) : null;
      const tripStub = booking ? env.TRIP.idFromName(booking.code) : null;
      const [t, flight] = await Promise.all([
        tripStub ? (tripStub.startCall(trace) as Promise<TripState | null>) : null,
        booking ? pss(env, trace, log).flight(booking.flight, booking.date) : null,
      ]);
      const hold = t?.hold && t.hold.expiresAt > Date.now() ? t.hold : undefined;
      const offerFresh = !!(t?.offer && t.offer.expiresAt > Date.now() && t.callback?.placedAt);

      const vars: Record<string, string> = {
        trace_id: trace,
        channel,
        caller_known: yes(!!booking),
        first_name: booking?.first_name ?? "",
        booking_code: booking?.code ?? "",
        booking_code_spelled: booking ? spell(booking.code) : "",
        pax_count: String(booking?.pax ?? ""),
        flight_spoken: flight ? `${spokenFlight(flight.number)} from ${AIRLINE.cities[flight.origin]} to ${AIRLINE.cities[flight.dest]} on ${spokenDate(flight.date)} at ${spokenTime(flight.dep)}` : "",
        flight_status: flight?.status ?? "",
        disruption_mode: flags.disruption_mode,
        incident_notice: flags.disruption_mode === "on" ? scenario?.notice ?? "" : "",
        flight_disrupted: yes(flight?.status === "cancelled" || flight?.status === "delayed"),
        tier: booking?.tier ?? "none",
        special_assistance: yes(!!booking?.assistance),
        assistance_detail: booking?.assistance ?? "",
        human_queue: flags.human_queue,
        case_status: t?.status ?? "none",
        has_active_hold: yes(!!hold),
        hold_minutes_left: hold ? String(Math.max(1, Math.round((hold.expiresAt - Date.now()) / 60000))) : "",
        hold_flight: hold ? hold.flightId : "",
        rebooked_confirmation: t?.rebookedTo ? spell(t.rebookedTo.confirmation) : "",
        callback_reason: offerFresh ? "seat_available" : "",
        calls_count: String(t?.calls ?? 0),
      };
      const claims = { trace, caller, booking: booking?.code ?? "", exp: Date.now() + TOKEN_TTL_MS };
      const mcp_token = encryptForTelnyx(signClaims(claims, process.env.DESK_SIGNING_KEY ?? ""), process.env.DESK_ENC_KEY ?? "");

      const ms = Date.now() - t0;
      log.span({ trace, op: "webhook", outcome: signed ? "ok" : "unsigned", ms, detail: `${channel} known=${vars.caller_known} status=${vars.flight_status}` });
      log.info("dv", { trace, channel, caller: maskPhone(caller), booking: vars.booking_code, signed, disruption: flags.disruption_mode, ms });
      if (!req.headers.get("x-canary")) env.METRICS.idFromName("global").callStarted({ trace, at: Date.now(), caller: maskPhone(caller), booking: vars.booking_code, last: "webhook", outcome: "in_progress" }).catch(() => {});
      return Response.json({
        dynamic_variables: vars,
        encrypted_dynamic_variables: { mcp_token },
        conversation: { metadata: { trace_id: trace } },
      });
    } catch (e: any) {
      // Fail soft: an anonymous call is better than a dead line. The error is visible in logs,
      // the trace and the console's error tile.
      log.span({ trace, op: "webhook", outcome: "error", ms: Date.now() - t0, detail: String(e?.message ?? e).slice(0, 200) });
      const claims = { trace, caller: "", booking: "", exp: Date.now() + TOKEN_TTL_MS };
      return Response.json({
        dynamic_variables: { trace_id: trace, caller_known: "false", disruption_mode: "off", human_queue: "open", special_assistance: "false", flight_disrupted: "false", has_active_hold: "false", tier: "none", case_status: "none", incident_notice: "" },
        encrypted_dynamic_variables: { mcp_token: encryptForTelnyx(signClaims(claims, process.env.DESK_SIGNING_KEY ?? ""), process.env.DESK_ENC_KEY ?? "") },
      });
    }
  },
};
