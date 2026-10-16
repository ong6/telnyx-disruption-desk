#!/usr/bin/env node
// Creates or updates everything on the Telnyx side, idempotently by name: the MCP server, shared
// transfer and hangup tools, the Mandarin desk, the main Disruption Desk with its workflow, the
// phone number assignment, and the deploy settings (assistant ids, outbound-callback config) the
// Config actor holds, written through desk-ops.
// Usage: source scripts/env.sh && node assistant/build.mjs
import { buildFlow } from "./flow.mjs";

const API = "https://api.telnyx.com/v2";
const { TELNYX_API_KEY, HUMAN_DESK_NUMBER, DESK_NUMBER, DESK_ADMIN_TOKEN } = process.env;
const URLS = { mcp: "https://desk-mcp-299d7f49-1.telnyxcompute.com", dv: "https://desk-dv-da3c8445-f.telnyxcompute.com", ops: "https://desk-ops-68bad318-0.telnyxcompute.com" };
const VOICE_EN = "Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02";
const VOICE_ZH = "Telnyx.Ultra.6eb8965c-e295-47bd-a9e4-3eeebb3abcff"; // Jing - Clear Coordinator
const ALL_TOOLS = ["verify_booking", "get_trip_status", "find_dates", "find_flights", "hold_seats", "confirm_rebooking", "request_refund", "cancel_booking", "join_waitlist", "request_callback", "get_policy"];

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TELNYX_API_KEY}`, "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 1500)}`);
  const json = text ? JSON.parse(text) : {};
  return json.data ?? json;
}
const list = async (path) => {
  const d = await api("GET", path);
  return Array.isArray(d) ? d : d.data ?? [];
};

const BASE_INSTRUCTIONS = `You are the phone assistant for Nimbus Air, a Singapore airline. You help passengers whose flights are disrupted, and with simple questions on normal days.

What you can do for a caller: rebook them onto another date and time, cancel their flight, answer questions about their trip or our policies, or connect them with a person.

How you speak (this is a phone call):
- Short sentences. One question at a time. Offer at most three choices in one turn.
- Say flight numbers and codes letter by letter, using the "spelled" version a tool returns.
- Before a booking or lookup tool, say one short line first — "Let me check that for you" or "One moment." Never make it a question, never repeat it twice in a row.
- Only offer dates, flights and fees a tool returned. Policy answers only from get_policy. If a tool result has a "say" line, say it. If no tool answered, say our system is not reachable right now and offer a colleague or a callback — never fill in a flight, time or price yourself.
- Before changing anything, say what will happen and get a clear yes. If a tool returns not_verified, call it again with the caller's booking_code and last_name (ask for them if you don't have them); that is never a system fault. If a tool fails, apologise in one sentence, call it once more, then offer a person or a callback. Never guess.
- If the caller asks for a person, don't argue: route them. Never say you only speak English; Chinese speakers are routed to the Chinese-speaking desk.

What our systems know about this call:
- Known caller: {{caller_known}}. Name: {{first_name}}. Booking: {{booking_code}} ({{pax_count}} passengers). Tier: {{tier}}.
- Their flight: {{flight_spoken}}. Status: {{flight_status}}.
- Case so far: {{case_status}}. Seat on hold: {{has_active_hold}} {{hold_flight}} ({{hold_minutes_left}} minutes left). Rebooked confirmation: {{rebooked_confirmation}}.
- Callback reason: {{callback_reason}}.
- Today's incident: {{incident_notice}}`;

