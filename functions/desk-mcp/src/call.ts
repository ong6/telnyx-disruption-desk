// One actor per conversation, keyed by Telnyx's W3C trace id. The webhook binds who is calling
// (caller number, booking found by caller ID); the MCP server reads it on every tool call to
// know whose booking it may act on, without trusting anything the model says. Also holds the
// verification attempt counter: read-modify-write, so an actor, not KV.
import { StatefulActor } from "@telnyx/edge-runtime";

export const MAX_VERIFY_ATTEMPTS = 3;
// A conversation lives minutes; the trace link only needs to outlive it a little. The alarm
// clears the actor so per-turn chat traces and MCP session keys don't pile up forever.
const TTL_MS = 2 * 60 * 60 * 1000;

export interface CallBinding { caller: string; booking: string; fails: number; at: number; canonical?: string; lastFail?: string }

export class CallSession extends StatefulActor {
  async get(): Promise<CallBinding> {
    return (await this.ctx.storage.get<CallBinding>("s")) ?? { caller: "", booking: "", fails: 0, at: 0 };
  }
  /**
   * Called by the webhook at the start of the conversation. On a call that is once; in chat it
   * runs every turn, so a booking found by caller ID must never overwrite one the caller proved
   * with verify_booking earlier in the same conversation (a refund once landed on the caller's
   * own booking that way — DEBUGLOG #15). The verified binding wins.
   */
  async start(caller: string, booking: string): Promise<void> {
    const s = await this.get();
    await this.ctx.storage.put("s", { ...s, caller, booking: s.booking || booking, at: Date.now() });
    await this.arm();
  }
  /**
   * Telnyx starts a new W3C trace per turn and opens the MCP session on whichever turn first
   * reaches a node with MCP tools. The webhook links every turn's trace id to the conversation's
   * first one, so MCP requests can find the conversation from their own traceparent.
   */
  async link(canonical: string): Promise<void> {
    const s = await this.get();
    await this.ctx.storage.put("s", { ...s, canonical, at: Date.now() });
    await this.arm();
  }
  /** Called by verify_booking once an unrecognised caller proves the booking. */
  async bind(booking: string): Promise<void> {
    const s = await this.get();
    await this.ctx.storage.put("s", { ...s, booking, at: Date.now() });
    await this.arm();
  }
  /** Count one failed verification; the actor is single-threaded, so the counter is exact.
   *  `key` is the code and name tried: the same pair again is the same attempt, delivered twice
   *  (DEBUGLOG #22). Returns the attempts left (0 means locked out for this conversation). */
  async fail(key = ""): Promise<{ left: number; counted: boolean }> {
    const s = await this.get();
    if (key && s.lastFail === key) return { left: Math.max(0, MAX_VERIFY_ATTEMPTS - s.fails), counted: false };
    const fails = s.fails + 1;
    await this.ctx.storage.put("s", { ...s, fails, lastFail: key, at: Date.now() });
    await this.arm();
    return { left: Math.max(0, MAX_VERIFY_ATTEMPTS - fails), counted: true };
  }
  /** How many attempts are left before the lockout, without counting one. */
  async attemptsLeft(): Promise<number> {
    return Math.max(0, MAX_VERIFY_ATTEMPTS - (await this.get()).fails);
  }
  private async arm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
  }
  async alarm(): Promise<void> {
    const s = await this.get();
    if (Date.now() - (s.at ?? 0) < TTL_MS) {
      await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
      return;
    }
    await this.ctx.storage.deleteAll();
  }
}
