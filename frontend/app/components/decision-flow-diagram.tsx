"use client";

import { useState } from "react";
import {
  ArrowDown, ArrowDownUp, Check, ChevronDown, ChevronRight,
  Filter, Lock, PackageCheck, ShieldAlert, ShieldCheck, Trophy, X,
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

type Props = {
  execution?: AgentExecutionResult | null;
  order?: Order | null;
  guardrails?: Guardrails | null;
  onClose?: () => void;
  onOpenApprovals?: () => void;
};

export default function DecisionFlowDiagram({
  execution,
  order: propOrder,
  guardrails,
  onClose,
  onOpenApprovals,
}: Props) {
  const [openNode, setOpenNode] = useState<number | null>(null);

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

  const toggle = (index: number) => setOpenNode((prev) => (prev === index ? null : index));

  // Extract concise headlines from trace or structured fields
  const step1Headline = parsedLine
    ? `'${parsedLine.query}' · ${parsedLine.target_volume_liters_or_kg.toLocaleString("en-GB")} ${parsedLine.unit_hint}`
    : (trace[0]?.replace(/^1\.\s*[^:]+:\s*/, "").split("·")[0]?.trim() ?? "Category & dietary routing");

  const step1Badge = bestOption?.product.category
    ? `GS1 Cat ${bestOption.product.category}`
    : trace[0]?.match(/GS1 Cat\s+(\S+)/i)?.[1]
      ? `GS1 Cat ${trace[0].match(/GS1 Cat\s+(\S+)/i)?.[1]}`
      : "Filtered";

  const winnerProduct = bestOption?.product;
  const step2Headline = winnerProduct
    ? `SKU ${winnerProduct.product_id} — ${winnerProduct.name}`
    : firstItem
      ? `SKU ${firstItem.product_id} — ${firstItem.name}`
      : (trace[1]?.replace(/^2\.\s*[^:]+:\s*/, "") ?? "Ranked top catalog match");

  const step2Badge = winnerProduct?.delivery_reliability != null
    ? `${(winnerProduct.delivery_reliability * 100).toFixed(0)}% on-time`
    : activeOrder?.min_reliability != null
      ? `${(activeOrder.min_reliability * 100).toFixed(0)}% on-time`
      : "#1 Match";

  const step3Headline = firstItem
    ? `${firstItem.quantity.toLocaleString("en-GB")} × ${firstItem.unit} (${firstItem.name})`
    : bestOption
      ? `${bestOption.recommended_packs ?? 1} × ${bestOption.product.unit}`
      : (trace[2]?.replace(/^3\.\s*[^:]+:\s*/, "") ?? "Pack math & stock verified");

  const step3Badge = isSubstituted ? "Auto-Substituted" : "100% In Stock";

  const step4Headline = activeOrder
    ? `${activeOrder.id} · ${money(activeOrder.total_cents)}`
    : "Order preview";

  const tv = activeOrder?.trust_verification;
  const step5Headline = tv?.quote_lock_id ?? tv?.protocol ?? "keittio-valio-trust-v1";

  return (
    <section className="panel side-panel flow-diagram-panel" aria-labelledby="flow-diagram-title">
      <div className="flow-diagram-header">
        <div>
          <span className="eyebrow">Autonomous decision pipeline</span>
          <h2 id="flow-diagram-title">Selection flow diagram</h2>
          <p className="review-caption">Click any stage in the diagram to inspect the underlying catalog and guardrail data.</p>
        </div>
        {onClose && (
          <button type="button" className="icon-button" aria-label="Close diagram" onClick={onClose}>
            <X size={15} />
          </button>
        )}
      </div>

      <div className="flow-diagram-tree" role="list">
        {/* NODE 1: CATEGORY & DIETARY FILTER */}
        <div className={`flow-node ${openNode === 1 ? "expanded" : ""}`} role="listitem">
          <button type="button" className="flow-node-trigger" onClick={() => toggle(1)} aria-expanded={openNode === 1}>
            <span className="flow-node-icon sky"><Filter size={15} /></span>
            <span className="flow-node-main">
              <small>1 · Category & Dietary Filter</small>
              <strong>{step1Headline}</strong>
            </span>
            <span className="flow-node-badge">{step1Badge}</span>
            <span className="flow-node-chevron">{openNode === 1 ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
          </button>
          {openNode === 1 && (
            <div className="flow-node-details">
              <dl className="flow-detail-grid">
                <div><dt>Parsed request</dt><dd>{execution?.prompt ?? step1Headline}</dd></div>
                {parsedLine && <div><dt>Target volume</dt><dd>{parsedLine.target_volume_liters_or_kg.toLocaleString("en-GB")} {parsedLine.unit_hint}</dd></div>}
                <div><dt>Delivery date</dt><dd>{execution?.requested_date ?? tv?.requested_delivery_date ?? "2026-11-16"}</dd></div>
                <div><dt>Kitchen priority</dt><dd>{PRIORITY_LABELS[priorityMode]}</dd></div>
                <div><dt>Excluded allergens</dt><dd>{(parsedLine?.exclude_allergens ?? guardrails?.review_allergens ?? ["gluten", "nuts"]).join(", ") || "None"}</dd></div>
                {winnerProduct?.dietary_claims?.length ? (
                  <div><dt>Matched dietary claims</dt><dd>{winnerProduct.dietary_claims.join(", ")}</dd></div>
                ) : null}
              </dl>
              {trace[0] && <p className="flow-raw-trace">{trace[0]}</p>}
            </div>
          )}
        </div>

        <div className="flow-connector" aria-hidden="true"><ArrowDown size={14} /></div>

        {/* NODE 2: GOOD-BETTER-BEST RANKING */}
        <div className={`flow-node ${openNode === 2 ? "expanded" : ""}`} role="listitem">
          <button type="button" className="flow-node-trigger" onClick={() => toggle(2)} aria-expanded={openNode === 2}>
            <span className="flow-node-icon blue"><Trophy size={15} /></span>
            <span className="flow-node-main">
              <small>2 · Priority Ranking ({priorityMode.replace("_", " ")})</small>
              <strong>{step2Headline}</strong>
            </span>
            <span className="flow-node-badge">{step2Badge}</span>
            <span className="flow-node-chevron">{openNode === 2 ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
          </button>
          {openNode === 2 && (
            <div className="flow-node-details">
              {options.length > 0 ? (
                <div className="flow-candidates">
                  {options.slice(0, 3).map((opt, idx) => {
                    const p = opt.product;
                    const tier = (opt.tier ?? (idx === 0 ? "best" : idx === 1 ? "better" : "good")).toUpperCase();
                    return (
                      <div key={p.product_id} className={`flow-candidate-card ${idx === 0 ? "winner" : ""}`}>
                        <div className="flow-candidate-top">
                          <span className={`flow-tier-pill ${tier.toLowerCase()}`}>#{idx + 1} · {tier}</span>
                          <strong>SKU {p.product_id} — {p.name}</strong>
                        </div>
                        {p.name_fi && <p className="flow-subtext">FI: {p.name_fi} {p.vendor ? `· ${p.vendor}` : ""} {p.country_of_origin ? `(${p.country_of_origin.toUpperCase()})` : ""}</p>}
                        <div className="flow-candidate-metrics">
                          <span><strong>Unit:</strong> {p.unit}</span>
                          <span><strong>Reliability:</strong> {p.delivery_reliability != null ? `${(p.delivery_reliability * 100).toFixed(1)}%` : "N/A"}</span>
                          <span><strong>CO2:</strong> {p.carbon_footprint_kg != null ? `${p.carbon_footprint_kg.toFixed(2)} kg CO2e/kg` : "Cat median"}</span>
                          <span><strong>Price:</strong> {p.comparison_price_cents != null && p.comparison_unit ? `${money(p.comparison_price_cents)}/${p.comparison_unit}` : p.unit_price_cents != null ? `${money(p.unit_price_cents)}/${p.unit}` : "Verified"}</span>
                        </div>
                        {p.sustainability_labels && p.sustainability_labels.length > 0 && (
                          <p className="flow-subtext"><strong>Certificates & CO2 range:</strong> {p.sustainability_labels.join(" · ")}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="flow-raw-trace">{trace[1] ?? "Ranked top SKU by delivery reliability, carbon footprint, and comparison price."}</p>
              )}
            </div>
          )}
        </div>

        <div className="flow-connector" aria-hidden="true"><ArrowDown size={14} /></div>

        {/* NODE 3: PACK MATH & LIVE STOCK / SUBSTITUTION */}
        <div className={`flow-node ${openNode === 3 ? "expanded" : ""} ${isSubstituted ? "attention" : ""}`} role="listitem">
          <button type="button" className="flow-node-trigger" onClick={() => toggle(3)} aria-expanded={openNode === 3}>
            <span className={`flow-node-icon ${isSubstituted ? "orange" : "turquoise"}`}>
              {isSubstituted ? <ArrowDownUp size={15} /> : <PackageCheck size={15} />}
            </span>
            <span className="flow-node-main">
              <small>{isSubstituted ? "3 · Stock-Out Auto-Substitution" : "3 · Wholesale Pack Math & Live Stock"}</small>
              <strong>{step3Headline}</strong>
            </span>
            <span className={`flow-node-badge ${isSubstituted ? "warning" : ""}`}>{step3Badge}</span>
            <span className="flow-node-chevron">{openNode === 3 ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
          </button>
          {openNode === 3 && (
            <div className="flow-node-details">
              {isSubstituted && (
                <div className="flow-substitution-branch">
                  <span className="flow-branch-bad">Primary SKU Out of Stock / Shortfall ({firstItem?.substituted_for ?? winnerProduct?.product_id})</span>
                  <span>➔</span>
                  <span className="flow-branch-good">Swapped to [BETTER] SKU {firstItem?.product_id} — {firstItem?.name}</span>
                </div>
              )}
              <dl className="flow-detail-grid">
                {parsedLine && bestOption && (
                  <div>
                    <dt>Pack conversion formula</dt>
                    <dd><code>ceil({parsedLine.target_volume_liters_or_kg} ÷ {bestOption.product.net_volume_liters_or_kg ?? 1}) = {firstItem?.quantity ?? bestOption.recommended_packs} × {firstItem?.unit ?? bestOption.product.unit}</code></dd>
                  </div>
                )}
                {firstItem && (
                  <div>
                    <dt>Locked unit price (+tax)</dt>
                    <dd>{firstItem.unit_price_cents != null ? `${money(firstItem.unit_price_cents)} per ${firstItem.unit}` : money(activeOrder!.total_cents / Math.max(firstItem.quantity, 1))}</dd>
                  </div>
                )}
                <div>
                  <dt>Live Valio Aimo stock</dt>
                  <dd>{bestOption?.available_packs == null ? "Terminal direct-delivery stock (Unlimited)" : `${bestOption.available_packs} packs in warehouse`}</dd>
                </div>
              </dl>
              {trace[2] && <p className="flow-raw-trace">{trace[2]}</p>}
            </div>
          )}
        </div>

        <div className="flow-connector" aria-hidden="true"><ArrowDown size={14} /></div>

        {/* NODE 4: GUARDRAIL & APPROVAL DECISION */}
        <div className={`flow-node ${openNode === 4 ? "expanded" : ""}`} role="listitem">
          <button type="button" className="flow-node-trigger" onClick={() => toggle(4)} aria-expanded={openNode === 4}>
            <span className={`flow-node-icon ${activeOrder?.status === "pending" ? "orange" : "turquoise"}`}>
              {activeOrder?.status === "pending" ? <ShieldAlert size={15} /> : <ShieldCheck size={15} />}
            </span>
            <span className="flow-node-main">
              <small>4 · Guardrail & Approval Check</small>
              <strong>{step4Headline}</strong>
            </span>
            {activeOrder && (
              <span className={`status ${activeOrder.status}`}><span />{statusLabels[activeOrder.status]}</span>
            )}
            <span className="flow-node-chevron">{openNode === 4 ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
          </button>
          {openNode === 4 && (
            <div className="flow-node-details">
              <ul className="flow-guardrail-list">
                <li>
                  <Check size={13} />
                  <span><strong>Workspace auto-approve limit:</strong> {money(guardrails?.max_auto_approve_cents ?? 25000)} ({activeOrder && activeOrder.total_cents <= (guardrails?.max_auto_approve_cents ?? 25000) ? "Passed" : "Requires human sign-off"})</span>
                </li>
                <li>
                  <Check size={13} />
                  <span><strong>Restricted allergens check:</strong> {(guardrails?.review_allergens ?? ["gluten", "nuts"]).join(", ") || "None"}</span>
                </li>
                <li>
                  <Check size={13} />
                  <span><strong>Substitution policy:</strong> {isSubstituted ? "Substituted SKU flagged for human review" : "Primary SKU fulfilled without substitution"}</span>
                </li>
                {activeOrder?.total_carbon_kg != null && (
                  <li>
                    <Check size={13} />
                    <span><strong>Estimated order carbon footprint:</strong> {activeOrder.total_carbon_kg.toFixed(2)} kg CO2e</span>
                  </li>
                )}
              </ul>
              {activeOrder && activeOrder.reasons.length > 0 && (
                <div className="decision-note attention" style={{ marginTop: 8 }}>
                  <strong>Escalated to Approval Centre:</strong> {activeOrder.reasons.join(" · ")}
                  {activeOrder.status === "pending" && onOpenApprovals && (
                    <div style={{ marginTop: 8 }}>
                      <button type="button" className="secondary-button" onClick={onOpenApprovals}>
                        Open Approval Centre →
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flow-connector" aria-hidden="true"><ArrowDown size={14} /></div>

        {/* NODE 5: TRUST & PRIVACY RECEIPT */}
        <div className={`flow-node ${openNode === 5 ? "expanded" : ""}`} role="listitem">
          <button type="button" className="flow-node-trigger" onClick={() => toggle(5)} aria-expanded={openNode === 5}>
            <span className="flow-node-icon sky"><Lock size={15} /></span>
            <span className="flow-node-main">
              <small>5 · Verifiable Quote Lock & Privacy</small>
              <strong>{step5Headline}</strong>
            </span>
            <span className="flow-node-badge">HMAC-SHA256</span>
            <span className="flow-node-chevron">{openNode === 5 ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
          </button>
          {openNode === 5 && (
            <div className="flow-node-details">
              <dl className="flow-detail-grid">
                <div><dt>Trust protocol</dt><dd><code>{tv?.protocol ?? "keittio-valio-trust-v1"}</code></dd></div>
                {tv?.quote_lock_id && <div><dt>Quote lock ID</dt><dd><code>{tv.quote_lock_id}</code></dd></div>}
                {tv?.signature_hmac_sha256 && <div><dt>HMAC-SHA256 signature</dt><dd><code>{tv.signature_hmac_sha256.slice(0, 28)}…</code></dd></div>}
                {tv?.earliest_closing_time && <div><dt>Order cutoff time</dt><dd>{tv.earliest_closing_time}</dd></div>}
                <div><dt>Orchestrator & audit model</dt><dd><code>{tv?.privacy_audit_model ?? execution?.orchestrator_model ?? "models/gemma-4-26b-a4b-it"}</code></dd></div>
                {tv?.privacy_audit_summary && <div><dt>Margin & data protection</dt><dd>{tv.privacy_audit_summary}</dd></div>}
                {tv?.redacted_confidential_fields?.length ? (
                  <div><dt>Redacted wholesale fields</dt><dd><code>{tv.redacted_confidential_fields.join(", ")}</code></dd></div>
                ) : null}
              </dl>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