const MANDARIN_INSTRUCTIONS = `LANGUAGE RULE: Always reply in Simplified Chinese (Mandarin), even though the earlier conversation and tool results are in English. Never reply in English.

你是 Nimbus Air（新加坡航空公司）的中文电话客服。转接已经完成：你就是中文服务台本身。绝不要说你正在转接或"请稍等接通中文服务"——直接用中文问候乘客并开始帮助。第一次回复请说：您好，这里是 Nimbus Air 中文服务，请问有什么可以帮您？请全程用简体中文普通话回答，语气亲切、句子简短，一次只问一个问题。

规则：
- 只提供工具返回的日期、航班和费用，绝不编造航班、时间、座位或费用。政策问题只根据 get_policy 回答。
- 改签：先用 find_dates 问乘客想改到哪一天（每次最多说三个日期），日期确定后再用 find_flights 提供当天的起飞时间（每次最多三个），乘客选好后用 hold_seats 保留座位，复述航班、日期、时间和改签费并取得明确同意后再调用 confirm_rebooking。改签费以工具返回的为准。
- 退款或取消：请为乘客转接人工服务。
- 更改任何预订前，先复述内容并取得乘客明确同意。
- 航班号和确认码请逐个字母、数字读出（使用工具返回的 spelled 字段，可用中文读数字）。
- 如果工具返回 not_verified，先请乘客提供六位订位代码和姓氏，再调用 verify_booking。
- 乘客要求人工服务时，使用转接工具。

来电信息：已识别乘客：{{caller_known}}；姓名：{{first_name}}；订位代码：{{booking_code}}；航班：{{flight_spoken}}；状态：{{flight_status}}；今日事件：{{incident_notice}}。`;

const DEFAULT_VARS = {
  trace_id: "", caller_known: "false", first_name: "", booking_code: "", pax_count: "", flight_spoken: "", flight_status: "",
  disruption_mode: "off", incident_notice: "", flight_disrupted: "false", tier: "none", special_assistance: "false",
  human_queue: "open", handoff: "transfer", case_status: "none", has_active_hold: "false", hold_minutes_left: "", hold_flight: "",
  rebooked_confirmation: "", callback_reason: "", calls_count: "0",
  opening_offer: "I can rebook or cancel your flight, or connect you with a person. How can I help?", // desk-dv OFFER_ANYONE
};

async function upsertByName(listPath, createPath, updatePath, name, body, nameField = "name") {
  const existing = (await list(listPath)).find((x) => (x[nameField] ?? x.display_name) === name);
  if (existing) {
    const id = existing.id;
    return { ...(await api(updatePath.method, updatePath.path(id), body)), id };
  }
  return api("POST", createPath, body);
}

