import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserPreview } from "../app/lib/browser-preview.ts";

test("preview approval decisions update the queue and events, and reject duplicate decisions", async () => {
  const client = createBrowserPreview();
  const workspace = await client.request("workspace");
  const pending = workspace.orders.find((order) => order.status === "pending");
  assert.ok(pending);
  await client.request(`orders/${pending.id}`, "PATCH", { decision: "approved" });
  assert.equal((await client.request("workspace")).orders.find((order) => order.id === pending.id).status, "approved");
  assert.equal(client.events()[0].result, "approved");
  await assert.rejects(client.request(`orders/${pending.id}`, "PATCH", { decision: "approved" }), /no longer/);
});

test("saved agent permissions change simulated purchasing outcomes", async () => {
  const client = createBrowserPreview();
  const purchase = { agent_id: "inventory", items: [{ product_id: "AIMO-101", quantity: 1 }] };
  await assert.rejects(client.request("create_purchase_order", "POST", purchase), /permission/);
  assert.equal(client.events()[0].result, "blocked");
  const agent = client.agents().find((entry) => entry.id === "inventory");
  await client.request("agents/inventory", "PUT", { ...agent, permissions: ["search", "prepare", "purchase"], spending_limit_cents: 50000 });
  assert.equal((await client.request("create_purchase_order", "POST", purchase)).status, "auto_approved");
});

test("preview enforces paused agents, changed policies and shortages", async () => {
  const client = createBrowserPreview();
  const agent = client.agents()[0];
  await client.request("agents/kitchen", "PUT", { ...agent, status: "paused" });
  await assert.rejects(client.request("search_products?query=milk"), /paused/);
  await client.request("agents/kitchen", "PUT", agent);
  const workspace = await client.request("workspace");
  await client.request("guardrails", "PUT", { ...workspace.guardrails, max_auto_approve_cents: 0 });
  assert.equal((await client.request("create_purchase_order", "POST", { items: [{ product_id: "AIMO-101", quantity: 1 }] })).status, "pending");
  await assert.rejects(client.request("create_purchase_order", "POST", { items: [{ product_id: "AIMO-301", quantity: 9 }] }), /Only 8/);
});

test("independent previews keep orders and permissions isolated", async () => {
  const first = createBrowserPreview();
  const second = createBrowserPreview();
  await first.request("create_purchase_order", "POST", { items: [{ product_id: "AIMO-101", quantity: 1 }] });
  assert.equal((await first.request("workspace")).orders.length, 3);
  assert.equal((await second.request("workspace")).orders.length, 2);
});

test("planning and availability agree on reservations and release rejected orders", async () => {
  const client = createBrowserPreview();
  const plan = await client.request("plan_procurement?query=milk&target_volume_liters_or_kg=3000");
  const available = await client.request("check_availability?product_id=AIMO-101&quantity=3000");
  assert.equal(plan.options[0].available_packs, 3880);
  assert.equal(plan.options[0].available_packs, available.available_quantity);
  assert.equal(plan.options[0].can_fulfill_full_volume, true);
  const pending = (await client.request("workspace")).orders.find((order) => order.status === "pending");
  await client.request(`orders/${pending.id}`, "PATCH", { decision: "rejected" });
  assert.equal((await client.request("check_availability?product_id=AIMO-101&quantity=1")).available_quantity, 4880);
});
