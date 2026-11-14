import type { ApiClient, Allergen, Availability, Guardrails, Order, Product } from "./purchasing";

export type Agent = {
  id: string;
  name: string;
  status: "connected" | "paused";
  permissions: ("search" | "prepare" | "purchase")[];
  spending_limit_cents: number;
  last_active: string | null;
};
export type ActivityEvent = {
  id: string;
  agent_name: string;
  action: string;
  result: "completed" | "pending" | "approved" | "rejected" | "blocked";
  detail: string;
  timestamp: string;
  order_id?: string;
};
type CatalogProduct = Product & { volume: number; category: string };
type Line = { product_id: string; quantity: number; is_substitution?: boolean; substituted_for?: string };
type OrderRequest = { items: Line[]; agent_id?: string; requested_date?: string | null };

const catalog: CatalogProduct[] = [
  { product_id: "AIMO-101", name: "Lactose-free milk", unit: "1 L carton", volume: 1, category: "milk", unit_price_cents: 125, stock: 5000, allergens: ["milk"], dietary_claims: ["Lactose-free"], delivery_reliability: 0.99, sustainability_labels: ["Illustrative origin label"] },
  { product_id: "AIMO-102", name: "Mozzarella", unit: "1 kg pack", volume: 1, category: "cheese", unit_price_cents: 400, stock: 200, allergens: ["milk"], dietary_claims: [], delivery_reliability: 0.97, sustainability_labels: [] },
  { product_id: "AIMO-201", name: "Lactose-free cooking cream", unit: "1 L carton", volume: 1, category: "cream", unit_price_cents: 345, stock: 24, allergens: ["milk"], dietary_claims: ["Lactose-free"], delivery_reliability: 0.98, sustainability_labels: [] },
  { product_id: "AIMO-202", name: "Oat cooking alternative", unit: "1 L carton", volume: 1, category: "cream", unit_price_cents: 295, stock: 80, allergens: ["gluten"], dietary_claims: ["Plant-based"], delivery_reliability: 0.94, sustainability_labels: [] },
  { product_id: "AIMO-301", name: "Cooking cream", unit: "1 L carton", volume: 1, category: "cream", unit_price_cents: 310, stock: 8, allergens: ["milk"], dietary_claims: [], delivery_reliability: 0.86, sustainability_labels: [] },
];

