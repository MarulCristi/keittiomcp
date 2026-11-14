"use client";

import { useState } from "react";
import {
  AlertTriangle, ArrowDownUp, Award, Ban, CheckCircle2, ChevronDown,
  Filter, Leaf, Lock, MapPin, PackageCheck, ShieldAlert, ShieldCheck,
  Sparkles, Trophy, Truck,
} from "lucide-react";
import {
  money, statusLabels,
  type AgentExecutionResult, type Guardrails, type Order, type PriorityMode, type Product,
} from "../lib/purchasing";
import { ProductThumbnail } from "./web-image-references";

const PRIORITY_LABELS: Record<PriorityMode, string> = {
  balanced: "Balanced (Reliability + Carbon + Price)",
  low_carbon: "Lowest Carbon Footprint (Sustainability First)",
  lowest_price: "Lowest Price / Budget First",
  authentic_finnish: "Authentic Finnish Origin (Blue Swan / Key Flag)",
  highest_reliability: "Highest Delivery Reliability (100% On-Time)",
};

function renderCodeTokens(text: string) {
  const parts = text.split(/(`[^`]+`|\b(?:SKU\s+\S+|GS1\s+Cat\s+\S+|PO-\d+|QLOCK-[A-Z0-9-]+)\b)/gi);
  return parts.map((part, idx) => {
    if (!part) return null;
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={idx} className="step-inline-code">{part.slice(1, -1)}</code>;
    }
    if (/^(?:SKU\s+\S+|GS1\s+Cat\s+\S+|PO-\d+|QLOCK-[A-Z0-9-]+)$/i.test(part)) {
      return <code key={idx} className="step-inline-code">{part}</code>;
    }
    return <span key={idx}>{part}</span>;
  });
}

function splitCertificatesAndCo2Range(labels: string[] = []) {
  const certificates: string[] = [];
  let co2Range: string | null = null;
  for (const label of labels) {
    if (/^Cat\s+\d+\s+CO2\s+Range:/i.test(label)) {
      co2Range = label.replace(/^Cat\s+\d+\s+CO2\s+Range:\s*/i, "");
    } else if (label.trim()) {
      certificates.push(label);
    }
  }
  return { certificates, co2Range };
}

function formatComparisonPrice(product: Product, unitHint?: string): string | null {
  if (product.comparison_price_cents != null && product.comparison_unit) {
    return `${money(product.comparison_price_cents)}/${product.comparison_unit}`;
  }
  if (product.unit_price_cents != null && product.net_volume_liters_or_kg && product.net_volume_liters_or_kg > 0) {
    const perBase = Math.round(product.unit_price_cents / product.net_volume_liters_or_kg);
    const inferredUnit = /\bL\b|\bml\b/i.test(product.unit) || unitHint === "L" ? "L" : "kg";
    return `${money(perBase)}/${inferredUnit}`;
  }
  return null;
}

type Props = {
  execution?: AgentExecutionResult | null;
  order?: Order | null;
  guardrails?: Guardrails | null;
  thinkingFallback?: string[];
  onOpenApprovals?: () => void;
};

export default function DecisionFlowDiagram({
  execution,
  order: propOrder,
  guardrails,
  thinkingFallback = [],
  onOpenApprovals,
}: Props) {
  const [openSteps, setOpenSteps] = useState<Record<number, boolean>>({});

  const activeOrder = execution?.order ?? propOrder ?? null;
  const trace = execution?.decision_trace?.length
    ? execution.decision_trace
    : activeOrder?.decision_trace?.length
      ? activeOrder.decision_trace
      : thinkingFallback;
  const plan = execution?.plans?.[0];
  const options = plan?.options ?? [];
  const parsedLine = execution?.parsed_lines?.[0];
  const bestOption = options[0];
  const firstItem = activeOrder?.items?.[0];
  const chosenSkuId = firstItem?.product_id ?? bestOption?.product.product_id ?? null;
  const isSubstituted = Boolean(firstItem?.is_substitution || trace.some((s) => /Auto-Substitution/i.test(s)));
  const isRejected = Boolean(execution?.rejected);
  const rejectedProducts = execution?.rejected_products ?? [];
  const excludedSet = new Set(parsedLine?.exclude_allergens ?? guardrails?.review_allergens ?? []);
  const activePriorities: PriorityMode[] = execution?.priority_modes?.length
    ? execution.priority_modes
    : guardrails?.priority_modes?.length
      ? guardrails.priority_modes
      : [execution?.priority_mode ?? guardrails?.priority_mode ?? "balanced"];
  const priorityMode: PriorityMode = activePriorities[0] ?? "balanced";
  const priorityTitle = activePriorities.length > 1
    ? activePriorities.map((m) => PRIORITY_LABELS[m].split(" (")[0]).join(" + ")
    : PRIORITY_LABELS[priorityMode];
  const maxApproveCents = guardrails?.max_auto_approve_cents ?? 25000;

  if (!execution && !activeOrder && trace.length === 0) return null;

  const toggle = (index: number) => {
    setOpenSteps((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  const winnerProduct = bestOption?.product;
  const tv = activeOrder?.trust_verification;

  const step1Summary = parsedLine ? (
    <>
      <code>{parsedLine.target_volume_liters_or_kg.toLocaleString("en-GB")} {parsedLine.unit_hint}</code>{" "}
      <code>{parsedLine.query}</code>
    </>
  ) : (
    renderCodeTokens(trace[0]?.replace(/^\d+\.\s*[^:]+:\s*/, "").split("·")[0]?.trim() ?? "Catalog & dietary filter")
  );
  const step1Badge = bestOption?.product.category
    ? `GS1 Cat ${bestOption.product.category}`
    : (trace[0]?.match(/GS1 Cat\s+(\S+)/i)?.[1] ? `GS1 Cat ${trace[0].match(/GS1 Cat\s+(\S+)/i)?.[1]}` : "Filtered");

  const step2SkuId = winnerProduct?.product_id ?? firstItem?.product_id;
  const step2Name = winnerProduct?.name ?? firstItem?.name;
  const step2Summary = step2SkuId ? (
    <>
      <code>SKU {step2SkuId}</code> — {step2Name}
    </>
  ) : (
    renderCodeTokens(trace[1]?.replace(/^\d+\.\s*[^:]+:\s*/, "") ?? "Ranked candidates")
  );
  const step2Badge = winnerProduct?.delivery_reliability != null
    ? `${(winnerProduct.delivery_reliability * 100).toFixed(0)}% on-time`
    : activeOrder?.min_reliability != null
      ? `${(activeOrder.min_reliability * 100).toFixed(0)}% on-time`
      : PRIORITY_LABELS[priorityMode].split(" ")[0];

  const step3Summary = isRejected ? (
    <>
      <code>0 safe SKUs</code> — skipped pack math
    </>
  ) : firstItem ? (
    <code>{firstItem.quantity.toLocaleString("en-GB")} × {firstItem.unit}</code>
  ) : bestOption ? (
    <code>{bestOption.recommended_packs ?? 1} × {bestOption.product.unit}</code>
  ) : (
    <code>Pack math verified</code>
  );
  const step3Badge = isRejected ? "Ignored" : isSubstituted ? "Auto-Substituted" : "Stock Verified";

  const step4Summary = isRejected ? (
    <>
      <code>REJECTED</code> · No order placed
    </>
  ) : activeOrder ? (
    <>
      <code>{activeOrder.id}</code> · <code>{money(activeOrder.total_cents)}</code>
    </>
  ) : (
    <code>Prepared plan</code>
  );
  const step4Badge = isRejected ? "Rejected" : activeOrder ? statusLabels[activeOrder.status] : "Quote ready";

  return (
    <div className="decision-inline">
      {/* 1. Minimalistic Click-to-Expand Thinking Steps */}
      <div className="thinking-steps" role="list" aria-label="Agent thinking steps">
        {/* Step 1 */}
        <div className={`step-pill ${openSteps[1] ? "is-open" : ""}`} role="listitem">
          <button
            type="button"
            className="step-pill-trigger"
            onClick={() => toggle(1)}
            aria-expanded={Boolean(openSteps[1])}
          >
            <span className="step-pill-icon sky"><Filter size={13} /></span>
            <span className="step-pill-label">Step 1</span>
            <span className="step-pill-title">Category &amp; Dietary Filter</span>
            <span className="step-pill-summary">{step1Summary}</span>
            <code className="step-pill-code">{step1Badge}</code>
            <ChevronDown size={14} className="step-pill-chevron" />
          </button>
          <div className="step-dropdown" aria-hidden={!openSteps[1]}>
            <div className="step-dropdown-inner">
              <div className="step-console-grid">
                <div><span>Request</span><code>{execution?.prompt ?? (parsedLine ? `${parsedLine.target_volume_liters_or_kg} ${parsedLine.unit_hint} ${parsedLine.query}` : "Kitchen query")}</code></div>
                {parsedLine && (
                  <div><span>Target volume</span><code>{parsedLine.target_volume_liters_or_kg.toLocaleString("en-GB")} {parsedLine.unit_hint}</code></div>
                )}
                <div><span>Delivery date</span><code>{execution?.requested_date ?? tv?.requested_delivery_date ?? "2026-11-16"}</code></div>
                <div><span>Excluded allergens</span><code>{(parsedLine?.exclude_allergens ?? guardrails?.review_allergens ?? []).join(", ") || "None"}</code></div>
                <div><span>Kitchen priority</span><strong>{priorityTitle}</strong></div>
              </div>
              {trace[0] && <pre className="step-console-line">{renderCodeTokens(trace[0])}</pre>}
            </div>
          </div>
        </div>

        {/* Step 2 */}
        <div className={`step-pill ${openSteps[2] ? "is-open" : ""}`} role="listitem">
          <button
            type="button"
            className="step-pill-trigger"
            onClick={() => toggle(2)}
            aria-expanded={Boolean(openSteps[2])}
          >
            <span className="step-pill-icon blue"><Trophy size={13} /></span>
            <span className="step-pill-label">Step 2</span>
            <span className="step-pill-title">Priority Ranking</span>
            <span className="step-pill-summary">{step2Summary}</span>
            <code className="step-pill-code">{step2Badge}</code>
            <ChevronDown size={14} className="step-pill-chevron" />
          </button>
          <div className="step-dropdown" aria-hidden={!openSteps[2]}>
            <div className="step-dropdown-inner">
              <p className="step-explain-text">
                Evaluated {options.length > 0 ? `top ${options.length} pure & category-matched Valio Aimo SKUs` : "catalog matches"} under{" "}
                <strong>{priorityTitle}</strong> weighting (ingredient purity tier, delivery reliability, CO₂e/kg vs category median, and comparison price/kg or L).
              </p>
              {trace[1] && <pre className="step-console-line">{renderCodeTokens(trace[1])}</pre>}
            </div>
          </div>
        </div>

        {/* Step 3 */}
        <div className={`step-pill ${openSteps[3] ? "is-open" : ""} ${isSubstituted ? "is-warning" : ""}`} role="listitem">
          <button
            type="button"
            className="step-pill-trigger"
            onClick={() => toggle(3)}
            aria-expanded={Boolean(openSteps[3])}
          >
            <span className={`step-pill-icon ${isSubstituted ? "orange" : "turquoise"}`}>
              {isSubstituted ? <ArrowDownUp size={13} /> : <PackageCheck size={13} />}
            </span>
            <span className="step-pill-label">Step 3</span>
            <span className="step-pill-title">Pack Math &amp; Live Stock</span>
            <span className="step-pill-summary">{step3Summary}</span>
            <code className={`step-pill-code ${isSubstituted ? "warn" : ""}`}>{step3Badge}</code>
            <ChevronDown size={14} className="step-pill-chevron" />
          </button>
          <div className="step-dropdown" aria-hidden={!openSteps[3]}>
            <div className="step-dropdown-inner">
              {isSubstituted && (
                <div className="step-sub-alert">
                  <ArrowDownUp size={14} />
                  <span>
                    Primary SKU <code>{firstItem?.substituted_for ?? winnerProduct?.product_id}</code> had insufficient live stock and was auto-substituted to{" "}
                    <code>SKU {firstItem?.product_id}</code> — <strong>{firstItem?.name}</strong>.
                  </span>
                </div>
              )}
              <div className="step-console-grid">
                {parsedLine && bestOption && (
                  <div>
                    <span>Pack formula</span>
                    <code>ceil({parsedLine.target_volume_liters_or_kg} ÷ {bestOption.product.net_volume_liters_or_kg ?? 1}) = {firstItem?.quantity ?? bestOption.recommended_packs} × {firstItem?.unit ?? bestOption.product.unit}</code>
                  </div>
                )}
                {firstItem && (
                  <div>
                    <span>Locked unit price</span>
                    <code>{firstItem.unit_price_cents != null ? `${money(firstItem.unit_price_cents)} / ${firstItem.unit}` : "Verified"}</code>
                  </div>
                )}
                <div>
                  <span>Warehouse stock</span>
                  <code>{bestOption?.available_packs == null ? "Direct terminal allocation" : `${bestOption.available_packs} packs available`}</code>
                </div>
              </div>
              {trace[2] && <pre className="step-console-line">{renderCodeTokens(trace[2])}</pre>}
            </div>
          </div>
        </div>

        {/* Step 4 */}
        <div className={`step-pill ${openSteps[4] ? "is-open" : ""} ${isRejected || activeOrder?.status === "pending" ? "is-warning" : ""}`} role="listitem">
          <button
            type="button"
            className="step-pill-trigger"
            onClick={() => toggle(4)}
            aria-expanded={Boolean(openSteps[4])}
          >
            <span className={`step-pill-icon ${isRejected || activeOrder?.status === "pending" ? "orange" : "navy"}`}>
              {isRejected ? <Ban size={13} /> : activeOrder?.status === "pending" ? <ShieldAlert size={13} /> : <Lock size={13} />}
            </span>
            <span className="step-pill-label">Step 4</span>
            <span className="step-pill-title">Guardrails &amp; Quote Lock</span>
            <span className="step-pill-summary">{step4Summary}</span>
            <code className={`step-pill-code ${isRejected || activeOrder?.status === "pending" ? "warn" : "ok"}`}>{step4Badge}</code>
            <ChevronDown size={14} className="step-pill-chevron" />
          </button>
          <div className="step-dropdown" aria-hidden={!openSteps[4]}>
            <div className="step-dropdown-inner">
              <div className="step-console-grid">
                <div><span>Auto-approve limit</span><code>{money(maxApproveCents)}</code></div>
                <div><span>Order total</span><code>{isRejected ? "€0.00 (Rejected)" : activeOrder ? money(activeOrder.total_cents) : "N/A"}</code></div>
                <div><span>Excluded allergens</span><code>{Array.from(excludedSet).join(", ") || "None"}</code></div>
                <div><span>Trust protocol</span><code>{tv?.protocol ?? "keittio-valio-trust-v1"}</code></div>
                {tv?.quote_lock_id && <div><span>Quote lock ID</span><code>{tv.quote_lock_id}</code></div>}
                {tv?.signature_hmac_sha256 && (
                  <div><span>HMAC-SHA256</span><code>{tv.signature_hmac_sha256.slice(0, 24)}…</code></div>
                )}
                <div><span>Privacy audit model</span><code>{tv?.privacy_audit_model ?? execution?.orchestrator_model ?? "models/gemma-4-26b-a4b-it"}</code></div>
              </div>
              {tv?.privacy_audit_summary && (
                <p className="step-explain-text" style={{ marginTop: 8 }}>{tv.privacy_audit_summary}</p>
              )}
              {trace[3] && <pre className="step-console-line">{renderCodeTokens(trace[3])}</pre>}
            </div>
          </div>
        </div>
      </div>

      {/* 2B. Rejected Allergen Candidates (shown with images when 0 safe matches exist) */}
      {isRejected && (
        <>
          {rejectedProducts.length > 0 && (
            <section className="choices-section choices-rejected" aria-label="Catalog matches rejected by allergen exclusions">
              <div className="choices-header">
                <span className="choices-eyebrow"><Ban size={13} /> Matched catalog items ignored ({rejectedProducts.length})</span>
                <span className="choice-rejected-pill">Contains excluded allergen</span>
              </div>
              <div className="choices-list">
                {rejectedProducts.slice(0, 3).map((p, idx) => {
                  const compPrice = formatComparisonPrice(p, parsedLine?.unit_hint);
                  const { certificates, co2Range } = splitCertificatesAndCo2Range(p.sustainability_labels);
                  const matchingExcluded = (p.allergens ?? []).filter((a) => excludedSet.has(a));
                  return (
                    <article key={p.product_id} className="choice-row is-rejected">
                      <div className="choice-media">
                        <ProductThumbnail
                          productId={p.product_id}
                          query={p.name_fi || p.name}
                          alt={p.name}
                        />
                      </div>
                      <div className="choice-content">
                        <div className="choice-title-line">
                          <h4>{idx + 1}. {p.name}</h4>
                          <code className="choice-sku-code">SKU {p.product_id}</code>
                          <span className="choice-rejected-pill">
                            <Ban size={11} /> Ignored · Contains {(matchingExcluded.length ? matchingExcluded : (p.allergens ?? [])).join(", ")}
                          </span>
                        </div>
                        {(p.name_fi || p.vendor) && (
                          <p className="choice-subline">
                            {p.name_fi && p.name_fi !== p.name ? <span>{p.name_fi}</span> : null}
                            {p.name_fi && p.name_fi !== p.name && p.vendor ? " · " : null}
                            {p.vendor ? <span>{p.vendor}</span> : null}
                          </p>
                        )}
                        <div className="choice-pricing-row">
                          <div className="choice-metric-box">
                            <span className="metric-lbl">Pack price</span>
                            <strong>{p.unit_price_cents != null ? money(p.unit_price_cents) : "N/A"} <small>/ {p.unit}</small></strong>
                          </div>
                          {compPrice && (
                            <div className="choice-metric-box">
                              <span className="metric-lbl">Comparison price</span>
                              <strong>{compPrice}</strong>
                            </div>
                          )}
                        </div>
                        <div className="choice-attributes">
                          <span className="attr-pill origin">
                            <MapPin size={12} /> <strong>Origin:</strong> {p.country_of_origin ? p.country_of_origin.toUpperCase() : "N/A"}
                          </span>
                          <span className="attr-pill carbon">
                            <Leaf size={12} /> <strong>Carbon:</strong> {p.carbon_footprint_kg != null ? `${p.carbon_footprint_kg.toFixed(2)} kg CO₂e/kg` : "Cat median"}
                            {co2Range ? ` (${co2Range})` : ""}
                          </span>
                          <span className="attr-pill allergen-hit">
                            <ShieldAlert size={12} /> <strong>Allergens:</strong> {(p.allergens ?? []).join(", ") || "Listed"}
                          </span>
                        </div>
                        {certificates.length > 0 && (
                          <div className="choice-certs-row">
                            <span className="cert-lbl"><Award size={12} /> Certificates:</span>
                            <div className="cert-tags">
                              {certificates.map((cert) => <span key={cert} className="cert-tag">{cert}</span>)}
                            </div>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          <section className="outcome-banner is-rejected" role="alert" aria-label="Request rejected due to allergen exclusions">
            <div className="outcome-top">
              <div className="outcome-title-wrap">
                <span className="outcome-badge rejected"><Ban size={14} /> Rejected</span>
                <h3>No Allergen-Safe Match Found</h3>
              </div>
              <div className="outcome-total">
                <span>Excluded allergens</span>
                <strong style={{ fontSize: 16 }}>{Array.from(excludedSet).join(", ") || "Strict rule"}</strong>
              </div>
            </div>
            <div className="outcome-why-rejected">
              <div className="why-pending-heading">
                <ShieldAlert size={20} />
                <h4>Rejected Automatically — Zero Products Without Excluded Allergens</h4>
              </div>
              <p className="why-rejected-text">
                {execution?.rejection_reason ?? `Every matching catalog item contains an excluded company allergen (${Array.from(excludedSet).join(", ")}). Products containing excluded allergens are automatically ignored as highest priority, so no order was placed.`}
              </p>
            </div>
          </section>
        </>
      )}

      {/* 2. Top 3 Choices Compared (ChatGPT horizontal card layout with left thumbnail) */}
      {options.length > 0 && (
        <section className="choices-section" aria-label="Top product choices compared">
          <div className="choices-header">
            <span className="choices-eyebrow"><Sparkles size={13} /> Top {Math.min(options.length, 3)} choices compared</span>
            <span className="choices-priority-tag">{priorityTitle}</span>
          </div>
          <div className="choices-list">
            {options.slice(0, 3).map((opt, idx) => {
              const p = opt.product;
              const tier = (opt.tier ?? (idx === 0 ? "best" : idx === 1 ? "better" : "good")).toUpperCase();
              const isSelectedCandidate = chosenSkuId != null && p.product_id === chosenSkuId;
              const compPrice = formatComparisonPrice(p, parsedLine?.unit_hint);
              const { certificates, co2Range } = splitCertificatesAndCo2Range(p.sustainability_labels);
              const shortfallOut = opt.can_fulfill_full_volume === false || (isSubstituted && idx === 0 && !isSelectedCandidate);

              return (
                <article
                  key={p.product_id}
                  className={`choice-row ${isSelectedCandidate ? "is-selected" : ""} ${shortfallOut ? "is-shortfall" : ""}`}
                >
                  <div className="choice-media">
                    <ProductThumbnail
                      productId={p.product_id}
                      query={p.name_fi || p.name}
                      alt={p.name}
                    />
                  </div>
                  <div className="choice-content">
                    <div className="choice-title-line">
                      <h4>{idx + 1}. {p.name}</h4>
                      <span className={`choice-tier-badge ${tier.toLowerCase()}`}>{tier}</span>
                      <code className="choice-sku-code">SKU {p.product_id}</code>
                      {isSelectedCandidate && (
                        <span className={`choice-selected-pill ${isSubstituted ? "substituted" : ""}`}>
                          <CheckCircle2 size={12} /> {isSubstituted ? "Selected (Auto-Substituted)" : "Selected"}
                        </span>
                      )}
                      {shortfallOut && !isSelectedCandidate && (
                        <span className="choice-shortfall-pill">Stock shortfall</span>
                      )}
                    </div>

                    {(p.name_fi || p.vendor) && (
                      <p className="choice-subline">
                        {p.name_fi && p.name_fi !== p.name ? <span>{p.name_fi}</span> : null}
                        {p.name_fi && p.name_fi !== p.name && p.vendor ? " · " : null}
                        {p.vendor ? <span>{p.vendor}</span> : null}
                      </p>
                    )}

                    {/* Prominent Price & Order Math strip */}
                    <div className="choice-pricing-row">
                      <div className="choice-metric-box">
                        <span className="metric-lbl">Pack price</span>
                        <strong>
                          {p.unit_price_cents != null ? money(p.unit_price_cents) : "N/A"}{" "}
                          <small>/ {p.unit}</small>
                        </strong>
                      </div>
                      {compPrice && (
                        <div className="choice-metric-box highlight">
                          <span className="metric-lbl">Comparison price</span>
                          <strong>{compPrice}</strong>
                        </div>
                      )}
                      {opt.recommended_packs != null && (
                        <div className="choice-metric-box">
                          <span className="metric-lbl">Pack total</span>
                          <strong>
                            {opt.recommended_packs} × {p.unit.split(" ")[0]}
                            {opt.total_price_cents != null ? ` = ${money(opt.total_price_cents)}` : ""}
                          </strong>
                        </div>
                      )}
                    </div>

                    {/* Clearly labeled decision attributes */}
                    <div className="choice-attributes">
                      <span className="attr-pill origin">
                        <MapPin size={12} /> <strong>Origin:</strong> {p.country_of_origin ? p.country_of_origin.toUpperCase() : "N/A"}
                      </span>
                      <span className={`attr-pill ${p.delivery_reliability != null && p.delivery_reliability >= 0.95 ? "good" : "neutral"}`}>
                        <Truck size={12} /> <strong>Reliability:</strong>{" "}
                        {p.delivery_reliability != null ? `${(p.delivery_reliability * 100).toFixed(1)}% on-time` : "Unrated"}
                      </span>
                      <span className="attr-pill carbon">
                        <Leaf size={12} /> <strong>Carbon:</strong>{" "}
                        {p.carbon_footprint_kg != null ? `${p.carbon_footprint_kg.toFixed(2)} kg CO₂e/kg` : "Cat median"}
                        {co2Range ? ` (${co2Range})` : ""}
                      </span>
                    </div>

                    {/* Certificates row */}
                    {(certificates.length > 0 || (p.dietary_claims && p.dietary_claims.length > 0)) && (
                      <div className="choice-certs-row">
                        <span className="cert-lbl"><Award size={12} /> Certificates &amp; Claims:</span>
                        <div className="cert-tags">
                          {certificates.map((cert) => (
                            <span key={cert} className="cert-tag">{cert}</span>
                          ))}
                          {p.dietary_claims?.map((claim) => (
                            <span key={claim} className="diet-tag">{claim.replace(/_/g, " ")}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* 3. Final Decision & Crystal-Clear Approval Outcome */}
      {activeOrder && (
        <section
          className={`outcome-banner ${
            activeOrder.status === "rejected"
              ? "is-rejected"
              : activeOrder.status === "pending"
                ? "is-pending"
                : "is-approved"
          }`}
          aria-label="Selected product and order decision"
        >
          <div className="outcome-top">
            <div className="outcome-title-wrap">
              <span
                className={`outcome-badge ${
                  activeOrder.status === "rejected"
                    ? "rejected"
                    : activeOrder.status === "pending"
                      ? "pending"
                      : "approved"
                }`}
              >
                {activeOrder.status === "rejected" ? (
                  <Ban size={14} />
                ) : activeOrder.status === "pending" ? (
                  <AlertTriangle size={14} />
                ) : (
                  <ShieldCheck size={14} />
                )}
                {activeOrder.status === "rejected"
                  ? "Denied / Rejected"
                  : activeOrder.status === "pending"
                    ? "Pending Approval"
                    : activeOrder.status === "auto_approved"
                      ? "Auto-Approved"
                      : "Approved"}
              </span>
              {isSubstituted && (
                <span className="outcome-badge substituted">
                  <ArrowDownUp size={13} /> Auto-Substituted
                </span>
              )}
              <h3>
                {firstItem ? firstItem.name : `Order ${activeOrder.id}`}
              </h3>
              {firstItem && <code className="outcome-sku">SKU {firstItem.product_id}</code>}
            </div>
            <div className="outcome-total">
              <span>Order <code>{activeOrder.id}</code></span>
              <strong>{money(activeOrder.total_cents)}</strong>
            </div>
          </div>

          {firstItem && (
            <div className="outcome-specs">
              <span>
                <strong>Quantity:</strong> {firstItem.quantity.toLocaleString("en-GB")} × {firstItem.unit}
              </span>
              {firstItem.unit_price_cents != null && (
                <span>
                  <strong>Unit price:</strong> {money(firstItem.unit_price_cents)}
                </span>
              )}
              {activeOrder.total_carbon_kg != null && (
                <span>
                  <strong>Order CO₂:</strong> {activeOrder.total_carbon_kg.toFixed(2)} kg CO₂e
                </span>
              )}
              {tv?.quote_lock_id && (
                <span>
                  <strong>Quote lock:</strong> <code>{tv.quote_lock_id}</code>
                </span>
              )}
            </div>
          )}

          {activeOrder.status === "rejected" ? (
            <div className="outcome-why-rejected">
              <div className="why-pending-heading">
                <Ban size={18} />
                <h4>Order {activeOrder.id} Denied / Rejected</h4>
              </div>
              <p className="why-rejected-text">
                {activeOrder.reasons?.length ? activeOrder.reasons.join(" · ") : "Order was denied by kitchen guardrails or human reviewer."}
              </p>
            </div>
          ) : activeOrder.status === "pending" ? (
            <div className="outcome-why-pending">
              <div className="why-pending-heading">
                <ShieldAlert size={20} />
                <h4>Why Order {activeOrder.id} Was Not Auto-Approved</h4>
              </div>
              <ul className="why-pending-reasons">
                {(activeOrder.reasons.length > 0
                  ? activeOrder.reasons
                  : [`Total ${money(activeOrder.total_cents)} exceeds auto-approve guardrails`]
                ).map((reason, rIdx) => (
                  <li key={rIdx}>{reason}</li>
                ))}
              </ul>
              {onOpenApprovals && (
                <div className="why-pending-actions">
                  <button type="button" className="primary-button" onClick={onOpenApprovals}>
                    Review &amp; Approve in Approval Centre →
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="outcome-approved-strip">
              <CheckCircle2 size={18} />
              <div>
                <strong>Auto-Approved Automatically</strong>
                <p>
                  Order total ({money(activeOrder.total_cents)}) is within your {money(maxApproveCents)} workspace auto-approve limit and passed all allergen, reliability, and substitution guardrails.
                </p>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
