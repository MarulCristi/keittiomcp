"use client";

import {
  ArrowDownUp, ArrowRight, ArrowUp, Bot, Check, CircleHelp, ClipboardList,
  Egg, Fish, History, LayoutDashboard, Leaf, Milk, Nut, RefreshCw, Search, ShieldCheck,
  ShoppingBasket, Sparkles, Wheat,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import Image from "next/image";
import OrderReview from "./components/order-review";
import RequestPlanner from "./components/request-planner";
import AgentManagement from "./components/agent-management";
import { AgentIcon, CartIcon, ApprovalIcon, ApprovedIcon } from "./components/dashboard-icons";
import { createBrowserPreview } from "./lib/browser-preview";
import { api, errorMessage, money, orderRequester, sampleProducts, statusLabels, type Availability, type Guardrails, type Order, type Product } from "./lib/purchasing";

const allergens = [
  { name: "milk", label: "Milk", Icon: Milk },
  { name: "gluten", label: "Gluten", Icon: Wheat },
  { name: "soy", label: "Soy", Icon: Leaf },
  { name: "eggs", label: "Eggs", Icon: Egg },
  { name: "nuts", label: "Nuts", Icon: Nut },
  { name: "fish", label: "Fish", Icon: Fish },
] as const;

type Workspace = { guardrails: Guardrails; orders: Order[]; supplier_mode: "demo" | "junction" };
type Message = { role: "agent" | "user"; text: string; products?: Product[]; sample?: boolean; substitutedFor?: string; requestedDate?: string; requestedQuantity?: number };
const prompts = [
  { label: "Find a product", text: "Find cooking cream", liveText: "Find ", Icon: Search },
  { label: "Check stock", text: "Check AIMO-201", liveText: "Check ", Icon: ShoppingBasket },
  { label: "Find a substitute", text: "Substitutes for AIMO-301", liveText: "Substitutes for ", Icon: ArrowDownUp },
];
const zone = "Europe/Helsinki";
const dates = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: zone });
const days = new Intl.DateTimeFormat("en-CA", { dateStyle: "short", timeZone: zone });
const navigation = [
  { id: "overview", label: "Overview", Icon: LayoutDashboard },
  { id: "approvals", label: "Approvals", Icon: ClipboardList },
  { id: "agents", label: "Agents", Icon: Bot },
  { id: "policies", label: "Policies", Icon: ShieldCheck },
  { id: "activity", label: "Activity", Icon: History },
  { id: "demo", label: "Demo tools", Icon: ShoppingBasket },
] as const;
type View = (typeof navigation)[number]["id"];
const headings: Record<View, [string, string]> = {
  overview: ["Purchasing overview", "Monitor purchase orders and decisions across your workspace."],
  approvals: ["Approval Centre", "Review orders that need a human decision."],
  agents: ["Connected agents", "View external purchasing agent connections and permissions."],
  policies: ["Purchasing policies", "Manage the approval rules for this workspace."],
  activity: ["Order activity", "Inspect recorded orders, their latest status and approval reasons."],
  demo: ["Purchasing demo tools", "Try catalog lookup, quantity review and mock ordering."],
};

function describeOrder(order: Order) {
  return order.items.map((item) => `${item.quantity} × ${item.name}`).join(", ");
}

