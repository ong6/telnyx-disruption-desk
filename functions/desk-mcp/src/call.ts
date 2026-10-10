// One actor per phone call: which booking this call has verified and how many attempts failed.
// Per-call state with a read-modify-write counter, read on every tool call, so it needs to be
// fast and consistent: an actor, not KV (a KV read costs over a second from a function).
import { StatefulActor } from "@telnyx/edge-runtime";

export class CallSession extends StatefulActor {
  async get(): Promise<{ booking: string; fails: number }> {
    return { booking: (await this.ctx.storage.get<string>("booking")) ?? "", fails: (await this.ctx.storage.get<number>("fails")) ?? 0 };
  }
  async bind(booking: string) {
    await this.ctx.storage.put("booking", booking);
  }
  async fail(): Promise<number> {
    const fails = ((await this.ctx.storage.get<number>("fails")) ?? 0) + 1;
    await this.ctx.storage.put("fails", fails);
    return fails;
  }
}
