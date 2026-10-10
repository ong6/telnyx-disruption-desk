// One actor per conversation, keyed by Telnyx's W3C trace id. The webhook binds who is calling
// (caller number, booking found by caller ID); the MCP server reads it on every tool call to
// know whose booking it may act on, without trusting anything the model says. Also holds the
// verification attempt counter: read-modify-write, so an actor, not KV.
import { StatefulActor } from "@telnyx/edge-runtime";

export interface CallBinding { caller: string; booking: string; fails: number; at: number; canonical?: string }

export class CallSession extends StatefulActor {
  async get(): Promise<CallBinding> {
    return (await this.ctx.storage.get<CallBinding>("s")) ?? { caller: "", booking: "", fails: 0, at: 0 };
  }
  /** Called by the webhook at the start of the conversation. */
  async start(caller: string, booking: string): Promise<void> {
    const s = await this.get();
    await this.ctx.storage.put("s", { ...s, caller, booking: booking || s.booking, at: Date.now() });
  }
  /**
   * Telnyx starts a new W3C trace per turn and opens the MCP session on whichever turn first
   * reaches a node with MCP tools. The webhook links every turn's trace id to the conversation's
   * first one, so MCP requests can find the conversation from their own traceparent.
   */
  async link(canonical: string): Promise<void> {
    const s = await this.get();
    await this.ctx.storage.put("s", { ...s, canonical, at: Date.now() });
  }
  /** Called by verify_booking once an unrecognised caller proves the booking. */
  async bind(booking: string): Promise<void> {
    const s = await this.get();
    await this.ctx.storage.put("s", { ...s, booking });
  }
  async fail(): Promise<number> {
    const s = await this.get();
    await this.ctx.storage.put("s", { ...s, fails: s.fails + 1 });
    return s.fails + 1;
  }
}
