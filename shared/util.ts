import { randomBytes } from "node:crypto";

const NATO: Record<string, string> = {
  A: "Alpha", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo", F: "Foxtrot", G: "Golf", H: "Hotel", I: "India",
  J: "Juliett", K: "Kilo", L: "Lima", M: "Mike", N: "November", O: "Oscar", P: "Papa", Q: "Quebec", R: "Romeo",
  S: "Sierra", T: "Tango", U: "Uniform", V: "Victor", W: "Whiskey", X: "X-ray", Y: "Yankee", Z: "Zulu",
  "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
};

/** "K7Q" -> "Kilo, seven, Quebec": codes read aloud must survive a phone line. */
export const spell = (code: string) => code.toUpperCase().split("").map((c) => NATO[c] ?? c).join(", ");

/** Codes avoid 0/O and 1/I so a caller can't mishear them. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const newCode = (n = 6) => Array.from(randomBytes(n), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
export const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;

/** "+6591234567" -> "+65****4567" for logs and the console. */
export const maskPhone = (p: string) => (p && p.length > 6 ? `${p.slice(0, 3)}****${p.slice(-4)}` : p ? "****" : "");

/** Calendar date in Singapore, offset by whole days. */
export const sgDate = (offsetDays = 0, from = Date.now()) =>
  new Date(from + 8 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);

export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);

/** Departure instant (ms) for a date + local SGT time. */
export const departsAt = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+08:00`);

export const flightId = (number: string, date: string) => `${number}-${date}`;

/** "2026-10-11" -> "Sunday the 11th of October" for speech. */
export function spokenDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const day = d.getUTCDate();
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const month = d.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  return `${weekday} the ${day}${suffix} of ${month}`;
}

/** spokenDate, prefixed "today, " or "tomorrow, " when it is, so a caller can answer "tomorrow". */
export function spokenDay(date: string, today: string): string {
  const rel = date === today ? "today, " : date === addDays(today, 1) ? "tomorrow, " : "";
  return `${rel}${spokenDate(date)}`;
}

/** "14:30" -> "2:30 PM" */
export function spokenTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/** Spoken flight number: "NB866" -> "N B eight six six" is how agents read it. */
export const spokenFlight = (n: string) => `${n.slice(0, 2).split("").join(" ")} ${n.slice(2).split("").join(" ")}`;

/** Telnyx's W3C trace id ("00-<32 hex>-<16 hex>-01" -> the 32 hex), or the fallback. */
export const traceFrom = (traceparent: string | null, fallback: string) => {
  const id = (traceparent ?? "").split("-")[1] ?? "";
  return /^[0-9a-f]{32}$/.test(id) ? id : fallback;
};
