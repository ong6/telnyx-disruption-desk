// desk-pss: a stand-in for the airline's reservation system (bookings and schedule) in a SQL
// database, behind a REST API with a partner key. The voice stack treats it as a system it
// doesn't own: it reads through a KV cache, keeps live seat holds in actors during a surge, and
// writes back only confirmed changes. LEGACY_LATENCY_MS (env var, default 0) can make it as slow
// as a real one for load tests.
import { BOOKINGS, FLIGHTS, INCIDENTS, RELIEF_FLIGHT } from "../../../shared/seed";
import { makeLogger } from "../../../shared/log";
import { addDays, newCode } from "../../../shared/util";
import type { FlightDef } from "../../../shared/types";

const LEGACY_LATENCY_MS = Number(process.env.LEGACY_LATENCY_MS ?? 0);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS flights (number TEXT NOT NULL, date TEXT NOT NULL, dep TEXT, arr TEXT, origin TEXT, dest TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled', capacity INTEGER, sold INTEGER, PRIMARY KEY (number, date));
CREATE TABLE IF NOT EXISTS bookings (code TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, phone TEXT, pax INTEGER,
  flight TEXT, date TEXT, tier TEXT, assistance TEXT, status TEXT NOT NULL DEFAULT 'confirmed', new_flight TEXT,
  new_date TEXT, confirmation TEXT, refund_ref TEXT, updated_at INTEGER);
CREATE INDEX IF NOT EXISTS bookings_phone ON bookings (phone);
CREATE TABLE IF NOT EXISTS changes (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, at INTEGER, kind TEXT, detail TEXT);`;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default {
  async fetch(req: Request, env: any): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/health" || path.startsWith("/health/")) return new Response("ok");
    const trace = req.headers.get("x-trace-id") ?? "";
    const log = makeLogger("pss", env);
    const t0 = Date.now();
    if (req.headers.get("authorization") !== `Bearer ${process.env.PSS_API_KEY}`) return json({ error: "unauthorized" }, 401);
    try {
      if (LEGACY_LATENCY_MS) await sleep(LEGACY_LATENCY_MS);
      const res = await route(req, url, env);
      log.info("request", { trace, method: req.method, path, status: res.status, ms: Date.now() - t0 });
      return res;
    } catch (e: any) {
      log.error("request", { trace, method: req.method, path, err: String(e?.message ?? e), ms: Date.now() - t0 });
      return json({ error: String(e?.message ?? e) }, 500);
    }
  },
};

async function route(req: Request, url: URL, env: any): Promise<Response> {
  const db = env.DB;
  const parts = url.pathname.split("/").filter(Boolean); // ["v1", "bookings", code, action]
  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as any) : {};

  if (url.pathname === "/v1/admin/reset" && req.method === "POST") return json(await reset(db, body));
  if (url.pathname === "/v1/admin/flights" && req.method === "POST") {
    const f: FlightDef = { ...RELIEF_FLIGHT, ...body.flight };
    const date = addDays(body.baseDate, f.day);
    await db.prepare("INSERT OR REPLACE INTO flights VALUES (?,?,?,?,?,?, 'scheduled', ?, ?)").bind(f.number, date, f.dep, f.arr, f.from, f.to, f.capacity, f.sold).run();
    return json(await db.prepare("SELECT * FROM flights WHERE number = ? AND date = ?").bind(f.number, date).first());
  }

  if (parts[1] === "bookings" && !parts[2] && req.method === "GET") {
    const phone = url.searchParams.get("phone") ?? "";
    const row = await db.prepare("SELECT * FROM bookings WHERE phone = ? ORDER BY date LIMIT 1").bind(phone).first();
    return row ? json(row) : json({ error: "not found" }, 404);
  }
  if (parts[1] === "bookings" && parts[2]) {
    const code = parts[2].toUpperCase();
    const booking: any = await db.prepare("SELECT * FROM bookings WHERE code = ?").bind(code).first();
    if (!booking) return json({ error: "not found" }, 404);
    if (!parts[3] && req.method === "GET") return json(booking);
    if (parts[3] === "changes") return json((await db.prepare("SELECT * FROM changes WHERE code = ? ORDER BY id").bind(code).all()).results);
    if (parts[3] === "rebook" && req.method === "POST") {
      const now = Date.now();
      // The rebooking and its audit row commit together or not at all.
      const [updated] = await db.batch([
        db.prepare("UPDATE bookings SET status = 'rebooked', new_flight = ?, new_date = ?, confirmation = ?, updated_at = ? WHERE code = ? RETURNING *")
          .bind(body.flight, body.date, body.confirmation, now, code),
        db.prepare("INSERT INTO changes (code, at, kind, detail) VALUES (?, ?, 'rebook', ?)").bind(code, now, `${body.flight} ${body.date} ${body.confirmation}`),
      ]);
      return json(updated.results[0]);
    }
    if (parts[3] === "refund" && req.method === "POST") {
      const ref = `RF${newCode(5)}`;
      const now = Date.now();
      await db.batch([
        db.prepare("UPDATE bookings SET status = 'refunded', refund_ref = ?, updated_at = ? WHERE code = ?").bind(ref, now, code),
        db.prepare("INSERT INTO changes (code, at, kind, detail) VALUES (?, ?, 'refund', ?)").bind(code, now, String(body.reason ?? "")),
      ]);
      return json({ refund_ref: ref });
    }
  }

  if (parts[1] === "flights" && parts[2] && parts[3]) {
    const row = await db.prepare("SELECT * FROM flights WHERE number = ? AND date = ?").bind(parts[2], parts[3]).first();
    return row ? json(row) : json({ error: "not found" }, 404);
  }
  if (parts[1] === "flights") {
    const q = url.searchParams;
    const rows = await db
      .prepare("SELECT * FROM flights WHERE origin = ? AND dest = ? AND date BETWEEN ? AND ? ORDER BY date, dep")
      .bind(q.get("origin"), q.get("dest"), q.get("from"), q.get("to"))
      .all();
    return json(rows.results);
  }
  return json({ error: "no route" }, 404);
}

/** Rebuild the reservation system for a scenario: seed schedule and bookings, dated from baseDate. */
async function reset(db: any, body: { scenario?: string; baseDate: string; demoCaller?: string }) {
  await db.exec(SCHEMA);
  const incident = body.scenario ? INCIDENTS[body.scenario] : undefined;
  const cancelled = new Set((incident?.cancels ?? []).map((c) => `${c.flight}-${addDays(body.baseDate, c.day)}`));
  const stmts = [db.prepare("DELETE FROM flights"), db.prepare("DELETE FROM bookings"), db.prepare("DELETE FROM changes")];
  for (const f of FLIGHTS) {
    const date = addDays(body.baseDate, f.day);
    const status = cancelled.has(`${f.number}-${date}`) ? "cancelled" : "scheduled";
    stmts.push(db.prepare("INSERT INTO flights VALUES (?,?,?,?,?,?,?,?,?)").bind(f.number, date, f.dep, f.arr, f.from, f.to, status, f.capacity, f.sold));
  }
  for (const b of BOOKINGS) {
    const phone = b.phone === "$DEMO_CALLER" ? body.demoCaller ?? process.env.DEMO_CALLER_NUMBER ?? "" : b.phone;
    stmts.push(
      db.prepare("INSERT INTO bookings (code, first_name, last_name, phone, pax, flight, date, tier, assistance, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(b.code, b.firstName, b.lastName, phone, b.pax, b.flight, addDays(body.baseDate, b.day), b.tier, b.assistance ?? null, Date.now()),
    );
  }
  await db.batch(stmts);
  return { ok: true, flights: FLIGHTS.length, bookings: BOOKINGS.length, cancelled: [...cancelled] };
}
