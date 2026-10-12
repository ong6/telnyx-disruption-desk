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

test("rebooking asks for the date before the time, and every prompt node is scoped", () => {
  const rebook = flow.nodes.find((n: any) => n.id === "n_rebook").instructions as string;
  assert.ok(rebook.indexOf("find_dates") < rebook.indexOf("find_flights"));
  for (const node of flow.nodes.filter((n: any) => n.type === "prompt")) assert.ok(node.id in scope, node.id);
  assert.equal(flow.nodes.find((n: any) => n.id === flow.start_node_id).type, "speak");
});