const ops = (path, body) =>
  fetch(`${URLS.ops}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${DESK_ADMIN_TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`ops ${path} -> ${r.status}`))));

async function main() {
  // Default variables carry the live flags too, so a late webhook still routes correctly. If the
  // console can't be read, keep the flags the live assistant already has rather than resetting
  // them to a normal day.
  const live = await ops("/api/state").catch(() => null);
  if (live?.flags) {
    const { flags, scenario } = live;
    Object.assign(DEFAULT_VARS, {
      disruption_mode: flags.disruption_mode ?? "off",
      human_queue: flags.human_queue ?? "open",
      handoff: flags.handoff ?? "transfer",
      incident_notice: flags.disruption_mode === "on" ? scenario?.notice ?? "" : "",
    });
  } else {
    const cur = (await list("/ai/assistants")).find((a) => a.name === "Nimbus Air Disruption Desk")?.dynamic_variables ?? {};
    for (const k of ["disruption_mode", "human_queue", "handoff", "incident_notice"]) if (k in cur) DEFAULT_VARS[k] = cur[k];
    console.warn("console unreadable: kept the live assistant's flags", DEFAULT_VARS.disruption_mode, DEFAULT_VARS.human_queue);
  }

  // 1. MCP server. Telnyx authenticates with a static bearer (integration secret); the server
  //    identifies the call from the W3C traceparent Telnyx sends (see desk-mcp/src/index.ts).
  const mcpBody = { name: "nimbus-desk-mcp", type: "http", url: `${URLS.mcp}/mcp`, api_key_ref: "desk_mcp_bearer", allowed_tools: ALL_TOOLS };
  const mcp = await upsertByName("/ai/mcp_servers", "/ai/mcp_servers", { method: "PUT", path: (id) => `/ai/mcp_servers/${id}` }, mcpBody.name, mcpBody);
  console.log("mcp server", mcp.id);

  // 2. Shared tools: one transfer (to the human desk) and one hangup, referenced by tool nodes.
  const transferBody = {
    type: "transfer", display_name: "transfer_to_agent",
    transfer: {
      targets: [{ name: "Nimbus Air reservations desk", to: HUMAN_DESK_NUMBER }],
      from: DESK_NUMBER,
      warm_transfer_instructions:
        "Before connecting, brief the agent in two sentences: the caller's name and booking code ({{first_name}}, {{booking_code}}), what happened to their flight, what you already tried, and what they want now.",
    },
  };
  const hangupBody = { type: "hangup", display_name: "hangup", hangup: { description: "End the call after saying goodbye." } };
  // The handoff gate's check: desk-ops answers 200 when a person can take the call, 409 when full.
  const queueBody = {
    type: "webhook", display_name: "check_human_queue", timeout_ms: 4000,
    webhook: { name: "check_human_queue", description: "Whether a person is free to take a transfer.", url: "https://desk-ops-68bad318-0.telnyxcompute.com/api/queue", method: "GET" },
  };
  const queue = await upsertByName("/ai/tools", "/ai/tools", { method: "PATCH", path: (id) => `/ai/tools/${id}` }, queueBody.display_name, queueBody, "display_name");
  const transfer = await upsertByName("/ai/tools", "/ai/tools", { method: "PATCH", path: (id) => `/ai/tools/${id}` }, transferBody.display_name, transferBody, "display_name");
  const hangup = await upsertByName("/ai/tools", "/ai/tools", { method: "PATCH", path: (id) => `/ai/tools/${id}` }, hangupBody.display_name, hangupBody, "display_name");
  console.log("tools", transfer.id, hangup.id);

  // 3. Secondary assistant: Mandarin desk (different persona, model, voice and speech-to-text).
  const zhBody = {
    name: "Nimbus Air Mandarin Desk",
    model: "moonshotai/Kimi-K2.6", // GLM-5.2 drifted into English after the handoff in testing
    instructions: MANDARIN_INSTRUCTIONS,
    greeting: "您好，这里是 Nimbus Air 中文服务。我已经看到您刚才的情况，请问需要我怎么帮您？",
    voice_settings: { voice: VOICE_ZH, language_boost: "Chinese" },
    transcription: { model: "azure/fast", language: "zh-CN" },
    dynamic_variables_webhook_url: `${URLS.dv}/`,
    dynamic_variables_webhook_timeout_ms: 8000,
    dynamic_variables: DEFAULT_VARS,
    // Refunds and cancellations move money: the main desk reads the verbatim refund-rights
    // statement first, so the Mandarin desk hands those to a person instead.
    mcp_servers: [{ id: mcp.id, allowed_tools: ALL_TOOLS.filter((t) => t !== "request_refund" && t !== "cancel_booking") }],
    tool_ids: [transfer.id, hangup.id],
    enabled_features: ["telephony"],
  };
  const zh = await upsertByName("/ai/assistants", "/ai/assistants", { method: "POST", path: (id) => `/ai/assistants/${id}` }, zhBody.name, zhBody);
  console.log("mandarin desk", zh.id);

  // 4. Main assistant with the workflow.
  const { flow, scope } = buildFlow({ transferToolId: transfer.id, hangupToolId: hangup.id, queueToolId: queue.id, mandarinAssistantId: zh.id });
  // Only shared tools can be scoped per node; MCP tools stay available on every node whatever
  // the tools_mode (DEBUGLOG #4). So the MCP server enforces the business rules itself (no
  // confirm without a live hold, no change without a verified booking).
  for (const node of flow.nodes) {
    if (node.type !== "prompt") continue;
    const needsMcp = (scope[node.id] ?? []).length > 0;
    node.tools_mode = needsMcp ? "append" : "replace";
    node.shared_tool_ids = node.id === "n_wrap" ? [hangup.id] : [];
  }
  const mainBody = {
    name: "Nimbus Air Disruption Desk",
    // GLM-5.3-Flash: measured 4.4-5.7 s per turn vs Kimi-K2.6's 5.7-7.1 s — on a call the caller
    // heard the Kimi turns as dead air (a real call hung long enough for "Hello? Are you still
    // there?"). The Mandarin desk keeps Kimi-K2.6: GLM drifted into English there (#5 in
    // DOGFOODING).
    model: "zai-org/GLM-5.3-Flash",
    instructions: BASE_INSTRUCTIONS,
    greeting: "",
    voice_settings: { voice: VOICE_EN },
    // deepgram/flux is a turn-taking model: these settings decide how fast the caller's turn
    // hands over. eager_eot_threshold below eot_threshold enables eager end-of-turn, so a
    // confident pause hands over sooner instead of waiting out the full threshold (the caller
    // heard the default as dead air). Revert eager to 0.8 if the demo feels jumpy.
    transcription: { model: "deepgram/flux", language: "en", settings: { eot_threshold: 0.8, eager_eot_threshold: 0.5, eot_timeout_ms: 5000 } },
    dynamic_variables_webhook_url: `${URLS.dv}/`,
    dynamic_variables_webhook_timeout_ms: 8000,
    dynamic_variables: DEFAULT_VARS,
    mcp_servers: [{ id: mcp.id, allowed_tools: ALL_TOOLS }],
    // No assistant-level shared tools: hangup is listed on wrap-up only, and transfer is reached
    // only through the tool nodes behind the handoff gate, so the model can't transfer around the
    // human-queue check.
    tool_ids: [],
    enabled_features: ["telephony"],
    telephony_settings: { supports_unauthenticated_web_calls: true, time_limit_secs: 900 },
    // The ops console embeds <telnyx-ai-agent>; it renders nothing until widget_settings exist.
    widget_settings: { theme: "dark", position: "static", default_state: "expanded", start_call_text: "Talk to the desk", agent_thinking_text: "Checking...", speak_to_interrupt_text: "Speak to interrupt" },
    // Callers can interrupt, including during the opening. disable_greeting_interruption was
    // tried during DEBUGLOG #20 and swallowed the caller's first words; it stays explicitly off
    // because an update that omits the field keeps the old value.
    interruption_settings: { enable: true, disable_greeting_interruption: false },
    conversation_flow: flow,
  };
  const main = await upsertByName("/ai/assistants", "/ai/assistants", { method: "POST", path: (id) => `/ai/assistants/${id}` }, mainBody.name, mainBody);
  console.log("disruption desk", main.id);
  console.log("node tool scope (MCP, enforced server-side):", JSON.stringify(scope));

  // 5. Phone number -> the assistant's TeXML app; outbound callback config for the Trip actor.
  const full = await api("GET", `/ai/assistants/${main.id}`);
  const texmlAppId = full.telephony_settings?.default_texml_app_id;
  const number = (await list("/phone_numbers")).find((p) => p.phone_number === DESK_NUMBER);
  if (texmlAppId && number && number.connection_id !== texmlAppId) {
    await api("PATCH", `/phone_numbers/${number.id}`, { connection_id: texmlAppId });
    console.log("number", DESK_NUMBER, "->", texmlAppId);
  }
  console.log("texml app", texmlAppId ?? "none yet (assign the number in the Portal once)");
  // Callbacks and transfers dial Singapore numbers; the default outbound profile allows US/CA only.
  if (texmlAppId) {
    const app = await api("GET", `/texml_applications/${texmlAppId}`);
    const ovp = app.outbound?.outbound_voice_profile_id;
    if (ovp) {
      const prof = await api("GET", `/outbound_voice_profiles/${ovp}`);
      const want = [...new Set([...(prof.whitelisted_destinations ?? []), "SG"])];
      if (want.length !== (prof.whitelisted_destinations ?? []).length) await api("PATCH", `/outbound_voice_profiles/${ovp}`, { whitelisted_destinations: want });
      console.log("outbound destinations", want.join(","));
    }
  }
  try {
    await ops("/api/settings", { assistants: [main.id, zh.id], ...(texmlAppId ? { outbound: { texmlAppId, from: DESK_NUMBER, assistantId: main.id } } : {}) });
  } catch (e) {
    console.warn("settings not written (the previous values stay):", e.message.slice(0, 120));
  }
  console.log("settings written; default flags", DEFAULT_VARS.disruption_mode, DEFAULT_VARS.human_queue);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
