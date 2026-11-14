"use client";

import { useRef, useState } from "react";
import { ArrowDownUp, ArrowRight, Check, CircleHelp, ClipboardList, ShieldCheck, X } from "lucide-react";
import { api, canCreateOrder, errorMessage, money, parseQuantity, statusLabels, type ApiClient, type Availability, type Guardrails, type Order, type Product } from "../lib/purchasing";

type Props = {
  request?: ApiClient;
  preview?: boolean;
  product: Product;
  sample: boolean;
  initialQuantity?: number;
  initialDate?: string;
  substitutedFor?: string;
  mode?: "demo" | "junction";
  guardrails: Guardrails | null;
  orders: Order[];
  busy: boolean;
  onBusy: (action: string) => void;
  onCreated: (order: Order) => void;
  onClose: () => void;
  onAlternatives: (date: string, quantity: number) => void;
};

export default function OrderReview({ request = api, preview = false, product, sample, initialQuantity = 1, initialDate = "", substitutedFor, mode, guardrails, orders, busy, onBusy, onCreated, onClose, onAlternatives }: Props) {
  const [quantityInput, setQuantityInput] = useState(String(initialQuantity));
  const [deliveryDate, setDeliveryDate] = useState(initialDate);
  const [checked, setChecked] = useState<{ quantity: number; result: Availability } | null>(null);
  const [error, setError] = useState("");
  const [action, setAction] = useState("");
  const [created, setCreated] = useState<Order | null>(null);
  const inFlight = useRef(false);
  const quantity = parseQuantity(quantityInput);
  const result = checked?.quantity === quantity ? checked.result : null;
  const unitPrice = result ? (result.currency === "EUR" ? result.unit_price_cents : null) : product.unit_price_cents;
  const estimate = quantity !== null && unitPrice != null && Number.isSafeInteger(unitPrice * quantity) ? unitPrice * quantity : null;
  const reviewAllergens = guardrails?.review_allergens.filter((name) => product.allergens?.includes(name)) ?? [];
  const overBudget = estimate !== null && guardrails !== null && estimate > guardrails.max_auto_approve_cents;
  const shortage = result?.available_quantity != null && quantity !== null && result.available_quantity < quantity;
  const canSubmit = canCreateOrder(mode, sample, quantity, checked?.quantity, result);
  const recordedOrder = created ? orders.find((order) => order.id === created.id) ?? created : null;

  async function checkAvailability() {
    if (quantity === null || sample || !mode || busy || inFlight.current) return;
    inFlight.current = true;
    setAction("check");
    onBusy("review:check");
    setError("");
    setChecked(null);
    try {
      const params = new URLSearchParams({ product_id: product.product_id, quantity: String(quantity) });
      if (deliveryDate) params.set("requested_date", deliveryDate);
      const availability = await request<Availability>(`check_availability?${params}`);
      setChecked({ quantity, result: availability });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      inFlight.current = false;
      setAction("");
      onBusy("");
    }
  }

  async function createOrder() {
    if (!canSubmit || busy || inFlight.current || recordedOrder) return;
    inFlight.current = true;
    setAction("order");
    onBusy("review:order");
    setError("");
    try {
      const order = await request<Order>("create_purchase_order", "POST", {
        items: [{ product_id: product.product_id, quantity, is_substitution: Boolean(substitutedFor), substituted_for: substitutedFor ?? null }],
        requested_date: deliveryDate || null,
      });
      setCreated(order);
      onCreated(order);
    } catch (cause) {
      setError(`${errorMessage(cause)} Check order history before retrying if the connection was interrupted.`);
      setChecked(null);
    } finally {
      inFlight.current = false;
      setAction("");
      onBusy("");
    }
  }

  return (
    <section className="panel side-panel review-panel" aria-labelledby="review-title">
      <div className="section-heading">
        <div className="section-icon"><ClipboardList size={20} /></div>
        <div><p className="eyebrow">{sample ? "Sample · orders disabled" : "Your next step"}</p><h2 id="review-title">Review your selection</h2></div>
        <button className="icon-button" type="button" aria-label="Close product review" disabled={busy} onClick={onClose}><X size={18} /></button>
      </div>
      <h3 className="review-product-name">{product.name}</h3>
      <p className="review-caption">{product.unit} · {product.product_id}</p>
      {substitutedFor && <p className="decision-note attention">Proposed substitution for {substitutedFor}. Review the product’s dietary information before ordering.</p>}

      {recordedOrder ? (
        <div className="order-outcome" role="status">
          <span className={`status ${recordedOrder.status}`}><span />{statusLabels[recordedOrder.status]}</span>
          <h3>{recordedOrder.status === "pending" ? "A person needs to review this order" : "Order decision recorded"}</h3>
          <p>{recordedOrder.id} · {money(recordedOrder.total_cents)}</p>
          {estimate !== null && recordedOrder.total_cents !== estimate && <p className="decision-note attention">The recorded total changed from the reviewed estimate of {money(estimate)} to {money(recordedOrder.total_cents)}. Check this order in Activity.</p>}
          {recordedOrder.reasons.length > 0 && <ul>{recordedOrder.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
          <p className="review-caption">{preview ? "Simulated in this browser preview." : "Recorded in the demo workspace. Supplier delivery remains subject to confirmation."}</p>
          <button type="button" className="primary-button" onClick={onClose} disabled={busy}>Done <Check size={15} /></button>
        </div>
      ) : (
        <>
          <div className="quantity-row">
            <label htmlFor="order-quantity">Quantity <span>Number of sales units</span></label>
            <input id="order-quantity" type="number" min="1" max="10000" step="1" value={quantityInput} disabled={busy} aria-invalid={quantity === null} aria-describedby={quantity === null ? "quantity-error" : undefined}
              onChange={(event) => { setQuantityInput(event.target.value); setChecked(null); setError(""); }} />
          </div>
          {quantity === null && <p id="quantity-error" className="field-error">Enter a whole number from 1 to 10,000.</p>}
          <div className="quantity-row delivery-field"><label htmlFor="delivery-date">Requested delivery date<span>Leave blank to use the service’s default</span></label>
            <input id="delivery-date" type="date" value={deliveryDate} disabled={busy} onChange={(event) => { setDeliveryDate(event.target.value); setChecked(null); setError(""); }} />
          </div>
          <dl className="review-facts">
            <div><dt>Price per sales unit</dt><dd>{unitPrice == null ? "Not confirmed" : money(unitPrice)}</dd></div>
            <div className="review-total"><dt>{sample ? "Sample estimate" : "Estimated total"}</dt><dd>{estimate === null ? "Not confirmed" : money(estimate)}</dd></div>
          </dl>
          {!result && <p className="review-caption">{sample ? "Illustrative prices only. No supplier lookup or order will be made." : "Catalog estimate. Check current price and availability before creating an order."}</p>}

          {result && (
            <div className={`decision-note ${result.sales_block || shortage || result.available !== true ? "attention" : ""}`} role="status">
              <strong>{result.sales_block ? "This product is blocked for ordering" : shortage ? "Not enough stock for this quantity" : result.available === true ? "Requested quantity available" : result.available === false ? "Requested quantity unavailable" : "Availability not confirmed"}</strong>
              <p>{result.available_quantity == null ? "The supplier did not confirm a stock quantity." : `${result.available_quantity} ${result.sales_unit ?? product.unit} available.`}{result.available_date ? ` Reported availability date: ${result.available_date}.` : " Delivery date not confirmed."}</p>
              {result.currency !== "EUR" && <p>A confirmed EUR price is needed to create a demo order here.</p>}
              {result.unit_price_cents == null && <p>Price has not been confirmed.</p>}
              {shortage && quantity !== null && <p>Shortfall of {quantity - (result.available_quantity ?? 0)} sales units. Find alternatives to review another product.</p>}
              {result.delivery_reliability != null && <p>Reported delivery reliability: {(result.delivery_reliability * 100).toFixed(1)}%.</p>}
              {result.closing_time && <p>Order cutoff: {result.closing_time}</p>}
              {!!result.sustainability_labels?.length && <p>Supplier labels: {result.sustainability_labels.join(", ")}</p>}
              <p className="review-caption">Availability is a lookup result, not a delivery reservation.</p>
            </div>
          )}

          <div className="review-rules">
            <h3><ShieldCheck size={16} /> What may need approval?</h3>
            {!guardrails || sample ? <p>Connect the purchasing service to see the saved approval rules.</p> : (
              <>
                <p>Automatic approval limit: <strong>{money(guardrails.max_auto_approve_cents)}</strong></p>
                {overBudget && <p className="approval-flag">This estimate exceeds the saved spending limit.</p>}
                {reviewAllergens.length > 0 && <p className="approval-flag">Flagged ingredients: {reviewAllergens.join(", ")}.</p>}
                {substitutedFor && guardrails.require_approval_on_substitution && <p className="approval-flag">The saved policy requires review for substitutions.</p>}
                {guardrails.min_delivery_reliability != null && <p>Minimum delivery reliability: {(guardrails.min_delivery_reliability * 100).toFixed(0)}%.</p>}
                {product.allergens == null && <p>Allergen information is unknown. Verify suitability before ordering.</p>}
                {!overBudget && reviewAllergens.length === 0 && <p>No spending or ingredient flags identified from the known information.</p>}
                <p className="review-caption">{preview ? "The browser preview applies the saved sample rules and agent permissions." : "This is a preview of saved rules. The purchasing service returns the final decision."}</p>
              </>
            )}
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="review-actions">
            <button className="secondary-button" type="button" disabled={busy || sample || !mode || quantity === null} onClick={() => void checkAvailability()}>{action === "check" ? "Checking…" : result ? "Refresh availability" : "Check price & availability"}</button>
            <button className="primary-button" type="button" disabled={busy || !canSubmit} onClick={() => void createOrder()}>{action === "order" ? "Creating…" : "Create demo order"}<ArrowRight size={15} /></button>
            <button className="text-button" type="button" disabled={busy || sample || !mode || quantity === null} onClick={() => { if (quantity !== null) onAlternatives(deliveryDate, quantity); }}><ArrowDownUp size={14} /> Find alternatives</button>
          </div>
          <p className="review-caption review-help"><CircleHelp size={13} />{sample ? "Sample view only. Connect the service for a working order flow." : !mode ? "The purchasing service is not connected." : !result ? "Check availability to enable order creation." : !canSubmit ? "Resolve the availability or price issue before ordering." : preview ? "This simulated purchase will use the Kitchen Assistant's saved permissions and approval limits." : "The service will either auto-approve or request human review."}</p>
        </>
      )}
    </section>
  );
}
