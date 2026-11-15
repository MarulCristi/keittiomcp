import assert from "node:assert/strict";
import test from "node:test";
import { canCreateOrder, formatOrderItemCapacity, orderRequester, parseQuantity } from "../app/lib/purchasing.ts";

const available = {
  name: "Test product", available_quantity: 24, available: true, available_date: null,
  sales_unit: "carton", sales_block: false, unit_price_cents: 345, currency: "EUR",
};

test("order attribution distinguishes supplied agents and people without guessing missing identities", () => {
  assert.equal(orderRequester({ agent_name: "Kitchen Assistant" }), "Requested by Kitchen Assistant · Agent");
  assert.equal(orderRequester({ buyer_name: "Anna" }), "Requested by Anna · Person");
  assert.equal(orderRequester({ agent_id: "kitchen", buyer_name: "Anna" }), "Requested by agent kitchen");
  assert.equal(orderRequester({ agent_name: null, buyer_name: "  " }), "Requester not provided");
  assert.equal(orderRequester({}), "Requester not provided");
});

test("quantity rejects empty, fractional, negative, exponential and unsafe input", () => {
  for (const value of ["", "0", "-1", "1.5", "1e3", "Infinity", "10001", "9007199254740992"]) {
    assert.equal(parseQuantity(value), null, value);
  }
  assert.equal(parseQuantity("12"), 12);
});

test("a confirmed demo lookup permits submission only for its checked quantity", () => {
  assert.equal(canCreateOrder("demo", false, 12, 12, available), true);
  assert.equal(canCreateOrder("demo", false, 13, 12, available), false);
  assert.equal(canCreateOrder("demo", false, null, 12, available), false);
});

test("samples and disconnected workspaces block orders while supported Junction orders can proceed", () => {
  assert.equal(canCreateOrder("demo", true, 12, 12, available), false);
  assert.equal(canCreateOrder(undefined, false, 12, 12, available), false);
  assert.equal(canCreateOrder("junction", false, 12, 12, available), true);
});

test("unknown, blocked, unavailable and contradictory shortage results cannot enable orders", () => {
  for (const result of [null, { ...available, available: null }, { ...available, available: false }, { ...available, sales_block: true }, { ...available, available_quantity: 8 }]) {
    assert.equal(canCreateOrder("demo", false, 12, 12, result), false);
  }
});

test("unconfirmed currency or price cannot silently become a zero-cost EUR order", () => {
  for (const change of [{ currency: null }, { currency: "USD" }, { unit_price_cents: null }, { unit_price_cents: -1 }, { unit_price_cents: Number.NaN }, { unit_price_cents: Number.MAX_SAFE_INTEGER }]) {
    assert.equal(canCreateOrder("demo", false, 12, 12, { ...available, ...change }), false);
  }
});

test("formatOrderItemCapacity parses pack units into total capacity and per-unit labels", () => {
  assert.deepEqual(formatOrderItemCapacity(200, "Case/KI (5 L)"), { totalLabel: "1,000 L", perPackLabel: "5 L/unit" });
  assert.deepEqual(formatOrderItemCapacity(80, "Tub/RAS (250 g)"), { totalLabel: "20 kg", perPackLabel: "0.25 kg/unit" });
  assert.deepEqual(formatOrderItemCapacity(12, "1 L carton"), { totalLabel: "12 L", perPackLabel: "1 L/unit" });
  assert.deepEqual(formatOrderItemCapacity(4, "Case"), { totalLabel: null, perPackLabel: null });
});
