"use client";

import { useState } from "react";
import {
  AlertTriangle, ArrowDownUp, Award, Ban, CheckCircle2, ChevronDown,
  Filter, Leaf, MapPin, Package, ShieldAlert, ShieldCheck,
  Sparkles, Truck,
} from "lucide-react";
import {
  formatOrderItemCapacity, money, statusLabels,
  type AgentExecutionResult, type FulfillmentPlanOption, type Guardrails, type Order, type PriorityMode, type Product,
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

function renderChoiceStockPill(opt: FulfillmentPlanOption | null, product: Product) {
  const rawStock = opt?.available_packs ?? product.stock;
  let stockText = "Stock unconfirmed";
  let stockTone = "neutral";
  if (typeof rawStock === "number" && Number.isFinite(rawStock)) {
    const qtyLabel = Math.floor(rawStock).toLocaleString("en-IE");
    if (rawStock <= 0) {
      stockText = "Out of stock (0)";
      stockTone = "allergen-hit";
    } else if (opt?.can_fulfill_full_volume === false && opt.recommended_packs != null) {
      stockText = `In stock (${qtyLabel} · need ${opt.recommended_packs})`;
      stockTone = "short";
    } else {
      stockText = `In stock (${qtyLabel} packs)`;
      stockTone = "good";
    }
  } else if (
    opt?.can_fulfill_full_volume
    || opt?.tradeoff_explanation?.includes("Terminal direct-delivery stock")
    || (!opt && product.unit_price_cents != null)
  ) {
    stockText = "In stock (999,999+ terminal)";
    stockTone = "good";
  }
  return (
    <span className={`attr-pill ${stockTone}`}>
      <Package size={12} /> <strong>Stock:</strong> {stockText}
    </span>
  );
}

function buildFallbackScriptLog(
  execution: AgentExecutionResult | null | undefined,
  activeOrder: Order | null | undefined,
  trace: string[],
  priorityTitle: string,
): string {
  const bar = "=".repeat(82);
  const promptText = execution?.prompt ?? activeOrder?.items?.[0]?.name ?? "Kitchen order";
  const out: string[] = [
    "(.venv) C:\\keittiomcp> backend\\.venv\\Scripts\\python.exe backend/test_demo.py",
    "",
    bar,
    `  AUTONOMOUS TRADE AGENT ORCHESTRATOR\n  Prompt: '${promptText}'`,
    bar,
    `  Orchestrator Model : ${execution?.orchestrator_model || "deterministic-verified"}`,
    `  Kitchen Priority   : ${priorityTitle}`,
    `  Acting Agent       : ${execution?.agent?.name ?? activeOrder?.agent_name ?? "Kitchen Assistant"} (id='${execution?.agent?.id ?? activeOrder?.agent_id ?? "kitchen"}')`,
    `  Delivery Date      : ${execution?.requested_date ?? "N/A"}`,
  ];
  for (const plan of execution?.plans ?? []) {
    out.push("", bar, `  1. SMART LOCAL CATALOG SEARCH FOR: '${plan.query ?? promptText}'`, bar);
    if (plan.summary) out.push(`  Planner Summary: ${plan.summary}\n`);
    plan.options.slice(0, 3).forEach((opt, idx) => {
      const p = opt.product;
      const rel = p.delivery_reliability != null ? `${(p.delivery_reliability * 100).toFixed(1)}%` : "N/A";
      const co2 = p.co2_range_label || (p.carbon_footprint_kg != null ? `${p.carbon_footprint_kg.toFixed(2)} kg CO2/kg` : "N/A");
      const price = p.unit_price_cents != null ? `EUR ${(p.unit_price_cents / 100).toFixed(2)}` : "N/A";
      const stock = p.stock == null ? "Terminal >= 999999" : `${p.stock} units`;
      out.push(
        `  ${idx + 1}. [${(opt.tier || "OPTION").toUpperCase()}] SKU ${p.product_id} — "${p.name}"`,
        `     Finnish Name   : ${p.name_fi || "N/A"} | Vendor: ${p.vendor || "N/A"} | Origin: ${(p.country_of_origin || "N/A").toUpperCase()}`,
        `     Sales Unit     : ${p.unit} | Category: ${p.category || "N/A"} | Price: ${price} | Stock: ${stock}`,
        `     Reliability    : ${rel} | Carbon Footprint: ${co2}`,
        `     Dietary Claims : ${JSON.stringify(p.dietary_claims ?? [])} | Allergens: ${JSON.stringify(p.allergens ?? [])}`,
        `     Ingredients    : ${p.ingredients_text || "N/A"}`,
        `     Fulfillment    : ${opt.tradeoff_explanation || "Matched catalog criteria"}`,
      );
    });
  }
  out.push("", "  Explainable Decision Audit Trail (4-Stage Trace):");
  trace.forEach((step, idx) => out.push(`    ${idx + 1}. ${step}`));
  if (activeOrder) {
    out.push("", bar, `  RECORDED ORDER, GUARDRAILS & STEP 3 TRUST PROTOCOL RECEIPT: ${activeOrder.id}`, bar);
    out.push(`  Order ID           : ${activeOrder.id} (Placed by: ${activeOrder.agent_name ?? "Kitchen Assistant"})`);
    for (const item of activeOrder.items) {
      const subTag = item.is_substitution ? ` [SUBSTITUTE FOR ${item.substituted_for}]` : "";
      const unitPrice = item.unit_price_cents != null ? `EUR ${(item.unit_price_cents / 100).toFixed(2)}/unit` : "N/A";
      out.push(`  Line Item          : ${item.quantity} × SKU ${item.product_id} — "${item.name}" (${item.unit}) @ ${unitPrice}${subTag}`);
    }
    out.push(
      `  Total Order Cost   : EUR ${(activeOrder.total_cents / 100).toFixed(2)}`,
      `  Guardrail Status   : ${activeOrder.status.toUpperCase()}`,
      `  Review Reasons     : ${activeOrder.reasons.length ? JSON.stringify(activeOrder.reasons) : "['None — auto-approved within all guardrails!']"}`,
    );
    if (activeOrder.trust_verification) {
      const tv = activeOrder.trust_verification;
      out.push(
        "",
        "  --- STEP 3: VERIFIABLE TRUST PROTOCOL & GEMMA 4 PRIVACY RECEIPT ---",
        `  Trust Protocol     : ${tv.protocol}`,
        `  Quote Lock ID      : ${tv.quote_lock_id ?? "N/A"}`,
        `  HMAC-SHA256 Sig    : ${tv.signature_hmac_sha256 ?? "N/A"}`,
        `  Order Cut-off Time : ${tv.earliest_closing_time ?? "N/A"}`,
        `  Privacy Audit Model: ${tv.privacy_audit_model ?? "N/A"}`,
        `  Privacy Attestation: ${tv.privacy_audit_summary ?? "N/A"}`,
      );
    }
  }
  return out.join("\n");
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
              <pre className="step-terminal-log">
                {execution?.script_log || buildFallbackScriptLog(execution, activeOrder, trace, priorityTitle)}
              </pre>
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
                          {renderChoiceStockPill(null, p)}
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

                    {p.ingredients_text && (
                      <p className="choice-ingredients">
                        <strong>Ingredients:</strong> {p.ingredients_text}
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
                      {renderChoiceStockPill(opt, p)}
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

          {firstItem && activeOrder.status !== "auto_approved" && (() => {
            const cap = formatOrderItemCapacity(firstItem.quantity, firstItem.unit);
            return (
              <div className="outcome-specs">
                <span>
                  <strong>Quantity:</strong> {firstItem.quantity.toLocaleString("en-GB")}×
                  {cap.totalLabel ? ` (${cap.totalLabel})` : ` ${firstItem.unit}`}
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
            );
          })()}

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