export default function Dashboard() {
  const [preview, setPreview] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);
  const previewClient = useRef<ReturnType<typeof createBrowserPreview> | null>(null);
  if (!previewClient.current) previewClient.current = createBrowserPreview();
  const request = preview ? previewClient.current.request : api;
  const agents = preview ? previewClient.current.agents() : [];
  const events = preview ? previewClient.current.events() : [];
  const [view, setView] = useState<View>("overview");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [draft, setDraft] = useState<Guardrails | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [actionError, setActionError] = useState("");
  const [activeAction, setActiveAction] = useState("");
  const [decisionNotice, setDecisionNotice] = useState("");
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [selection, setSelection] = useState<{ product: Product; sample: boolean; quantity?: number; date?: string; substitutedFor?: string } | null>(null);
  const [showSamples, setShowSamples] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);
  const chatInput = useRef<HTMLInputElement>(null);
  const reviewAnchor = useRef<HTMLDivElement>(null);

  async function loadWorkspace(signal?: AbortSignal, keepDraft = false) {
    setWorkspaceError("");
    try {
      const data = await request<Workspace>("workspace", "GET", undefined, signal);
      if (signal?.aborted) return;
      setWorkspace(data);
      if (!keepDraft) setDraft(data.guardrails);
    } catch (error) {
      if (!signal?.aborted) setWorkspaceError(errorMessage(error));
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadWorkspace(controller.signal);
    return () => controller.abort();
  }, [preview, previewVersion]);

  useEffect(() => {
    if (messages.length) chatEnd.current?.scrollIntoView({ block: "nearest" });
  }, [messages, sending]);

  useEffect(() => {
    if (selection) reviewAnchor.current?.focus({ preventScroll: false });
  }, [selection]);

  function updateOrder(order: Order) {
    setWorkspace((previous) => previous && {
      ...previous,
      orders: [order, ...previous.orders.filter((entry) => entry.id !== order.id)],
    });
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || activeAction) return;
    setActiveAction("settings");
    setActionError("");
    try {
      const guardrails = await request<Guardrails>("guardrails", "PUT", draft);
      setWorkspace((previous) => previous && { ...previous, guardrails });
      setSettingsSaved(true);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setActiveAction("");
    }
  }

  async function decideOrder(id: string, decision: "approved" | "rejected") {
    if (activeAction) return;
    setActiveAction(id);
    setActionError("");
    setDecisionNotice("");
    try {
      const order = await request<Order>(`orders/${id}`, "PATCH", { decision });
      updateOrder(order);
      setDecisionNotice(`Order ${order.id}: ${statusLabels[order.status]}.`);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setActiveAction("");
    }
  }

  async function respond(text: string): Promise<Omit<Message, "role">> {
    const check = text.match(/^check\s+(\S+)(?:\s+(\d+))?(?:\s+(\d{4}-\d{2}-\d{2}))?$/i);
    const substitutes = text.match(/^substitutes?\s+(?:for\s+)?(\S+)$/i);
    const purchase = text.match(/^order\s+(\d+)\s+(\S+)$/i);

    if (check) {
      const params = new URLSearchParams({ product_id: check[1], quantity: check[2] ?? "1" });
      if (check[3]) params.set("requested_date", check[3]);
      const result = await request<Availability>(`check_availability?${params}`);
      const stock = result.available_quantity === null
        ? "Valio did not confirm a quantity."
        : `${result.available_quantity} ${result.sales_unit ?? "packs"} available${result.available_date ? ` from ${result.available_date}` : ""}.`;
      const delivery = result.sales_block ? "This product is blocked for ordering." :
        result.available === true ? "The requested quantity is available." :
        result.available === false ? "The requested quantity is unavailable for the selected date." :
        "Delivery quantity or date could not be confirmed.";
      const price = result.unit_price_cents !== null && result.currency
        ? ` Unit price including tax: ${new Intl.NumberFormat("en-IE", { style: "currency", currency: result.currency }).format(result.unit_price_cents / 100)}.`
        : " Unit price unavailable.";
      return { text: `${result.name} · ${stock} ${delivery}${price}` };
    }
    if (substitutes) {
      const params = new URLSearchParams({ product_id: substitutes[1] });
      for (const allergen of workspace?.guardrails.review_allergens ?? []) params.append("exclude_allergens", allergen);
      const products = await request<Product[]>(`suggest_substitutes?${params}`);
      return { text: products.length ? "Review these alternatives against your dietary and delivery requirements." : "No alternatives were returned for the saved allergen settings.", products, substitutedFor: substitutes[1] };
    }
    if (purchase) {
      const order = await request<Order>("create_purchase_order", "POST", {
        items: [{ product_id: purchase[2], quantity: Number(purchase[1]) }],
      });
      updateOrder(order);
      return { text: `${order.id} · ${describeOrder(order)} · ${money(order.total_cents)}. ${statusLabels[order.status]}.${order.reasons.length ? ` ${order.reasons.join(" · ")}.` : ""}` };
    }
    if (/^(check|substitutes?|order)\b/i.test(text)) {
      return { text: "Use “Check SKU 12 YYYY-MM-DD” for price and availability, or “Substitutes for SKU” to find alternatives. Replace SKU with a product ID. Quantity and date are optional." };
    }
    const query = text.replace(/^(?:find|search(?: for)?)\s+/i, "").trim();
    const products = await request<Product[]>(`search_products?${new URLSearchParams({ query })}`);
    const nextStep = "Select a product to choose a quantity and review price and availability.";
    return { text: products.length ? `I found ${products.length} catalog ${products.length === 1 ? "match" : "matches"}. ${nextStep}` : "I couldn’t find a match. Try a product name, category, or SKU.", products };
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || sending || activeAction || !workspace) return;
    setInput("");
    setMessages((previous) => [...previous, { role: "user", text: message }]);
    setSending(true);
    let reply: Omit<Message, "role">;
    try {
      reply = await respond(message);
    } catch (error) {
      reply = { text: errorMessage(error) };
    }
    setMessages((previous) => [...previous, { role: "agent", ...reply }]);
    setSending(false);
  }

  const pending = workspace?.orders.filter((order) => order.status === "pending") ?? [];
  const liveSupplier = workspace?.supplier_mode === "junction";
  const audit = [...(workspace?.orders ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const today = days.format(new Date());
  const changedToday = audit.filter((order) => days.format(new Date(order.updated_at)) === today).length;
  const automatic = audit.filter((order) => order.status === "auto_approved").length;
  const settingsChanged = Boolean(draft && workspace && (
    draft.max_auto_approve_cents !== workspace.guardrails.max_auto_approve_cents ||
    draft.review_allergens.length !== workspace.guardrails.review_allergens.length ||
    draft.review_allergens.some((name) => !workspace.guardrails.review_allergens.includes(name))
    || draft.min_delivery_reliability !== workspace.guardrails.min_delivery_reliability
    || draft.require_approval_on_substitution !== workspace.guardrails.require_approval_on_substitution
  ));

  async function refreshWorkspace() {
    if (activeAction || sending) return;
    setActiveAction("refresh");
    try {
      await loadWorkspace(undefined, settingsChanged);
    } finally {
      setActiveAction("");
    }
  }

  function activity(orders: Order[]) {
    if (!orders.length) {
      return <p className="empty">{workspace ? "No recorded orders yet." : workspaceError ? "Connect the purchasing service to see order activity." : "Loading order activity…"}</p>;
    }

    return <div className="activity-list">
      {orders.map((order) => <details key={order.id} className="activity-entry">
        <summary>
          <div><strong>{order.id}</strong><span className="order-products">{describeOrder(order)}</span><span className="order-requester">{orderRequester(order)}</span><time dateTime={order.updated_at}>{dates.format(new Date(order.updated_at))}</time></div>
          <span className={`status ${order.status}`}><span />{statusLabels[order.status]}</span>
          <strong>{money(order.total_cents)}</strong>
        </summary>
        <div className="activity-details">
          <p>{describeOrder(order)}</p>
          {order.reasons.length > 0 && <ul>{order.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
          {preview && events.some((event) => event.order_id === order.id) && <div className="order-timeline">
            <h3>Order history</h3>
            <ol>{events.filter((event) => event.order_id === order.id).map((event) => <li key={event.id}>
              <strong>{event.action}</strong><p>{event.detail}</p><time dateTime={event.timestamp}>{dates.format(new Date(event.timestamp))}</time>
            </li>)}</ol>
          </div>}
          {order.trust_verification && <dl className="review-facts">
            <div><dt>Verification protocol</dt><dd>{order.trust_verification.protocol}</dd></div>
            <div><dt>Verified at</dt><dd>{order.trust_verification.verified_at}</dd></div>
            <div><dt>Supplier mode</dt><dd>{order.trust_verification.supplier_mode}</dd></div>
            <div><dt>Requested delivery</dt><dd>{order.trust_verification.requested_delivery_date ?? "Unconfirmed"}</dd></div>
            {order.trust_verification.earliest_closing_time && <div><dt>Order cutoff</dt><dd>{order.trust_verification.earliest_closing_time}</dd></div>}
          </dl>}
        </div>
      </details>)}
    </div>;
  }

  async function findAlternatives(date: string, quantity: number) {
    if (!selection || activeAction || sending) return;
    setActiveAction("alternatives");
    setActionError("");
    try {
      const params = new URLSearchParams({ product_id: selection.product.product_id });
      if (date) params.set("requested_date", date);
      for (const name of workspace?.guardrails.review_allergens ?? []) params.append("exclude_allergens", name);
      const products = await request<Product[]>(`suggest_substitutes?${params}`);
      setMessages((previous) => [...previous, { role: "agent", text: products.length ? "Review the proposed replacements and their trade-offs. Check pack sizes before confirming quantities." : "No alternatives were returned.", products, substitutedFor: selection.product.product_id, requestedDate: date, requestedQuantity: quantity }]);
      setView("overview");
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setActiveAction("");
    }
  }

  function productCards(products: Product[], sample = false, substitutedFor?: string, requestedDate?: string, requestedQuantity?: number) {
    return products.map((product) => (
      <article className="product-card" key={product.product_id}>
        <div className="product-card-heading">
          <div><h3>{product.name}</h3><p>{product.unit} · {product.product_id}</p></div>
          <span className="product-price">{product.unit_price_cents == null ? "Price unconfirmed" : money(product.unit_price_cents)}<small>per sales unit</small></span>
        </div>
        <div className="product-details">
          <span className={`stock-label ${product.stock === 0 ? "attention" : ""}`}>{product.stock == null ? "Stock not confirmed" : product.stock === 0 ? "Out of stock" : `${product.stock} sales units in catalog`}</span>
          <span>{product.allergens == null ? "Allergens unknown" : product.allergens.length ? `Contains: ${product.allergens.join(", ")}` : "No allergens listed"}</span>
        </div>
        <dl className="product-comparison">
          <div><dt>Delivery reliability</dt><dd>{product.delivery_reliability == null ? "Unconfirmed" : `${(product.delivery_reliability * 100).toFixed(1)}%`}</dd></div>
          <div><dt>Supplier sustainability labels</dt><dd>{product.sustainability_labels?.join(", ") || "No labels supplied"}</dd></div>
          <div><dt>Dietary claims</dt><dd>{product.dietary_claims?.join(", ") || "Unconfirmed"}</dd></div>
          {product.comparison_price_cents != null && product.comparison_unit && <div><dt>Comparison price</dt><dd>{money(product.comparison_price_cents)} / {product.comparison_unit}</dd></div>}
        </dl>
        {product.substitute_reason && <p className="decision-note">{product.substitute_tier && <strong>{product.substitute_tier} · </strong>}{product.substitute_reason}</p>}
        <div className="product-card-footer">
          <small>{sample ? "Illustrative sample · not supplier data" : "Check availability before ordering"}</small>
          <button type="button" className="secondary-button" disabled={Boolean(activeAction) || sending} onClick={() => setSelection({ product, sample, substitutedFor, date: requestedDate, quantity: requestedQuantity })}>Review product <ArrowRight size={14} /></button>
        </div>
      </article>
    ));
  }

  function switchMode(nextPreview: boolean) {
    if (activeAction || sending) return;
    setWorkspace(null);
    setDraft(null);
    setWorkspaceError("");
    setActionError("");
    setDecisionNotice("");
    setSettingsSaved(false);
    setMessages([]);
    setSelection(null);
    setShowSamples(false);
    setInput("");
    setPreview(nextPreview);
  }

  return (
    <div className="min-h-screen">
      <header className="topbar">
        <div className="topbar-inner">
          <button className="brand-home" type="button" aria-label="KeittiöMCP overview" onClick={() => setView("overview")}>
            <Image src="/branding/keittio-wordmark.png" alt="Keittiö" width={1120} height={500} className="brand-logo" priority />
            <span className="brand-mcp">MCP</span>
          </button>
          <nav className="control-nav" aria-label="KeittiöMCP workspace">
            {navigation.map(({ id, label }) => <button type="button" key={id} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>
              {label}{id === "approvals" && pending.length > 0 && <span className="count">{pending.length}</span>}
            </button>)}
          </nav>
          <div className="mode-controls">
            <span className={`demo-label ${!workspace || workspaceError ? "disconnected" : ""}`} role="status"><span /> {preview ? "Browser preview" : workspaceError ? workspace ? "Connection lost" : "Service disconnected" : workspace ? liveSupplier ? "Junction mock connection" : "Demo workspace" : "Connecting…"}</span>
            <button className="secondary-button" type="button" disabled={Boolean(activeAction) || sending} onClick={() => switchMode(!preview)}>{preview ? "Use service connection" : "Start browser preview"}</button>
          </div>
        </div>
      </header>

      <main className="shell">
        <div className="overview">
          <div>
            <p className="page-eyebrow">Purchasing control centre</p>
            <h1>{headings[view][0]}</h1>
            <p>{headings[view][1]}</p>
          </div>
          <button className="secondary-button refresh-button" type="button" disabled={Boolean(activeAction) || sending || (!workspace && !workspaceError)} onClick={() => void refreshWorkspace()}>
            <RefreshCw size={15} aria-hidden="true" />{activeAction === "refresh" ? "Refreshing…" : "Refresh workspace"}
          </button>
        </div>

        {preview && <div className="preview-banner" role="status">
          <div><strong>Browser preview · simulated data</strong><p>Changes stay in this browser session and reset when you reload.</p></div>
          <button type="button" className="text-button" disabled={Boolean(activeAction) || sending} onClick={() => { previewClient.current = createBrowserPreview(); setMessages([]); setSelection(null); setDecisionNotice(""); setSettingsSaved(false); setPreviewVersion((value) => value + 1); }}>Reset preview</button>
        </div>}

        {workspaceError && <div className="connection-notice" role="status">
          <div><strong>{workspace ? "Showing the last loaded workspace" : "The purchasing service is disconnected"}</strong><p>Use Refresh workspace to retry the connection.</p></div>
          {!workspace && view !== "overview" && <button type="button" className="secondary-button" onClick={() => { setShowSamples(true); setView("overview"); }}>Explore sample products</button>}
        </div>}
        {actionError && <p className="error workspace-error" role="alert">{actionError}</p>}
        {decisionNotice && view !== "approvals" && <p className="decision-feedback" role="status">{decisionNotice}</p>}

        {view === "overview" && <div className="control-content overview-content">
          <dl className="metric-grid">
            <div className="panel metric-card"><div className="metric-icon sky"><AgentIcon /></div><dt>Connected agents</dt><dd>{preview ? agents.filter((agent) => agent.status === "connected").length : "—"}</dd><small>{preview ? "Simulated agent connections" : "Agent data unavailable"}</small><button type="button" className="text-button" onClick={() => setView("agents")}>View agents <ArrowRight size={16} /></button></div>
            <div className="panel metric-card"><div className="metric-icon blue"><CartIcon /></div><dt>Orders updated today</dt><dd>{workspace ? changedToday : "—"}</dd><small>Helsinki time</small><button type="button" className="text-button" onClick={() => setView("activity")}>View activity <ArrowRight size={16} /></button></div>
            <div className="panel metric-card"><div className="metric-icon turquoise"><ApprovalIcon /></div><dt>Awaiting approval</dt><dd>{workspace ? pending.length : "—"}</dd><small>{pending.length ? "A decision needs your attention" : "No pending decisions"}</small><button type="button" className="primary-button" onClick={() => setView("approvals")}>Open Approval Centre <ArrowRight size={16} /></button></div>
            <div className="panel metric-card"><div className="metric-icon orange"><ApprovedIcon /></div><dt>Automatically approved</dt><dd>{workspace ? automatic : "—"}</dd><small>Across recorded orders</small><button type="button" className="text-button" onClick={() => setView("policies")}>View policies <ArrowRight size={16} /></button></div>
          </dl>
        </div>}

        {view === "agents" && preview && <AgentManagement agents={agents} request={request} busy={Boolean(activeAction) || sending} onBusy={setActiveAction} onChanged={() => void loadWorkspace(undefined, true)} />}
        {view === "agents" && !preview && <section className="panel control-empty">
          <Bot size={24} aria-hidden="true" />
          <h2>Agent data unavailable</h2>
          <p>The current workspace API provides orders and shared purchasing policies. Agent identities, permissions, per-agent limits and last activity require an agent management API.</p>
          <button type="button" className="secondary-button" onClick={() => switchMode(true)}>Try agent management in browser preview</button>
        </section>}

        {view === "demo" && <RequestPlanner key={`${preview}:${previewVersion}`} request={request} connected={Boolean(workspace) && !workspaceError} busy={Boolean(activeAction) || sending} onBusy={setActiveAction}
          onSelect={(product, quantity, date) => setSelection({ product, sample: false, quantity, date })} />}
        <div className={`dashboard-grid ${view === "overview" ? "home-purchasing" : "demo-review"}`} hidden={view !== "demo" && view !== "overview"}>
          {view === "overview" && <section className="panel chat-panel" aria-labelledby="chat-title">
            <div className="chat-header">
              <div className="chat-icon"><Bot size={23} strokeWidth={1.75} /></div>
              <div>
                <h2 id="chat-title">Purchasing assistant</h2>
                <p><span className={workspace ? "online-dot" : "offline-dot"} /> {preview ? "Using the simulated catalog" : workspace ? "Connected to purchasing service" : workspaceError ? "Waiting for purchasing service" : "Connecting…"}</p>
              </div>
              <span className="supplier-label">{preview ? "Sample catalog" : "Valio Aimo catalog"}</span>
            </div>

            <div className="chat-content" role="log" aria-label="Conversation">
              <div className="message">
                <div className="message-icon"><Sparkles size={16} /></div>
                <div className="message-body">
                  <span className="message-author">Purchasing assistant</span>
                  <div className="bubble welcome">
                    <strong>What are you sourcing today?</strong>
                    <p>Find a product, choose how much you need, and review its price and availability. Try “Find milk”, “Check SKU”, or “Substitutes for SKU”.{workspace?.supplier_mode === "demo" ? " Create a demo order to see the approval decision." : ""}</p>
                  </div>
                </div>
              </div>
              {showSamples && <section className="sample-results" aria-label="Sample product results">
                <div className="sample-heading"><span className="eyebrow">Design preview · sample data</span><button type="button" className="text-button" disabled={Boolean(activeAction)} onClick={() => { setShowSamples(false); if (selection?.sample) setSelection(null); }}>Hide samples</button></div>
                <p>Try a quantity and see the estimated cost. These examples are not connected to the purchasing service.</p>
                {productCards(sampleProducts, true)}
              </section>}
              {messages.map((message, index) => (
                <div key={index} className={`message ${message.role === "user" ? "user-message" : ""}`}>
                  {message.role === "agent" ? <div className="message-icon"><Sparkles size={16} /></div> : null}
                  <div className="message-body">
                    <span className="message-author">{message.role === "user" ? "You" : "Demo response"}</span>
                    <div className="bubble">{message.text}</div>
                    {message.products && productCards(message.products, Boolean(message.sample), message.substitutedFor, message.requestedDate, message.requestedQuantity)}
                  </div>
                </div>
              ))}
              {sending ? <p className="chat-loading">Working on your request…</p> : null}
              <div ref={chatEnd} />
            </div>

            <div className="chat-footer">
              <div className="prompts">
                {!workspace && workspaceError && !showSamples && <button type="button" onClick={() => setShowSamples(true)}>Explore sample products</button>}
                {prompts.map(({ label, text, liveText, Icon }) => (
                  <button type="button" key={label} disabled={sending || Boolean(activeAction) || !workspace} onClick={() => {
                    if (liveSupplier) {
                      setInput(liveText);
                      chatInput.current?.focus();
                    } else {
                      void send(text);
                    }
                  }}><Icon size={14} /> {label}</button>
                ))}
              </div>
              <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(input); }}>
                <label className="sr-only" htmlFor="chat-input">Message the purchasing assistant</label>
                <input ref={chatInput} id="chat-input" value={input} maxLength={120} disabled={!workspace} onChange={(event) => setInput(event.target.value)} placeholder={workspace ? "Try: Find cooking cream" : "Connect the purchasing service to search"} />
                <button type="submit" aria-label="Send message" disabled={sending || Boolean(activeAction) || !workspace || !input.trim()}><ArrowUp size={19} /></button>
              </form>
              <p className="chat-note"><CircleHelp size={13} /> {preview ? "Simulated actions are recorded in this browser session." : workspace ? liveSupplier ? "Connected to Junction’s mock catalog." : "Demo orders are recorded locally." : "Sample preview is available above. Orders require a connection."}</p>
            </div>
          </section>}

          <aside className="right-panel" aria-label="Purchasing controls">
            <div ref={reviewAnchor} tabIndex={-1} className="review-anchor" hidden={!selection && view === "overview"}>
              {selection ? <OrderReview key={`${selection.sample}:${selection.product.product_id}:${selection.quantity}:${selection.date}:${selection.substitutedFor}`} product={selection.product} sample={selection.sample}
                request={request} preview={preview}
                initialQuantity={selection.quantity} initialDate={selection.date} substitutedFor={selection.substitutedFor}
                mode={workspace?.supplier_mode} guardrails={workspace?.guardrails ?? null} orders={workspace?.orders ?? []}
                busy={Boolean(activeAction) || sending} onBusy={setActiveAction} onCreated={updateOrder}
                onClose={() => setSelection(null)} onAlternatives={(date, quantity) => void findAlternatives(date, quantity)} /> :
                <section className="panel review-placeholder"><ShoppingBasket size={25} /><h2>Your selection, explained</h2><p>Select a product to choose a quantity, check availability, and review purchasing rules before ordering.</p></section>}
            </div>
            {view === "overview" && <section className="panel side-panel recent-orders" aria-labelledby="recent-activity">
              <div className="control-heading"><h2 id="recent-activity">Recent orders</h2><button type="button" className="text-button" onClick={() => setView("activity")}>View all <ArrowRight size={16} /></button></div>
              {activity(audit.slice(0, 5))}
              {preview && <p className="panel-footnote">Sample orders · changes reset on reload</p>}
            </section>}
          </aside>
        </div>

            {view === "policies" && <section className="panel side-panel policy-panel" aria-labelledby="guardrails-title">
              <div className="section-heading">
                <div className="section-icon"><ShieldCheck size={20} /></div>
                <div><h2 id="guardrails-title">Workspace approval rules</h2><p>Set a spend limit and choose which allergens trigger review.</p></div>
              </div>
              {draft ? (
                <form className="settings" onSubmit={saveSettings}>
                  <div className="slider-label">
                    <label htmlFor="spend">Max auto-approve spend</label>
                    <output htmlFor="spend">{money(draft.max_auto_approve_cents)}</output>
                  </div>
                  <input id="spend" type="range" min="0" max="500000" step="500" value={draft.max_auto_approve_cents}
                    aria-valuetext={money(draft.max_auto_approve_cents)}
                    disabled={Boolean(activeAction)}
                    style={{ background: `linear-gradient(to right, var(--accent) ${draft.max_auto_approve_cents / 5000}%, var(--line) 0)` }}
                    onChange={(event) => {
                      setSettingsSaved(false);
                      setDraft({ ...draft, max_auto_approve_cents: Number(event.target.value) });
                    }} />
                  <div className="slider-range"><span>€0</span><span>€5,000</span></div>
                  {draft.min_delivery_reliability != null && <div className="quantity-row">
                    <label htmlFor="reliability">Minimum delivery reliability (%)</label>
                    <input id="reliability" type="number" min="0" max="100" step="0.1" required disabled={Boolean(activeAction)} value={Number((draft.min_delivery_reliability * 100).toFixed(2))}
                      onChange={(event) => { if (event.target.value === "") return; setSettingsSaved(false); setDraft({ ...draft, min_delivery_reliability: Number(event.target.value) / 100 }); }} />
                  </div>}
                  {draft.require_approval_on_substitution != null && <label className="substitution-policy">
                    <input type="checkbox" disabled={Boolean(activeAction)} checked={draft.require_approval_on_substitution} onChange={(event) => { setSettingsSaved(false); setDraft({ ...draft, require_approval_on_substitution: event.target.checked }); }} />
                    Require human approval for substitutions
                  </label>}
                  <fieldset className="allergens" disabled={Boolean(activeAction)}>
                    <legend>Require approval for</legend>
                    <div className="allergen-options">
                      {allergens.map(({ name, label, Icon }) => (
                        <label key={name}>
                          <input type="checkbox" checked={draft.review_allergens.includes(name)} onChange={(event) => {
                            setSettingsSaved(false);
                            setDraft({
                              ...draft, review_allergens: event.target.checked
                                ? [...draft.review_allergens, name]
                                : draft.review_allergens.filter((item) => item !== name),
                            });
                          }} />
                          <Icon size={14} /> {label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div className="settings-actions">
                    <span role="status">{settingsSaved ? <><Check size={13} /> {preview ? "Saved in browser preview" : "Settings saved"}</> : null}</span>
                    <button type="submit" className="secondary-button" disabled={!settingsChanged || Boolean(activeAction)}>Save settings</button>
                  </div>
                </form>
              ) : <p className="empty">{workspaceError ? "Guardrails unavailable." : "Loading guardrails…"}</p>}
            </section>}

            {view === "approvals" && <section className="control-content" aria-label="Pending orders">
              <p className="decision-feedback" role="status">{decisionNotice}</p>
              {pending.length ? <div className="approval-grid">
                {pending.map((order) => (
                  <article className="panel approval-card" key={order.id}>
                    <div className="control-heading"><h2>Order {order.id}</h2><span className="status pending"><span />Pending approval</span></div>
                    <p className="approval-timestamp">{orderRequester(order)} · Updated <time dateTime={order.updated_at}>{dates.format(new Date(order.updated_at))}</time></p>
                    <ul className="approval-items">
                      {order.items.map((item, index) => <li key={`${item.product_id}:${index}`}><span>{item.name}</span><strong>{item.quantity.toLocaleString("en-GB")} × {item.unit}</strong></li>)}
                    </ul>
                    <div className="approval-total"><span>Order total</span><strong>{money(order.total_cents)}</strong></div>
                    <div className="decision-note attention"><strong>Why this needs approval</strong>
                      {order.reasons.length ? <ul>{order.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : <p>No reason was provided with this order.</p>}
                    </div>
                    <div className="queue-actions">
                      <button type="button" disabled={Boolean(activeAction) || Boolean(workspaceError)} onClick={() => void decideOrder(order.id, "rejected")}>Reject</button>
                      <button type="button" disabled={Boolean(activeAction) || Boolean(workspaceError)} onClick={() => void decideOrder(order.id, "approved")}>Approve <ArrowRight size={13} /></button>
                    </div>
                  </article>
                ))}
              </div> : <div className="panel control-empty"><ClipboardList size={24} aria-hidden="true" /><h2>{workspace ? "No orders awaiting approval" : workspaceError ? "Approval queue unavailable" : "Loading approvals…"}</h2><p>Orders that require human review appear here after the purchasing service records them.</p></div>}
              {!workspace && workspaceError && <details className="panel approval-card sample-approval">
                <summary>Preview an example approval</summary>
                <div className="control-heading"><h2>Example order #1042</h2><span className="status pending"><span />Illustrative example</span></div>
                <p className="approval-timestamp">Kitchen Assistant · Sample request</p>
                <ul className="approval-items"><li><span>Lactose-free milk</span><strong>1,000 L</strong></li><li><span>Mozzarella</span><strong>50 kg</strong></li></ul>
                <div className="approval-total"><span>Order total</span><strong>€1,450.00</strong></div>
                <div className="decision-note attention"><strong>Why this needs approval</strong><p>The example order exceeds the €500 automatic approval limit by €950.</p></div>
                <p className="review-caption">Connect the purchasing service to act on recorded orders.</p>
              </details>}
            </section>}

        {view === "activity" && <div className="control-content">
          <section className="panel side-panel" aria-label="Recorded order activity"><h2>Order history</h2>{activity(audit)}</section>
        </div>}
      </main>
      <footer className="site-footer"><span>KeittiöMCP</span><span>Independent Junction prototype</span></footer>
    </div>
  );
}
