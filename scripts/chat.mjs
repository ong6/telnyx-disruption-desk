#!/usr/bin/env node
// Text-chat with an assistant through the Assistants chat API: a fast way to walk a workflow
// path without a phone. Usage: node scripts/chat.mjs "<msg 1>" "<msg 2>" ...  (ASSISTANT_ID optional)
const API = "https://api.telnyx.com/v2";
const headers = { authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "content-type": "application/json" };
const assistantId = process.env.ASSISTANT_ID ?? "assistant-dbc59018-c2bb-437f-86bd-1030a9c5271b";
const conv = await (await fetch(`${API}/ai/conversations`, { method: "POST", headers, body: JSON.stringify({ name: `chat-test-${Date.now()}` }) })).json();
const conversationId = (conv.data ?? conv).id;
console.log(`conversation ${conversationId}`);
for (const content of process.argv.slice(2)) {
  const t0 = Date.now();
  const res = await fetch(`${API}/ai/assistants/${assistantId}/chat`, { method: "POST", headers, body: JSON.stringify({ content, conversation_id: conversationId }) });
  const body = await res.json();
  console.log(`\n> ${content}\n< ${body.content ?? JSON.stringify(body).slice(0, 400)}  (${Date.now() - t0} ms)`);
}
