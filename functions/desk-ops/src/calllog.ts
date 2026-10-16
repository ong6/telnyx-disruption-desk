// The call log: every conversation the desk has had, read from Telnyx's own conversation history,
// which keeps each call's transcript and tool calls for as long as the account does. Our trace
// spans live a day in KV and, on a browser call, split across per-turn traces (DEBUGLOG #27);
// Telnyx's record is whole, and its metadata carries the webhook's trace id, so the two join.
import { maskPhone } from "../../../shared/util";
import { readSetting } from "../../../shared/config";

const API = "https://api.telnyx.com/v2";
const headers = () => ({ authorization: `Bearer ${process.env.DESK_TELNYX_KEY}` });

export interface CallLogRow {
  id: string;
  trace: string;
  at: number;
  last: number;
  channel: "phone" | "web" | "chat";
  caller: string;
  desk: string;
  tools: string[];
}
export interface CallLogLine {
  at: number;
  who: "caller" | "desk" | "tool" | "system";
  text: string;
}

const memo = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  memo.set(key, { at: Date.now(), value });
  return value;
}

async function telnyx(path: string): Promise<any[]> {
  const res = await fetch(`${API}${path}`, { headers: headers(), signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`telnyx ${path.split("?")[0]} -> ${res.status}`);
  const body: any = await res.json();
  return Array.isArray(body.data) ? body.data : [];
}

/** The last `limit` conversations of the desk's assistants (main and Mandarin), newest first. */
export async function callLog(env: any, limit = 50): Promise<CallLogRow[]> {
  return cached(`log:${limit}`, 3_000, async () => {
    const ids = (await readSetting<string[]>(env, "assistants")) ?? [];
    const names = ["Disruption Desk", "Mandarin Desk"];
    const lists = await Promise.all(
      ids.map((id, i) =>
        telnyx(`/ai/conversations?metadata->assistant_id=eq.${encodeURIComponent(id)}&order=created_at.desc&limit=${limit}`).then((cs) => cs.map((c) => ({ c, desk: names[i] ?? "desk" }))),
      ),
    );
    return lists
      .flat()
      .map(({ c, desk }) => {
        const m = c.metadata ?? {};
        const from = String(m.telnyx_end_user_target ?? m.from ?? "");
        const channel: CallLogRow["channel"] = m.telnyx_conversation_channel === "web_chat" ? "chat" : from.startsWith("+") ? "phone" : "web";
        return {
          id: c.id,
          trace: String(m.trace_id ?? ""),
          at: Date.parse(c.created_at),
          last: Date.parse(c.last_message_at ?? c.created_at),
          channel,
          caller: from.startsWith("+") ? maskPhone(from) : "",
          desk,
          tools: Array.isArray(m.called_tools) ? m.called_tools : [],
        };
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  });
}

/** One conversation as lines: what the caller said, what the desk said, each tool call and its result. */
export async function callTranscript(id: string): Promise<CallLogLine[]> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("bad id");
  return cached(`tx:${id}`, 2_000, async () => {
    const msgs = (await telnyx(`/ai/conversations/${id}/messages?page%5Bsize%5D=200`)).slice().reverse();
    const lines: CallLogLine[] = [];
    for (const m of msgs) {
      const at = Date.parse(m.sent_at ?? m.created_at ?? "") || 0;
      const text = String(m.text ?? "").trim();
      if (m.role === "user" && text) lines.push({ at, who: "caller", text });
      else if (m.role === "assistant") {
        if (text) lines.push({ at, who: "desk", text });
        for (const t of m.tool_calls ?? []) lines.push({ at, who: "tool", text: `→ ${t.function?.name ?? "tool"}(${redact(t.function?.arguments)})` });
      } else if (m.role === "tool") lines.push({ at, who: "tool", text: `← ${text.slice(0, 300)}` });
      else if (text) lines.push({ at, who: "system", text });
    }
    return lines;
  });
}

/** Tool arguments with the two verification factors hidden, as in trace spans. */
function redact(raw: unknown): string {
  try {
    const args = typeof raw === "string" ? JSON.parse(raw || "{}") : raw ?? {};
    return Object.entries(args)
      .map(([k, v]) => `${k}: ${/code|last_name/i.test(k) && v ? "•••" : JSON.stringify(v)}`)
      .join(", ");
  } catch {
    return "";
  }
}