// In-memory fixture adapter. Every request stays in this module; it never calls fetch.
// Production permission enforcement remains the service's responsibility.
export function createBrowserPreview() {
  let guardrails: Guardrails = { max_auto_approve_cents: 50000, review_allergens: ["nuts", "gluten"], min_delivery_reliability: 0.9, require_approval_on_substitution: true };
  let agents: Agent[] = [
    { id: "kitchen", name: "Kitchen Assistant", status: "connected", permissions: ["search", "prepare", "purchase"], spending_limit_cents: 50000, last_active: null },
    { id: "inventory", name: "Inventory Agent", status: "connected", permissions: ["search", "prepare"], spending_limit_cents: 0, last_active: null },
    { id: "purchasing", name: "Purchasing Assistant", status: "connected", permissions: ["search", "prepare", "purchase"], spending_limit_cents: 200000, last_active: null },
  ];
  let orders: Order[] = [];
  const events: ActivityEvent[] = [];
  let sequence = 1041;

  function record(agent: Agent, action: string, result: ActivityEvent["result"], detail: string, orderId?: string) {
    const timestamp = new Date().toISOString();
    agent.last_active = timestamp;
    events.unshift({ id: `event-${events.length + 1}`, agent_name: agent.name, action, result, detail, timestamp, order_id: orderId });
  }
  function actor(id = "kitchen") {
    const agent = agents.find((entry) => entry.id === id);
    if (!agent) throw new Error("Unknown preview agent.");
    return agent;
  }
  function product(id: string) {
    const found = catalog.find((entry) => entry.product_id === id);
    if (!found) throw new Error("Product was not found in the preview catalog.");
    return found;
  }
  function stock(item: CatalogProduct) {
    const reserved = orders.filter((order) => order.status !== "rejected")
      .flatMap((order) => order.items).filter((line) => line.product_id === item.product_id)
      .reduce((sum, line) => sum + line.quantity, 0);
    return Math.max(0, (item.stock ?? 0) - reserved);
  }
  function deny(agent: Agent, message: string): never {
    record(agent, "Attempted purchase", "blocked", message);
    throw new Error(message);
  }
  function createOrder(body: OrderRequest) {
    const agent = actor(body.agent_id);
    if (agent.status === "paused") return deny(agent, "This agent is paused.");
    if (!agent.permissions.includes("purchase")) return deny(agent, "Purchase permission is disabled for this agent.");
    if (!body.items?.length) throw new Error("Choose at least one product.");
    const totals = new Map<string, number>();
    for (const line of body.items) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 10000) throw new Error("Quantity must be between 1 and 10,000.");
      totals.set(line.product_id, (totals.get(line.product_id) ?? 0) + line.quantity);
    }
    for (const [id, quantity] of totals) {
      const item = product(id);
      if (quantity > stock(item)) return deny(agent, `Only ${stock(item)} sales units of ${item.name} are available.`);
    }
    const reasons: string[] = [];
    const items = body.items.map((line) => {
      const item = product(line.product_id);
      if (line.is_substitution && guardrails.require_approval_on_substitution) reasons.push(`Substitution for ${line.substituted_for ?? "the original product"} needs review.`);
      if (item.delivery_reliability != null && item.delivery_reliability < (guardrails.min_delivery_reliability ?? 0)) reasons.push(`${item.name} is below the delivery reliability threshold.`);
      for (const allergen of item.allergens ?? []) {
        if (guardrails.review_allergens.includes(allergen)) reasons.push(`Contains ${allergen}.`);
      }
      return { ...line, name: item.name, unit: item.unit, unit_price_cents: item.unit_price_cents ?? 0 };
    });
    const total = items.reduce((sum, line) => sum + line.quantity * line.unit_price_cents, 0);
    if (total > guardrails.max_auto_approve_cents || guardrails.max_auto_approve_cents === 0) reasons.push(`Exceeds the workspace automatic approval limit of €${(guardrails.max_auto_approve_cents / 100).toFixed(2)}.`);
    if (total > agent.spending_limit_cents || agent.spending_limit_cents === 0) reasons.push(`Exceeds ${agent.name}'s automatic approval limit of €${(agent.spending_limit_cents / 100).toFixed(2)}.`);
    const now = new Date().toISOString();
    const order: Order = {
      id: `PREVIEW-${++sequence}`, agent_id: agent.id, agent_name: agent.name, items, total_cents: total,
      status: reasons.length ? "pending" : "auto_approved", reasons: [...new Set(reasons)], updated_at: now,
      trust_verification: { protocol: "browser-preview", verified_at: now, supplier_mode: "browser-preview", requested_delivery_date: body.requested_date },
    };
    orders.unshift(order);
    record(agent, "Created simulated order", reasons.length ? "pending" : "completed", reasons.join(" ") || "Within the sample purchasing rules.", order.id);
    return order;
  }
  function search(query: string, exclusions: string[] = []) {
    const terms = query.toLowerCase().replace(/[-]/g, " ").trim().split(/\s+/).filter(Boolean);
    return catalog.filter((item) => {
      const description = `${item.name} ${item.category} ${item.product_id}`.toLowerCase().replace(/[-]/g, " ");
      return terms.every((term) => description.includes(term)) && !exclusions.some((name) => item.allergens?.includes(name as Allergen));
    }).map((item) => ({ ...item, stock: stock(item) }));
  }
  const request: ApiClient = async <T,>(path: string, method = "GET", body?: object): Promise<T> => {
    const [route, query = ""] = path.split("?");
    const params = new URLSearchParams(query);
    let response: unknown;
    const permission = route === "plan_procurement" ? "prepare" : ["search_products", "check_availability", "suggest_substitutes"].includes(route) ? "search" : null;
    if (permission) {
      const agent = actor();
      if (agent.status === "paused" || !agent.permissions.includes(permission)) {
        const message = agent.status === "paused" ? "Kitchen Assistant is paused." : `Kitchen Assistant requires ${permission} permission.`;
        record(agent, "Attempted lookup", "blocked", message);
        throw new Error(message);
      }
    }
    if (route === "workspace") {
      response = { guardrails, orders, supplier_mode: "demo" };
    } else if (route === "guardrails" && method === "PUT") {
      const next = body as Guardrails;
      if (!Number.isInteger(next.max_auto_approve_cents) || next.max_auto_approve_cents < 0 || next.max_auto_approve_cents > 500000 ||
          !Number.isFinite(next.min_delivery_reliability) || next.min_delivery_reliability! < 0 || next.min_delivery_reliability! > 1) throw new Error("Check the spending and reliability limits.");
      guardrails = structuredClone(next);
      record(actor(), "Updated preview policies", "completed", "Saved workspace approval rules in this browser session.");
      response = guardrails;
    } else if (route === "create_purchase_order" && method === "POST") {
      response = createOrder(body as OrderRequest);
    } else if (route.startsWith("orders/") && method === "PATCH") {
      const order = orders.find((entry) => entry.id === route.slice(7));
      if (!order || order.status !== "pending") throw new Error("This order is no longer awaiting approval.");
      const decision = (body as { decision: string }).decision;
      if (decision !== "approved" && decision !== "rejected") throw new Error("Choose approve or reject.");
      order.status = decision;
      order.updated_at = new Date().toISOString();
      record(actor(order.agent_id ?? undefined), "Manager decision", decision, `Manager ${decision} the simulated order.`, order.id);
      response = order;
    } else if (route === "agents") {
      response = agents;
    } else if (route.startsWith("agents/") && method === "PUT") {
      const agent = actor(route.slice(7));
      const next = body as Agent;
      if (!Number.isInteger(next.spending_limit_cents) || next.spending_limit_cents < 0 || next.spending_limit_cents > 500000) throw new Error("Use a spending limit between €0 and €5,000.");
      if (!["connected", "paused"].includes(next.status) || next.permissions.some((permission) => !["search", "prepare", "purchase"].includes(permission))) throw new Error("Invalid agent settings.");
      Object.assign(agent, { permissions: [...next.permissions], spending_limit_cents: next.spending_limit_cents, status: next.status });
      record(agent, "Updated preview agent", "completed", "Saved agent permissions and automatic approval limit.");
      response = agent;
    } else if (route === "events") {
      response = events;
    } else if (route === "search_products") {
      const excluded = guardrails.review_allergens;
      response = search(params.get("query") ?? "", excluded);
      record(actor(), "Searched catalog", "completed", params.get("query") ?? "");
    } else if (route === "blocked_allergen_matches") {
      const q = params.get("query") ?? "";
      const extra = params.getAll("exclude_allergens") as Allergen[];
      const excluded = Array.from(new Set([...guardrails.review_allergens, ...extra]));
      const rawMatches = search(q);
      const safe = rawMatches.filter((item) => !excluded.some((alg) => (item.allergens ?? []).includes(alg)));
      const blocked = safe.length ? [] : rawMatches.filter((item) => excluded.some((alg) => (item.allergens ?? []).includes(alg)));
      const blocking = Array.from(new Set(blocked.flatMap((item) => (item.allergens ?? []).filter((alg) => excluded.includes(alg)))));
      response = { products: blocked.slice(0, 3), blocking_allergens: blocking };
    } else if (route === "check_availability") {
      const item = product(params.get("product_id") ?? "");
      const quantity = Number(params.get("quantity") ?? 1);
      response = { ...item, requested_quantity: quantity, available_quantity: stock(item), available: stock(item) >= quantity,
        sales_block: false, sales_unit: item.unit, currency: "EUR", available_date: params.get("requested_date") || null } satisfies Partial<Availability>;
      record(actor(), "Checked availability", "completed", `${item.name} · ${quantity} sales units requested · ${stock(item)} available.`);
    } else if (route === "suggest_substitutes") {
      const original = product(params.get("product_id") ?? "");
      response = search(original.category, params.getAll("exclude_allergens")).filter((item) => item.product_id !== original.product_id)
        .map((item) => ({ ...item, substitute_reason: `Same sample category. ${item.stock} sales units available. Check dietary claims and pack size.` }));
      record(actor(), "Requested alternatives", "completed", original.name);
    } else if (route === "plan_procurement") {
      const target = Number(params.get("target_volume_liters_or_kg"));
      const date = params.get("requested_date") || new Date().toISOString().slice(0, 10);
      const matches = search(params.get("query") ?? "", params.getAll("exclude_allergens"));
      response = { query: params.get("query"), requested_date: date, target_volume_liters_or_kg: target,
        summary: "Sample catalog matches. Review quantities, dietary information and availability.",
        options: matches.map((item) => {
          const packs = Math.ceil(target / item.volume);
          return { tier: "Sample", headline: item.name, product: item, recommended_packs: packs, total_volume_liters_or_kg: packs * item.volume,
            total_price_cents: packs * (item.unit_price_cents ?? 0), available_packs: item.stock, can_fulfill_full_volume: item.stock >= packs,
            shortfall_packs: Math.max(0, packs - item.stock), tradeoff_explanation: `${packs} sales units cover the requested volume. ${item.stock} available in the sample catalog.` };
        }) };
      record(actor(), "Planned request", "completed", `${target} L/kg · ${params.get("query")} · ${date}`);
    } else if (route === "agent_execute" && method === "POST") {
      const req = body as { prompt: string; agent_id?: string; requested_date?: string | null; exclude_allergens?: Allergen[] };
      const date = req.requested_date || new Date().toISOString().slice(0, 10);
      const excluded = Array.from(new Set([...guardrails.review_allergens, ...(req.exclude_allergens ?? [])]));
      const rawMatches = search(req.prompt);
      const safeMatches = rawMatches.filter((item) => !excluded.some((alg) => (item.allergens ?? []).includes(alg)));
      const blockedMatches = rawMatches.filter((item) => excluded.some((alg) => (item.allergens ?? []).includes(alg)));
      if (safeMatches.length === 0 && blockedMatches.length > 0) {
        const blocking = Array.from(new Set(blockedMatches.flatMap((item) => (item.allergens ?? []).filter((alg) => excluded.includes(alg)))));
        const reason = `Products matched '${req.prompt}', but all were excluded by your allergen rules (${blocking.join(", ")}). No order was placed.`;
        record(actor(req.agent_id ?? "kitchen"), "Allergen exclusion rejection", "rejected", reason);
        response = {
          prompt: req.prompt,
          agent: actor(req.agent_id ?? "kitchen"),
          requested_date: date,
          orchestrator_model: "browser-preview",
          parsed_lines: [{ query: req.prompt, target_volume_liters_or_kg: 10, unit_hint: "L/kg", exclude_allergens: excluded }],
          plans: [],
          order: null,
          rejected: true,
          rejection_reason: reason,
          rejected_products: blockedMatches.slice(0, 3),
          decision_trace: [
            `1. Category & Dietary Filter: Found ${blockedMatches.length} matches, ALL ignored due to excluded allergens (${blocking.join(", ")}).`,
            `2. Priority Ranking: 0 allergen-safe products available without (${blocking.join(", ")}).`,
            "3. Pack Math & Live Stock: Skipped — no compliant SKU available.",
            `4. Guardrail & Quote Lock: REJECTED — ${reason}`,
          ],
          summary: `Rejected: ${reason}`,
        };
      } else {
        const top = safeMatches[0] ?? catalog[0];
        const order = createOrder({ agent_id: req.agent_id ?? "kitchen", items: [{ product_id: top.product_id, quantity: 10 }], requested_date: date });
        response = {
          prompt: req.prompt,
          agent: actor(req.agent_id ?? "kitchen"),
          requested_date: date,
          orchestrator_model: "browser-preview",
          parsed_lines: [{ query: req.prompt, target_volume_liters_or_kg: 10, unit_hint: "L/kg", exclude_allergens: excluded }],
          plans: [{ options: [{ product: top }] }],
          order,
          rejected: false,
          rejected_products: [],
          decision_trace: [
            `1. Category & Dietary Filter: Matched SKU ${top.product_id} — "${top.name}"`,
            `2. Priority Ranking: #1 [BEST] (${((top.delivery_reliability ?? 0.99) * 100).toFixed(0)}% on-time)`,
            `3. Pack Math & Live Stock: 10 × ${top.unit} (${stock(top)} available)`,
            `4. Guardrail & Quote Lock: ${order.id} · ${order.status.toUpperCase()}`,
          ],
          summary: `Selected SKU ${top.product_id} — "${top.name}" (10 × ${top.unit}). Created ${order.id} (${order.status}).`,
        };
      }
    } else {
      throw new Error("This action is unavailable in the browser preview.");
    }
    return structuredClone(response) as T;
  };

  createOrder({ items: [{ product_id: "AIMO-101", quantity: 120 }] });
  createOrder({ items: [{ product_id: "AIMO-101", quantity: 1000 }, { product_id: "AIMO-102", quantity: 50 }] });
  try { createOrder({ agent_id: "inventory", items: [{ product_id: "AIMO-101", quantity: 1 }] }); } catch { /* Seed the explicitly labeled blocked example. */ }
  return { request, agents: () => structuredClone(agents), events: () => structuredClone(events) };
}
