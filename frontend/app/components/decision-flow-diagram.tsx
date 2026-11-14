"use client";

import { useState } from "react";
import {
  AlertTriangle, ArrowDownUp, Award, Ban, CheckCircle2, ChevronDown,
  Filter, Leaf, MapPin, ShieldAlert, ShieldCheck,
  Sparkles, Truck,
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

const GS1_CATEGORY_LABELS: Record<string, string> = {
  "10400": "Milk & Milk Drinks",
  "10401": "Cream & Cooking Dairy",
  "10402": "Plant-Based Cream & Drinks",
  "10405": "Milk Powder",
  "10406": "Flavoured Cream & Plant Drinks",
  "10411": "Yoghurt & Fermented Dairy",
  "10412": "Quark & Viili",
  "10413": "Oat & Plant Drinks",
  "10418": "Smetana & Sour Cream",
  "10419": "Crème Fraîche & Sour Cream",
  "10430": "Fresh Dairy Desserts",
  "10500": "Butter & Dairy Spreads",
  "10501": "Salted Butter & Spreads",
  "10502": "Cooking Fats & Margarine",
  "10515": "Margarine & Plant Spreads",
  "10517": "Cooking & Olive Oils",
  "10530": "Rapeseed & Vegetable Oils",
  "10590": "Shell Eggs",
  "10592": "Processed & Liquid Eggs",
  "10600": "Hard & Semi-Hard Cheese",
  "10630": "Fresh & Feta Cheese",
  "10900": "Fresh Bread & Rolls",
  "17300": "Prepared Soups & Casseroles",
  "17301": "Prepared Salads",
  "17303": "Sandwiches & Wraps",
  "17401": "Fresh Greenhouse Vegetables",
  "17406": "Whole Fresh Vegetables",
  "17411": "Fresh Berries & Stone Fruit",
  "17423": "Fresh Potatoes & Root Veg",
  "17443": "Pre-Cut Fresh Vegetables",
  "18701": "Fresh Fish & Fillets",
  "18703": "Fresh Crustaceans & Shellfish",
  "18710": "Fresh Pork Cuts",
  "18720": "Fresh Beef Cuts",
  "18750": "Fresh Chicken & Poultry",
  "18751": "Poultry Cuts & Fillets",
  "21300": "Pasta, Rice & Dry Grains",
  "21904": "Sauces & Condiments",
  "21980": "Dry Dessert & Milk Powders",
  "41702": "Frozen Beef",
  "41710": "Frozen Poultry",
  "41720": "Frozen Fish & Seafood",
  "41731": "Frozen Vegetables",
  "41740": "Frozen Berries & Fruit",
  "41800": "Ice Cream & Frozen Desserts",
  "52290": "Chocolate & Confectionery",
  "63210": "Kitchen Paper & Tissue",
  "AIMO-DAIRY": "Milk & Dairy Drinks",
  "AIMO-PRODUCE": "Fresh Produce & Vegetables",
};

function formatCategoryLabel(catCode?: string | null, query?: string): string {
  const code = (catCode ?? "").trim();
  if (code && GS1_CATEGORY_LABELS[code]) {
    return `${GS1_CATEGORY_LABELS[code]} (GS1 ${code})`;
  }
  if (code.startsWith("104")) return `Dairy & Plant Drinks (GS1 ${code})`;
  if (code.startsWith("105")) return `Fats, Oils & Eggs (GS1 ${code})`;
  if (code.startsWith("106")) return `Cheese & Curds (GS1 ${code})`;
  if (code.startsWith("109")) return `Bakery & Bread (GS1 ${code})`;
  if (code.startsWith("174") || code.startsWith("4173") || code.startsWith("4174")) return `Vegetables, Fruit & Potatoes (GS1 ${code})`;
  if (code.startsWith("1870") || code.startsWith("4172")) return `Fish & Seafood (GS1 ${code})`;
  if (code.startsWith("1875") || code.startsWith("4171")) return `Poultry (GS1 ${code})`;
  if (code.startsWith("187") || code.startsWith("4170")) return `Meat & Meat Cuts (GS1 ${code})`;
  if (code.startsWith("213")) return `Pasta, Rice & Dry Goods (GS1 ${code})`;
  if (code.startsWith("219")) return `Sauces, Stocks & Dry Mixes (GS1 ${code})`;
  if (code.startsWith("522")) return `Chocolate & Confectionery (GS1 ${code})`;
  if (code.startsWith("632")) return `Kitchen Paper & Disposables (GS1 ${code})`;
  if (code && code !== "N/A") return `GS1 Category ${code}`;
  return query ? `Catalog query '${query}'` : "Catalog Search";
}

function formatTotalQuantityLabel(packs: number, product: Product, unitHint?: string): string {
  const perPack = product.net_volume_liters_or_kg;
  if (perPack != null && perPack > 0) {
    const total = Number((packs * perPack).toFixed(2));
    const unit = product.comparison_unit
      || (/\b(?:ml|dl|l)\b/i.test(product.unit) || unitHint === "L" ? "L" : "kg");
    return `${total.toLocaleString("en-GB")} ${unit}`;
  }
  return "";
}

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

  const rawCatCode = bestOption?.product.category
    ?? rejectedProducts[0]?.category
    ?? trace[0]?.match(/GS1 Cat\s+(\S+)/i)?.[1]
    ?? null;
  const chosenCategoryText = formatCategoryLabel(rawCatCode, parsedLine?.query);
  const excludedAllergensText = Array.from(excludedSet).join(", ") || "None";
  const targetVolumeText = parsedLine
    ? `${parsedLine.target_volume_liters_or_kg.toLocaleString("en-GB")} ${parsedLine.unit_hint}`
    : (firstItem ? `${firstItem.quantity} packs` : "Specified in request");
  const deliveryDateText = execution?.requested_date ?? tv?.requested_delivery_date ?? "2026-11-16";

  const matchedCountText = trace[0]?.match(/Matched\s+(\d+)\s+safe\s+SKUs/i)?.[1];
  const chosenTotalQty = bestOption && firstItem
    ? formatTotalQuantityLabel(firstItem.quantity, bestOption.product, parsedLine?.unit_hint)
    : bestOption && bestOption.recommended_packs != null
      ? formatTotalQuantityLabel(bestOption.recommended_packs, bestOption.product, parsedLine?.unit_hint)
      : "";

  return (
    <div className="decision-inline">
      {/* 1. Always-Clear Category & Dietary Filter Card + Step-by-Step Decision Walkthrough */}
      <div className="thinking-steps" role="list" aria-label="Category filter and decision walkthrough">
        <div className="step-pill is-static" role="listitem">
          <div className="step-pill-header-row">
            <span className="step-pill-icon sky"><Filter size={13} /></span>
            <span className="step-pill-title">Category &amp; dietary filter</span>
            <code className="step-pill-code">{chosenCategoryText}</code>
          </div>
          <div className="step-filter-summary-grid">
            <div>
              <span>Chosen category</span>
              <strong>{chosenCategoryText}</strong>
            </div>
            <div>
              <span>Target volume</span>
              <strong>{targetVolumeText}</strong>
            </div>
            <div>
              <span>Delivery date</span>
              <strong>{deliveryDateText}</strong>
            </div>
            <div>
              <span>Excluded allergens</span>
              <strong className={excludedSet.size > 0 ? "is-allergen-active" : ""}>{excludedAllergensText}</strong>
            </div>
          </div>
        </div>

        <div className={`step-pill ${openSteps[2] ? "is-open" : ""} ${isRejected || isSubstituted || activeOrder?.status === "pending" ? "is-warning" : ""}`} role="listitem">
          <button
            type="button"
            className="step-pill-trigger step-walkthrough-trigger"
            onClick={() => toggle(2)}
            aria-expanded={Boolean(openSteps[2])}
          >
            <div className="step-pill-header-row">
              <span className="step-pill-title">Step-by-step decision summary</span>
              <span className="step-walkthrough-hint">
                {openSteps[2] ? "Hide steps" : "See how it went"}
                <ChevronDown size={14} className="step-pill-chevron" />
              </span>
            </div>
            <ol className="step-journey-list">
              <li>
                <span>1. Filtered</span>
                <span>
                  Locked to <code>{chosenCategoryText}</code>
                  {excludedSet.size > 0 ? <> · excluded <code>{excludedAllergensText}</code></> : null}
                  {matchedCountText ? ` → ${matchedCountText} safe options` : isRejected ? " → 0 safe options" : ""}
                </span>
              </li>
              <li>
                <span>2. Selected</span>
                <span>
                  {isRejected ? (
                    <>Rejected automatically (every match contained excluded allergens)</>
                  ) : isSubstituted ? (
                    <>
                      Primary SKU <code>{firstItem?.substituted_for ?? winnerProduct?.product_id}</code> lacked stock → substituted to{" "}
                      <code>SKU {firstItem?.product_id}</code> ({firstItem?.name})
                    </>
                  ) : (
                    <>
                      Top match for {priorityTitle.split(" (")[0]}: <code>SKU {chosenSkuId ?? "verified"}</code> — {firstItem?.name ?? winnerProduct?.name ?? "Matched SKU"}
                    </>
                  )}
                </span>
              </li>
              {!isRejected && activeOrder && (
                <li>
                  <span>3. Outcome</span>
                  <span>
                    Ordered <code>{firstItem?.quantity ?? bestOption?.recommended_packs ?? 1}×</code>
                    {chosenTotalQty ? ` (${chosenTotalQty})` : ""} for <code>{money(activeOrder.total_cents)}</code> →{" "}
                    {activeOrder.status === "pending"
                      ? `Pending review (exceeds ${money(maxApproveCents)} limit or flagged rule)`
                      : activeOrder.status === "rejected"
                        ? "Denied"
                        : `Auto-approved (within ${money(maxApproveCents)} limit)`}
                  </span>
                </li>
              )}
            </ol>
          </button>
          <div className="step-dropdown" aria-hidden={!openSteps[2]}>
            <div className="step-dropdown-inner">
              {trace.length > 0 && (
                <div className="step-trace-notes">
                  {trace.map((line, tIdx) => (
                    <p key={tIdx} className="step-trace-item">{renderCodeTokens(line)}</p>
                  ))}
                </div>
              )}
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
                      {opt.recommended_packs != null && (() => {
                        const qtyLabel = formatTotalQuantityLabel(opt.recommended_packs, p, parsedLine?.unit_hint);
                        return (
                          <div className="choice-metric-box">
                            <span className="metric-lbl">Pack total</span>
                            <strong>
                              {opt.recommended_packs}×{qtyLabel ? ` (${qtyLabel})` : ""}
                              {opt.total_price_cents != null ? ` = ${money(opt.total_price_cents)}` : ""}
                            </strong>
                          </div>
                        );
                      })()}
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
            <div className="outcome-approved-facts">
              <span><strong>Delivery:</strong> {deliveryDateText}</span>
              <span><strong>Fulfilled:</strong> {firstItem ? `${firstItem.quantity}×${chosenTotalQty ? ` (${chosenTotalQty})` : ""}` : "Confirmed"}</span>
              {bestOption?.product.vendor && <span><strong>Supplier:</strong> {bestOption.product.vendor}</span>}
              <span><strong>Allergens:</strong> {excludedSet.size > 0 ? `Cleared (${excludedAllergensText})` : "Cleared"}</span>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
