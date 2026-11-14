"use client";

import { useState, type FormEvent } from "react";
import { api, errorMessage, money, type ApiClient, type Allergen, type PriorityMode, type Product } from "../lib/purchasing";

type Option = {
  tier: string;
  headline: string;
  product: Product;
  recommended_packs: number;
  total_volume_liters_or_kg: number;
  total_price_cents: number | null;
  available_packs: number | null;
  can_fulfill_full_volume: boolean;
  shortfall_packs: number;
  tradeoff_explanation: string;
};
type Plan = { query: string; requested_date: string; target_volume_liters_or_kg: number; summary: string; options: Option[] };
type Props = {
  request?: ApiClient;
  connected: boolean;
  busy: boolean;
  onBusy: (action: string) => void;
  onSelect: (product: Product, quantity: number, date: string) => void;
};

export default function RequestPlanner({ request = api, connected, busy, onBusy, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("1000");
  const [date, setDate] = useState("");
  const [priority, setPriority] = useState<PriorityMode>("balanced");
  const [excluded, setExcluded] = useState<Allergen[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [thinkingStep, setThinkingStep] = useState(0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connected || busy || !query.trim()) return;
    onBusy("plan");
    setError("");
    setPlan(null);
    setThinkingStep(1);
    const timer1 = setTimeout(() => setThinkingStep(2), 450);
    const timer2 = setTimeout(() => setThinkingStep(3), 950);
    try {
      const params = new URLSearchParams({ query: query.trim(), target_volume_liters_or_kg: target, priority_mode: priority });
      if (date) params.set("requested_date", date);
      excluded.forEach((name) => params.append("exclude_allergens", name));
      setPlan(await request<Plan>(`plan_procurement?${params}`));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      clearTimeout(timer1);
      clearTimeout(timer2);
      setThinkingStep(0);
      onBusy("");
    }
  }

  return <section className="panel side-panel request-planner" aria-labelledby="planner-title">
    <h2 id="planner-title">Plan a purchasing request</h2>
    <p className="review-caption">Enter the ingredient, dietary requirements, total litres or kilograms, kitchen priority, and delivery date. Review each returned option before ordering.</p>
    <form onSubmit={submit}>
      <fieldset disabled={busy}>
        <div className="request-fields">
          <label>Ingredient and requirements<input required maxLength={120} value={query} placeholder="Lactose-free milk" onChange={(event) => { setQuery(event.target.value); setPlan(null); }} /></label>
          <label>Total litres or kilograms<input required type="number" min="0.01" max="100000" step="any" value={target} onChange={(event) => { setTarget(event.target.value); setPlan(null); }} /></label>
          <label>Kitchen purchasing priority
            <select className="agent-field" style={{ marginTop: 0, width: "100%", border: "1px solid #bdcfd7", borderRadius: 6, padding: "10px 12px", minHeight: 42, background: "#fff" }} value={priority} onChange={(event) => { setPriority(event.target.value as PriorityMode); setPlan(null); }}>
              <option value="balanced">Balanced (Reliability + Carbon + Price)</option>
              <option value="low_carbon">Lowest Carbon Footprint (Sustainability First)</option>
              <option value="lowest_price">Lowest Price / Cheapness (Budget First)</option>
              <option value="authentic_finnish">Authentic Finnish Origin (Kotimainen / Key Flag)</option>
              <option value="highest_reliability">Highest Delivery Reliability (100% On-Time)</option>
            </select>
          </label>
          <label>Delivery date<input type="date" value={date} onChange={(event) => { setDate(event.target.value); setPlan(null); }} /></label>
        </div>
        <fieldset className="allergens"><legend>Exclude allergens from this request</legend><div className="allergen-options">
          {(["milk", "gluten", "soy", "eggs", "nuts", "fish"] as Allergen[]).map((name) => <label key={name}>
            <input type="checkbox" checked={excluded.includes(name)} onChange={(event) => { setExcluded(event.target.checked ? [...excluded, name] : excluded.filter((entry) => entry !== name)); setPlan(null); }} />{name}
          </label>)}
        </div></fieldset>
        <p className="review-caption">Lactose-free products may contain milk. Allergens selected here are excluded from this request.</p>
        <button className="primary-button" type="submit" disabled={!connected || busy}>{busy ? "Thinking & planning…" : "Find fulfillment options"}</button>
      </fieldset>
    </form>
    {thinkingStep > 0 && <p className="decision-note" role="status">
      <strong>
        {thinkingStep === 1 ? "Step 1/3 · Category & Dietary Filter…" : thinkingStep === 2 ? "Step 2/3 · Live Valio Aimo Price & Stock Lookup…" : `Step 3/3 · Good-Better-Best Pack Math (${priority.replace("_", " ")})…`}
      </strong>
    </p>}
    {error && <p className="error" role="alert">{error}</p>}
    {plan && <div aria-live="polite">
      <h3 className="review-product-name">{plan.query}</h3>
      <p className="review-caption">{plan.target_volume_liters_or_kg.toLocaleString("en-GB")} L/kg requested · {plan.requested_date}</p>
      <p>{plan.summary}</p>
      {!plan.options.length && <p className="empty">No fulfillment options were returned. Adjust the request and try again.</p>}
      <div className="approval-grid">{plan.options.map((option, index) => <article className="product-card" key={`${option.product.product_id}:${index}`}>
        <h3>{option.headline}</h3><p>{option.product.name}</p>
        <p className="review-caption">{option.recommended_packs} × {option.product.unit} · {option.total_price_cents == null ? "Price unconfirmed" : money(option.total_price_cents)}</p>
        <p>{option.tradeoff_explanation}</p>
        <p className="review-caption">{option.can_fulfill_full_volume ? "Reported to cover the requested volume" : `Full volume unconfirmed · reported shortfall ${option.shortfall_packs} sales units`}</p>
        <p className="review-caption">Dietary claims: {option.product.dietary_claims?.join(", ") || "Unconfirmed"} · Allergens: {option.product.allergens?.join(", ") || "None listed or unknown"}</p>
        {excluded.length > 0 && (option.product.allergens == null || excluded.some((name) => option.product.allergens?.includes(name))) && <p className="field-error">This option cannot be selected because its allergen information does not confirm your exclusions.</p>}
        <button type="button" className="secondary-button" disabled={busy || (excluded.length > 0 && (option.product.allergens == null || excluded.some((name) => option.product.allergens?.includes(name))))} onClick={() => onSelect(option.product, option.recommended_packs, plan.requested_date)}>Review this option</button>
      </article>)}</div>
    </div>}
  </section>;
}
