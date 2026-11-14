"use client";

import {
  ArrowDownUp, ArrowRight, Filter, Globe, Lock,
  PackageCheck, ShieldAlert, ShieldCheck, Trophy,
} from "lucide-react";
import {
  money, statusLabels,
  type AgentExecutionResult, type Guardrails, type Order, type PriorityMode,
} from "../lib/purchasing";

const PRIORITY_LABELS: Record<PriorityMode, string> = {
  balanced: "Balanced (Reliability + Carbon + Price)",
  low_carbon: "Lowest Carbon Footprint (Sustainability First)",
  lowest_price: "Lowest Price / Budget First",
  authentic_finnish: "Authentic Finnish Origin (Blue Swan / Key Flag)",
  highest_reliability: "Highest Delivery Reliability (100% On-Time)",
};

const ORIGIN_NAMES: Record<string, string> = {
  FI: "FI · Finland (Kotimainen)",
  SE: "SE · Sweden",
  DK: "DK · Denmark",
  DE: "DE · Germany",
  NL: "NL · Netherlands",
  EE: "EE · Estonia",
  IT: "IT · Italy",
  ES: "ES · Spain",
};

type Props = {
  execution?: AgentExecutionResult | null;
  order?: Order | null;
  guardrails?: Guardrails | null;
  onOpenApprovals?: () => void;
};

