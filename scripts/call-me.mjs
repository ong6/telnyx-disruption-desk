#!/usr/bin/env node
// Place an outbound AI call from the desk's number to the demo caller (the account's verified
// number), so a person can test the voice path without dialling a US number.
// Usage: source scripts/env.sh && node scripts/call-me.mjs [mandarin]
const API = "https://api.telnyx.com/v2";
const H = { authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "content-type": "application/json" };
const kv = async (key) => (await fetch(`${API}/storage/kvs/22a353f3-671d-4118-87f3-04ba6a1070aa/keys/${encodeURIComponent(key)}`, { headers: H })).text();
const cfg = JSON.parse(await kv("config/outbound"));
const assistants = JSON.parse(await kv("config/assistants"));
const assistantId = process.argv[2] === "mandarin" ? assistants[1] : cfg.assistantId;
const res = await fetch(`${API}/texml/ai_calls/${cfg.texmlAppId}`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ From: cfg.from, To: process.env.DEMO_CALLER_NUMBER, AIAssistantId: assistantId }),
});
console.log(res.status, (await res.text()).slice(0, 400));
