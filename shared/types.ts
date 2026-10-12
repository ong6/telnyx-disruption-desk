// Shapes shared by the three functions. Everything a tool or webhook returns is plain JSON.

export type FlightStatus = "scheduled" | "delayed" | "cancelled";

/** A flight as the airline's schedule describes it (seed data, not mutable state). */
export interface FlightDef {
  number: string; // "NB866"
  day: number; // days from the scenario's base date
  dep: string; // "14:30" local time at origin
  arr: string;
  from: string; // IATA
  to: string;
  capacity: number;
  sold: number; // seats already sold to other passengers
}

/** A booking in the airline's reservation system (seed data). */
export interface BookingDef {
  code: string; // booking reference, 6 characters
  firstName: string;
  lastName: string;
  phone: string; // E.164, or "$DEMO_CALLER" to be filled from config
  pax: number;
  flight: string; // flight number
  day: number;
  tier: "none" | "silver" | "gold" | "platinum";
  assistance?: string; // special assistance need, e.g. "wheelchair to the gate"
}

export interface Hold {
  id: string;
  booking: string;
  pax: number;
  expiresAt: number; // ms epoch
}

export interface FlightState {
  id: string; // "NB866-2026-10-11"
  number: string;
  date: string;
  dep: string;
  arr: string;
  from: string;
  to: string;
  status: FlightStatus;
  capacity: number;
  sold: number;
  holds: Record<string, Hold>;
  confirmed: Record<string, number>; // booking -> pax rebooked onto this flight
  waitlist: { booking: string; pax: number; at: number }[];
  offers: Record<string, string>; // booking -> holdId reserved for a waitlisted passenger
}

export interface FlightSnapshot {
  id: string;
  number: string;
  date: string;
  dep: string;
  arr: string;
  from: string;
  to: string;
  status: FlightStatus;
  capacity: number;
  seatsLeft: number;
  held: number;
  waitlist: number;
}

export type CaseStatus = "none" | "held" | "rebooked" | "refunded" | "cancelled" | "waitlisted" | "escalated";

export interface TripState {
  booking: BookingDef;
  date: string; // original flight date
  status: CaseStatus;
  hold?: { flightId: string; holdId: string; expiresAt: number };
  rebookedTo?: { flightId: string; confirmation: string };
  refund?: { reference: string };
  credit?: { reference: string }; // a voluntary cancellation keeps the fare as travel credit
  waitlist?: { flightId: string; at: number };
  offer?: { flightId: string; holdId: string; expiresAt: number };
  callback?: { reason: string; at: number; placedAt?: number; result?: string };
  verifyFailures: number;
  calls: number;
  lastTrace?: string;
  events: { at: number; ev: string; detail?: string }[];
}

/** Who an MCP request is acting for. The booking comes from the call's CallSession actor. */
export interface CallClaims {
  trace: string; // Telnyx's W3C trace id for this conversation
  caller: string; // E.164 of the caller, "" if unknown
  booking: string; // booking code the caller is verified for, "" if not yet verified
}
