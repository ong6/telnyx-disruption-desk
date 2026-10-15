import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: plain ES module without types
import { buildFlow, EDGE_ID } from "../assistant/flow.mjs";

const { flow, scope } = buildFlow({ transferToolId: "t", hangupToolId: "h", queueToolId: "q", mandarinAssistantId: "assistant-7b3cda63-812a-47b3-8509-1dc9db898dcd" });
const nodeIds = new Set(flow.nodes.map((n: any) => n.id));

test("every edge id is a valid transition tool name on calls", () => {
  // On calls each LLM edge becomes a tool named transition__<edge id>. An id with a colon, over
  // 64 characters with the prefix, made every voice turn fail while chat kept passing (DEBUGLOG #21).
  for (const e of flow.edges) assert.match(e.id, EDGE_ID, e.id);
  assert.equal(new Set(flow.edges.map((e: any) => e.id)).size, flow.edges.length, "edge ids are unique");
});

test("edges connect real nodes, and speak and tool nodes have exactly one default edge", () => {
  for (const e of flow.edges) {
    assert.ok(nodeIds.has(e.start_node_id), e.id);
    if (e.target.type === "node") assert.ok(nodeIds.has(e.target.node_id), e.id);
  }
  for (const node of flow.nodes.filter((n: any) => n.type !== "prompt")) {
    const out = flow.edges.filter((e: any) => e.start_node_id === node.id);
    if (out.length) assert.equal(out.filter((e: any) => e.condition.type === "default").length, 1, node.id);
  }
  assert.ok(flow.edges.filter((e: any) => e.condition.type === "default").every((e: any) => flow.nodes.find((n: any) => n.id === e.start_node_id).type !== "prompt"));
});

test("the handoff flag routes handoffs to a person or to the demo end-call", () => {
  // A demo line can't ring a real agent: end_call takes every handoff to n_demo_end, which plays
  // the handoff line and hangs up. An unset handoff variable matches neither side and the gate's
  // default edge offers a callback instead.
  const handoff = (e: any) => e.condition.expression?.operands?.find((o: any) => o.left?.name === "handoff")?.right?.value;
  const gate = flow.edges.filter((e: any) => e.start_node_id === "n_handoff_gate");
  const demoEnd = gate.filter((e: any) => e.target.node_id === "n_demo_end");
  const human = gate.filter((e: any) => e.target.node_id === "n_human");
  assert.equal(demoEnd.length, 2); // string status on calls, number in chat
  assert.equal(human.length, 2);
  for (const e of demoEnd) assert.equal(handoff(e), "end_call", e.id);
  for (const e of human) assert.equal(handoff(e), "transfer", e.id);
  const specialist = flow.edges.filter((e: any) => e.start_node_id === "n_triage" && ["n_specialist", "n_demo_end"].includes(e.target.node_id));
  assert.equal(specialist.length, 2);
  for (const e of specialist) assert.equal(handoff(e), e.target.node_id === "n_demo_end" ? "end_call" : "transfer", e.id);
});

test("rebooking asks for the date before the time, and every prompt node is scoped", () => {
  const rebook = flow.nodes.find((n: any) => n.id === "n_rebook").instructions as string;
  assert.ok(rebook.indexOf("find_dates") < rebook.indexOf("find_flights"));
  for (const node of flow.nodes.filter((n: any) => n.type === "prompt")) assert.ok(node.id in scope, node.id);
  assert.equal(flow.nodes.find((n: any) => n.id === flow.start_node_id).type, "speak");
});
