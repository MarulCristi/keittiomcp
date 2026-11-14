export type Allergen = "milk" | "gluten" | "soy" | "eggs" | "nuts" | "fish";
export type PriorityMode = "balanced" | "low_carbon" | "lowest_price" | "authentic_finnish" | "highest_reliability";
export type ScheduledOrderCadence = "once" | "daily" | "weekdays" | "weekly";
export type Guardrails = { max_auto_approve_cents: number; review_allergens: Allergen[]; min_delivery_reliability?: number; require_approval_on_substitution?: boolean; priority_mode?: PriorityMode; priority_modes?: PriorityMode[] };
export type Product = {
  product_id: string;
  name: string;
  name_fi?: string | null;
  category?: string | null;
  vendor?: string | null;
  country_of_origin?: string | null;
  unit: string;
  net_volume_liters_or_kg?: number | null;
  unit_price_cents: number | null;
  stock: number | null;
  allergens: Allergen[] | null;
  dietary_claims?: string[];
  sustainability_labels?: string[];
  delivery_reliability?: number | null;
  carbon_footprint_kg?: number | null;
  co2_range_label?: string | null;
  comparison_price_cents?: number | null;
  comparison_unit?: string | null;
  purity_tier?: number;
  gtins?: string[];
  substitute_tier?: string | null;
  substitute_reason?: string | null;
};
export type Order = {
  id: string;
  agent_id?: string | null;
  agent_name?: string | null;
  buyer_name?: string | null;
  items: { product_id: string; name: string; quantity: number; unit: string; unit_price_cents?: number; is_substitution?: boolean; substituted_for?: string | null }[];
  total_cents: number;
  status: "pending" | "auto_approved" | "approved" | "rejected";
  reasons: string[];
  decision_trace?: string[];
  updated_at: string;
  total_carbon_kg?: number | null;
  min_reliability?: number | null;
  trust_verification?: {
    protocol: string;
    verified_at: string;
    supplier_mode: string;
    requested_delivery_date?: string | null;
    earliest_closing_time?: string | null;
    quote_lock_id?: string | null;
    signature_hmac_sha256?: string | null;
    privacy_audit_model?: string | null;
    privacy_audit_summary?: string | null;
    redacted_confidential_fields?: string[];
  } | null;
};
export type FulfillmentPlanOption = {
  tier?: string;
  headline?: string;
  product: Product;
  recommended_packs?: number;
  total_volume_liters_or_kg?: number;
  total_price_cents?: number | null;
  available_packs?: number | null;
  can_fulfill_full_volume?: boolean;
  shortfall_packs?: number;
  tradeoff_explanation?: string;
};
export type AgentExecutionResult = {
  prompt: string;
  agent?: { id: string; name: string; spending_limit_cents?: number };
  requested_date: string;
  priority_mode?: PriorityMode;
  priority_modes?: PriorityMode[];
  orchestrator_model: string;
  parsed_lines: { query: string; target_volume_liters_or_kg: number; unit_hint: string; exclude_allergens: Allergen[] }[];
  plans?: { query?: string; target_volume_liters_or_kg?: number; summary?: string; options: FulfillmentPlanOption[] }[];
  order: Order | null;
  decision_trace: string[];
  rejected?: boolean;
  rejection_reason?: string | null;
  rejected_products?: Product[];
  summary: string;
};
export type ScheduledOrderRule = {
  id: string;
  prompt: string;
  cadence: ScheduledOrderCadence;
  run_time: string;
  next_run_at: string;
  last_run_at?: string | null;
  last_order_id?: string | null;
  last_status?: string | null;
  last_summary?: string | null;
  enabled: boolean;
  auto_place_order: boolean;
  runs_completed: number;
  created_at: string;
};
export type ScheduledRunExecution = {
  rule: ScheduledOrderRule;
  scheduled_for: string;
  execution: AgentExecutionResult;
};
export type ScheduleWorkspaceState = {
  simulated_now: string;
  real_now: string;
  offset_seconds: number;
  rules: ScheduledOrderRule[];
};
export type ClockAdvanceResponse = ScheduleWorkspaceState & {
  executed_runs: ScheduledRunExecution[];
};
export type BlockedAllergenMatches = { products: Product[]; blocking_allergens: Allergen[] };
export type Availability = {
  name: string;
  requested_quantity?: number;
  available_quantity: number | null;
  available: boolean | null;
  available_date: string | null;
  sales_unit: string | null;
  sales_block: boolean;
  unit_price_cents: number | null;
  currency: string | null;
  closing_time?: string | null;
  delivery_reliability?: number | null;
  sustainability_labels?: string[];
};

export const money = (cents: number) => new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(cents / 100);
export const statusLabels = { pending: "Pending approval", auto_approved: "Auto-approved", approved: "Approved", rejected: "Rejected" };

// Prefer an explicit identity supplied with the order; never infer a person from approval status.
export function orderRequester(order: Pick<Order, "agent_name" | "agent_id" | "buyer_name">) {
  if (order.agent_name?.trim()) return `Requested by ${order.agent_name.trim()} · Agent`;
  if (order.agent_id?.trim()) return `Requested by agent ${order.agent_id.trim()}`;
  if (order.buyer_name?.trim()) return `Requested by ${order.buyer_name.trim()} · Person`;
  return "Requester not provided";
}

export function parseQuantity(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity > 0 && quantity <= 10000 ? quantity : null;
}

// A lookup is usable only for the quantity that was actually checked.
export function canCreateOrder(mode: "demo" | "junction" | undefined, sample: boolean, quantity: number | null, checkedQuantity: number | undefined, result: Availability | null) {
  return (mode === "demo" || mode === "junction") && !sample && quantity !== null && checkedQuantity === quantity &&
    result?.available === true && result.sales_block === false &&
    (result.available_quantity == null || result.available_quantity >= quantity) &&
    result.unit_price_cents != null && Number.isSafeInteger(result.unit_price_cents) && result.unit_price_cents >= 0 &&
    Number.isSafeInteger(result.unit_price_cents * quantity) && result.currency === "EUR";
}

export async function api<T>(path: string, method = "GET", body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method, signal, cache: "no-store",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(typeof error?.detail === "string" ? error.detail : "The purchasing service could not complete the request. Please try again.");
  }
  return response.json() as Promise<T>;
}

export type ApiClient = typeof api;

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

// These are UI fixtures, not supplier records. Sample selection can never submit an order.
export const sampleProducts: Product[] = [
  { product_id: "SAMPLE-CREAM", name: "Lactose-free cooking cream", unit: "1 L carton", unit_price_cents: 345, stock: 24, allergens: ["milk"] },
  { product_id: "SAMPLE-OAT", name: "Oat cooking alternative", unit: "1 L carton", unit_price_cents: 295, stock: 8, allergens: ["gluten"] },
  { product_id: "SAMPLE-UNKNOWN", name: "Organic cooking cream", unit: "1 L carton", unit_price_cents: null, stock: null, allergens: null },
];