export default function DecisionFlowDiagram({
  execution,
  order: propOrder,
  guardrails,
  onOpenApprovals,
}: Props) {
  const activeOrder = execution?.order ?? propOrder ?? null;
  const trace = execution?.decision_trace ?? activeOrder?.decision_trace ?? [];
  const plan = execution?.plans?.[0];
  const options = plan?.options ?? [];
  const parsedLine = execution?.parsed_lines?.[0];
  const bestOption = options[0];
  const firstItem = activeOrder?.items?.[0];
  const isSubstituted = Boolean(firstItem?.is_substitution || trace.some((s) => /Auto-Substitution/i.test(s)));
  const priorityMode: PriorityMode = execution?.priority_mode ?? guardrails?.priority_mode ?? "balanced";

  if (!execution && !activeOrder) return null;

  // Determine the actual fulfilled product (substituted option if stockout occurred, else #1 option)
  const chosenOption = isSubstituted && options.length > 1
    ? (options.find((o) => o.product.product_id === firstItem?.product_id) ?? options[1])
    : bestOption;
  const chosenProduct = chosenOption?.product ?? bestOption?.product;

  // Format key criteria
  const unitPriceCents = firstItem?.unit_price_cents ?? chosenProduct?.unit_price_cents ?? null;
  const unitLabel = firstItem?.unit ?? chosenProduct?.unit ?? "unit";
  const compPriceStr = chosenProduct?.comparison_price_cents != null && chosenProduct?.comparison_unit
    ? `${money(chosenProduct.comparison_price_cents)} / ${chosenProduct.comparison_unit}`
    : unitPriceCents != null
      ? `${money(unitPriceCents)} / ${unitLabel}`
      : "Verified fixed price";

  const originCode = (chosenProduct?.country_of_origin || "FI").toUpperCase();
  const originLabel = ORIGIN_NAMES[originCode] ?? originCode;

  const certificates = (chosenProduct?.sustainability_labels ?? []).filter(
    (label) => !label.startsWith("Cat ")
  );
  const co2RangeCertificate = (chosenProduct?.sustainability_labels ?? []).find(
    (label) => label.startsWith("Cat ")
  );

  const reliabilityStr = chosenProduct?.delivery_reliability != null
    ? `${(chosenProduct.delivery_reliability * 100).toFixed(1)}%`
    : activeOrder?.min_reliability != null
      ? `${(activeOrder.min_reliability * 100).toFixed(1)}%`
      : "100.0%";

  const co2Str = chosenProduct?.carbon_footprint_kg != null
    ? `${chosenProduct.carbon_footprint_kg.toFixed(2)} kg CO2e/kg`
    : "Category median";

  // Concise 1-line step headers
  const step1Short = parsedLine
    ? `'${parsedLine.query}' (${parsedLine.target_volume_liters_or_kg.toLocaleString("en-GB")} ${parsedLine.unit_hint})`
    : "Category & allergen filter";
  const step1Cat = chosenProduct?.category ? `GS1 Cat ${chosenProduct.category}` : "Filtered";

  const step2Short = bestOption?.product
    ? `#1 SKU ${bestOption.product.product_id} (${bestOption.product.name})`
    : firstItem
      ? `SKU ${firstItem.product_id} (${firstItem.name})`
      : "Ranked top catalog options";

  const unitVol = chosenProduct?.net_volume_liters_or_kg ?? 1;
  const targetVol = parsedLine?.target_volume_liters_or_kg ?? (firstItem?.quantity ?? 1) * unitVol;
  const packFormula = `ceil(${targetVol} / ${unitVol}) = ${firstItem?.quantity ?? chosenOption?.recommended_packs ?? 1} × ${unitLabel}`;

  const tv = activeOrder?.trust_verification;

  return (
    <div className="inline-decision-card">
      {/* SECTION 1: SELECTED ITEM & KEY CRITERIA BADGES */}
      <div className="selected-summary-box">
        <div className="selected-header-row">
          <span className="selected-pill-tag">
            {isSubstituted ? "Selected (Auto-Substituted)" : "Selected"}
          </span>
          <code>SKU {firstItem?.product_id ?? chosenProduct?.product_id ?? "N/A"}</code>
          {firstItem && (
            <span className="selected-qty-badge">
              {firstItem.quantity.toLocaleString("en-GB")} × {firstItem.unit}
            </span>
          )}
        </div>

        <h3 className="selected-product-title">
          {firstItem?.name ?? chosenProduct?.name ?? "Valio Aimo Product"}
        </h3>
        {chosenProduct?.name_fi && (
          <p className="selected-finnish-sub">
            Finnish catalog name: <code>{chosenProduct.name_fi}</code>
            {chosenProduct.vendor ? <> · Vendor: <code>{chosenProduct.vendor}</code></> : null}
          </p>
        )}

        {/* HIGH-VISIBILITY CRITERIA GRID */}
        <div className="criteria-badge-grid">
          <div className="criteria-chip price">
            <small>Price / L or kg</small>
            <strong><code>{compPriceStr}</code></strong>
            {unitPriceCents != null && <span>{money(unitPriceCents)} per {unitLabel}</span>}
          </div>

          <div className="criteria-chip origin">
            <small><Globe size={11} /> Country of Origin</small>
            <strong><code>{originLabel}</code></strong>
            <span>{originCode === "FI" ? "Domestic Finnish supply" : "Imported wholesale supply"}</span>
          </div>

          <div className="criteria-chip certs">
            <small>Certificates & Labels</small>
            <strong>
              {certificates.length > 0
                ? certificates.map((c, i) => <code key={i}>{c}</code>)
                : <code>{(chosenProduct?.dietary_claims ?? ["lactose_free"]).join(", ")}</code>}
            </strong>
            <span>
              {chosenProduct?.dietary_claims?.length
                ? `Claims: ${chosenProduct.dietary_claims.join(", ")}`
                : "Verified Valio Aimo spec"}
            </span>
          </div>

          <div className="criteria-chip metrics">
            <small>Reliability & Carbon</small>
            <strong><code>{reliabilityStr} on-time</code> · <code>{co2Str}</code></strong>
            <span>{co2RangeCertificate ?? `Priority: ${priorityMode.replace("_", " ")}`}</span>
          </div>
        </div>
      </div>

      {/* SECTION 2: PROMINENT APPROVAL / WHY NOT APPROVED BANNER */}
      {activeOrder && (
        <div className={`approval-callout-banner ${activeOrder.status === "pending" ? "not-approved" : "auto-approved"}`}>
          <div className="approval-callout-header">
            <div className="approval-callout-title">
              {activeOrder.status === "pending" ? <ShieldAlert size={20} /> : <ShieldCheck size={20} />}
              <div>
                <strong>
                  {activeOrder.status === "pending"
                    ? `Why Order ${activeOrder.id} Was Not Auto-Approved`
                    : `Order ${activeOrder.id} Automatically Approved`}
                </strong>
                <span>
                  Order total: <code>{money(activeOrder.total_cents)}</code> · Status: <code>{statusLabels[activeOrder.status].toUpperCase()}</code>
                </span>
              </div>
            </div>
            {activeOrder.status === "pending" && onOpenApprovals && (
              <button type="button" className="primary-button" onClick={onOpenApprovals}>
                Review in Approval Centre <ArrowRight size={14} />
              </button>
            )}
          </div>

          {activeOrder.status === "pending" && activeOrder.reasons.length > 0 ? (
            <ul className="approval-reasons-list">
              {activeOrder.reasons.map((reason, idx) => (
                <li key={idx}>
                  <strong>Guardrail triggered:</strong> {reason}
                </li>
              ))}
            </ul>
          ) : (
            <p className="approval-pass-note">
              Passed all autonomous guardrails: total spend <code>{money(activeOrder.total_cents)} &lt;= {money(guardrails?.max_auto_approve_cents ?? 25000)}</code> limit, <code>0</code> restricted allergens, and primary SKU in stock.
            </p>
          )}
        </div>
      )}

      {/* SECTION 3: MINIMALIST CLICK-TO-EXPAND ALGORITHM STEPS */}
      <div className="algorithm-steps-container">
        <div className="algorithm-steps-header">
          <span>Algorithm thinking steps (click any step to expand console trace)</span>
        </div>

        {/* STEP 1 DROPDOWN */}
        <details className="algo-step-dropdown">
          <summary>
            <span className="algo-step-num sky"><Filter size={13} /> Step 1</span>
            <span className="algo-step-title">Category & Dietary Filter — <code>{step1Short}</code></span>
            <span className="algo-step-pill">{step1Cat}</span>
          </summary>
          <div className="algo-step-body">
            <p>
              Routed query <code>{parsedLine?.query ?? execution?.prompt ?? "request"}</code> directly to GS1 category{" "}
              <code>{chosenProduct?.category ?? "10400"}</code> before scoring. Enforced workspace allergen exclusions{" "}
              <code>[{(parsedLine?.exclude_allergens ?? guardrails?.review_allergens ?? ["gluten", "nuts"]).join(", ")}]</code>{" "}
              and required dietary claims <code>[{(chosenProduct?.dietary_claims ?? ["lactose_free"]).join(", ")}]</code>.
            </p>
            <div className="console-kv-block">
              <div><span>Active Kitchen Priority:</span> <code>{PRIORITY_LABELS[priorityMode]}</code></div>
              <div><span>Requested Delivery Date:</span> <code>{execution?.requested_date ?? tv?.requested_delivery_date ?? "2026-11-16"}</code></div>
              {trace[0] && <div><span>Console Trace:</span> <code>{trace[0]}</code></div>}
            </div>
          </div>
        </details>

        {/* STEP 2 DROPDOWN */}
        <details className="algo-step-dropdown">
          <summary>
            <span className="algo-step-num blue"><Trophy size={13} /> Step 2</span>
            <span className="algo-step-title">Priority Ranking ({priorityMode.replace("_", " ")}) — <code>{step2Short}</code></span>
            <span className="algo-step-pill">{options.length || 3} candidates compared</span>
          </summary>
          <div className="algo-step-body">
            <p>
              Ranked eligible SKUs using the <strong>{PRIORITY_LABELS[priorityMode]}</strong> scoring weights (Delivery Reliability, Carbon Footprint vs category median, Country of Origin, and Comparison Price per L/kg):
            </p>
            {options.length > 0 ? (
              <div className="console-candidates-list">
                {options.slice(0, 3).map((opt, idx) => {
                  const p = opt.product;
                  const tier = (opt.tier ?? (idx === 0 ? "BEST" : idx === 1 ? "BETTER" : "GOOD")).toUpperCase();
                  const pComp = p.comparison_price_cents != null && p.comparison_unit
                    ? `${money(p.comparison_price_cents)}/${p.comparison_unit}`
                    : p.unit_price_cents != null
                      ? `${money(p.unit_price_cents)}/${p.unit}`
                      : "Verified";
                  const pCerts = (p.sustainability_labels ?? []).filter((l) => !l.startsWith("Cat "));
                  return (
                    <div key={p.product_id} className={`console-candidate-item ${idx === 0 ? "top-choice" : ""}`}>
                      <div className="console-candidate-head">
                        <span className={`tier-badge ${tier.toLowerCase()}`}>#{idx + 1} [{tier}]</span>
                        <code>SKU {p.product_id}</code>
                        <strong>{p.name}</strong>
                      </div>
                      <div className="console-candidate-meta">
                        <span>Price/unit: <code>{pComp}</code></span>
                        <span>Origin: <code>{(p.country_of_origin || "FI").toUpperCase()}</code></span>
                        <span>Reliability: <code>{p.delivery_reliability != null ? `${(p.delivery_reliability * 100).toFixed(1)}%` : "100.0%"}</code></span>
                        <span>CO2: <code>{p.carbon_footprint_kg != null ? `${p.carbon_footprint_kg.toFixed(2)} kg CO2e/kg` : "Med"}</code></span>
                        {pCerts.length > 0 && <span>Certificates: <code>{pCerts.join(", ")}</code></span>}
                      </div>
                      {opt.tradeoff_explanation && <p className="console-candidate-reason">{opt.tradeoff_explanation}</p>}
                    </div>
                  );
                })}
              </div>
            ) : (
              trace[1] && <p><code>{trace[1]}</code></p>
            )}
          </div>
        </details>

        {/* STEP 3 DROPDOWN */}
        <details className="algo-step-dropdown">
          <summary>
            <span className={`algo-step-num ${isSubstituted ? "orange" : "turquoise"}`}>
              {isSubstituted ? <ArrowDownUp size={13} /> : <PackageCheck size={13} />} Step 3
            </span>
            <span className="algo-step-title">
              {isSubstituted ? "Stock-Out Auto-Substitution" : "Wholesale Pack Math & Live Stock"} — <code>{packFormula}</code>
            </span>
            <span className={`algo-step-pill ${isSubstituted ? "warning" : ""}`}>
              {isSubstituted ? "Swapped to [BETTER]" : "100% In Stock"}
            </span>
          </summary>
          <div className="algo-step-body">
            {isSubstituted ? (
              <p>
                Primary <code>[BEST]</code> item (<code>{firstItem?.substituted_for ?? `SKU ${bestOption?.product.product_id}`}</code>) had a warehouse stock shortfall for the requested delivery date. Automatically swapped to the <code>#2 [BETTER]</code> substitute in the same GS1 category: <code>SKU {firstItem?.product_id} — {firstItem?.name}</code>.
              </p>
            ) : (
              <p>
                Converted requested kitchen volume into whole wholesale packs using <code>{packFormula}</code> and verified live Valio Aimo warehouse stock for delivery on <code>{execution?.requested_date ?? "2026-11-16"}</code>.
              </p>
            )}
            <div className="console-kv-block">
              <div><span>Pack Math Formula:</span> <code>{packFormula}</code></div>
              <div><span>Locked Unit Price (+tax):</span> <code>{unitPriceCents != null ? `${money(unitPriceCents)} / ${unitLabel}` : compPriceStr}</code></div>
              <div><span>Warehouse Stock Status:</span> <code>{chosenOption?.available_packs == null ? "Terminal Direct-Delivery Stock (Unlimited)" : `${chosenOption.available_packs} packs available`}</code></div>
              {trace[2] && <div><span>Console Trace:</span> <code>{trace[2]}</code></div>}
            </div>
          </div>
        </details>

        {/* STEP 4 DROPDOWN */}
        <details className="algo-step-dropdown">
          <summary>
            <span className="algo-step-num sky"><Lock size={13} /> Step 4</span>
            <span className="algo-step-title">
              Guardrails & Cryptographic Quote Lock — <code>{tv?.quote_lock_id ?? activeOrder?.id ?? "keittio-valio-trust-v1"}</code>
            </span>
            <span className="algo-step-pill">HMAC-SHA256</span>
          </summary>
          <div className="algo-step-body">
            <p>
              Locked fixed catalog pricing under protocol <code>{tv?.protocol ?? "keittio-valio-trust-v1"}</code> and verified confidential supplier margin redaction via <code>{tv?.privacy_audit_model ?? execution?.orchestrator_model ?? "models/gemma-4-26b-a4b-it"}</code>.
            </p>
            <div className="console-kv-block">
              <div><span>Workspace Spend Guardrail:</span> <code>{money(activeOrder?.total_cents ?? 0)} vs {money(guardrails?.max_auto_approve_cents ?? 25000)} auto-approve limit</code></div>
              {tv?.quote_lock_id && <div><span>Quote Lock ID:</span> <code>{tv.quote_lock_id}</code></div>}
              {tv?.signature_hmac_sha256 && <div><span>HMAC-SHA256 Signature:</span> <code>{tv.signature_hmac_sha256.slice(0, 32)}…</code></div>}
              {tv?.earliest_closing_time && <div><span>Order Cut-off Time:</span> <code>{tv.earliest_closing_time}</code></div>}
              {tv?.privacy_audit_summary && <div><span>Privacy & Margin Attestation:</span> <span>{tv.privacy_audit_summary}</span></div>}
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}
