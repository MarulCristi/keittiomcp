"use client";

import {
  ArrowDownUp, ArrowRight, ArrowUp, Bot, Check, ChevronRight, CircleHelp, ClipboardList,
  Clock3, Egg, Fish, History, Leaf, Mail, Milk, Nut, Search, ShieldCheck, ShoppingBasket,
  Sparkles, Wheat,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

const allergens = [
  { name: "milk", label: "Milk", Icon: Milk },
  { name: "gluten", label: "Gluten", Icon: Wheat },
  { name: "soy", label: "Soy", Icon: Leaf },
  { name: "eggs", label: "Eggs", Icon: Egg },
  { name: "nuts", label: "Nuts", Icon: Nut },
  { name: "fish", label: "Fish", Icon: Fish },
] as const;

type Allergen = (typeof allergens)[number]["name"];
type Guardrails = { max_auto_approve_cents: number; review_allergens: Allergen[] };
type Product = {
  product_id: string;
  name: string;
  unit: string;
  unit_price_cents: number | null;
  stock: number | null;
  allergens: Allergen[] | null;
};
type Order = {
  id: string;
  items: { product_id: string; name: string; quantity: number; unit: string }[];
  total_cents: number;
  status: "pending" | "auto_approved" | "approved" | "rejected";
  reasons: string[];
  updated_at: string;
};
type Workspace = { guardrails: Guardrails; orders: Order[]; supplier_mode: "demo" | "junction" };
type Availability = {
  name: string;
  available_quantity: number | null;
  available: boolean | null;
  available_date: string | null;
  sales_unit: string | null;
  sales_block: boolean;
  unit_price_cents: number | null;
  currency: string | null;
};
type Message = { role: "agent" | "user"; text: string; products?: Product[] };

const statusLabels = {
  pending: "Pending",
  auto_approved: "Auto-approved",
  approved: "Approved",
  rejected: "Rejected",
};
const prompts = [
  { label: "Find a product", text: "Find cooking cream", liveText: "Find ", Icon: Search },
  { label: "Check stock", text: "Check AIMO-201", liveText: "Check ", Icon: ShoppingBasket },
  { label: "Find a substitute", text: "Substitutes for AIMO-301", liveText: "Substitutes for ", Icon: ArrowDownUp },
];
const euros = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });
const dates = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const money = (cents: number) => euros.format(cents / 100);

async function api<T>(path: string, method = "GET", body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method, signal, cache: "no-store",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(typeof error?.detail === "string" ? error.detail : "The request failed. Check that the backend is running and try again.");
  }
  return response.json() as Promise<T>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function describeOrder(order: Order) {
  return order.items.map((item) => `${item.quantity} × ${item.name}`).join(", ");
}

export default function Dashboard() {
  const [email, setEmail] = useState("");
  const [domain, setDomain] = useState("");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [draft, setDraft] = useState<Guardrails | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [actionError, setActionError] = useState("");
  const [activeAction, setActiveAction] = useState("");
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);
  const chatInput = useRef<HTMLInputElement>(null);

  async function loadWorkspace(signal?: AbortSignal) {
    setWorkspaceError("");
    try {
      const data = await api<Workspace>("workspace", "GET", undefined, signal);
      setWorkspace(data);
      setDraft(data.guardrails);
    } catch (error) {
      if (!signal?.aborted) setWorkspaceError(errorMessage(error));
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadWorkspace(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (messages.length) chatEnd.current?.scrollIntoView({ block: "nearest" });
  }, [messages, sending]);

  function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDomain(email.trim().split("@").at(-1)?.toLowerCase() ?? "");
  }

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
      const guardrails = await api<Guardrails>("guardrails", "PUT", draft);
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
    try {
      updateOrder(await api<Order>(`orders/${id}`, "PATCH", { decision }));
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
      const result = await api<Availability>(`check_availability?${params}`);
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
      const products = await api<Product[]>(`suggest_substitutes?${params}`);
      return { text: products.length ? "Here are alternatives that match your saved allergen settings." : "I couldn’t find alternatives that match your saved allergen settings.", products };
    }
    if (purchase) {
      const order = await api<Order>("create_purchase_order", "POST", {
        items: [{ product_id: purchase[2], quantity: Number(purchase[1]) }],
      });
      updateOrder(order);
      return { text: `${order.id} · ${describeOrder(order)} · ${money(order.total_cents)}. ${order.status === "pending" ? `Waiting for human approval. ${order.reasons.join(" · ")}.` : "Auto-approved in the demo workspace."}` };
    }
    if (/^(check|substitutes?|order)\b/i.test(text)) {
      return { text: "Use “Check SKU 12 YYYY-MM-DD” for price and availability, or “Substitutes for SKU” to find alternatives. Replace SKU with a product ID. Quantity and date are optional." };
    }
    const query = text.replace(/^(?:find|search(?: for)?)\s+/i, "").trim();
    const products = await api<Product[]>(`search_products?${new URLSearchParams({ query })}`);
    const nextStep = workspace?.supplier_mode === "junction"
      ? "Select a product to check its price and availability."
      : "Select a product to draft an order command.";
    return { text: products.length ? `I found ${products.length} catalog ${products.length === 1 ? "match" : "matches"}. ${nextStep}` : "I couldn’t find a match. Try a product name, category, or SKU.", products };
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || sending) return;
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
  const company = domain === "valio.fi" ? "Valio Aimo" : domain ? domain.split(".")[0].replace(/[-_]/g, " ") : "Keittiö";
  const settingsChanged = Boolean(draft && workspace && (
    draft.max_auto_approve_cents !== workspace.guardrails.max_auto_approve_cents ||
    draft.review_allergens.length !== workspace.guardrails.review_allergens.length ||
    draft.review_allergens.some((name) => !workspace.guardrails.review_allergens.includes(name))
  ));

  return (
    <div className="min-h-screen" data-branded={Boolean(domain)}>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="flex items-center gap-3">
            <div className="brand-mark" aria-hidden="true"><ShoppingBasket size={21} strokeWidth={1.8} /></div>
            <div className="brand-name">{company}<span>.</span></div>
            <span className="brand-divider" aria-hidden="true" />
            <span className="brand-context">Purchasing workspace</span>
          </div>
          <form className="email-form" onSubmit={signIn}>
            <label className="email-field">
              <Mail size={15} aria-hidden="true" />
              <span className="sr-only">Work email</span>
              <input type="email" autoComplete="email" placeholder="Work email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </label>
            <button className="email-button" type="submit">{domain ? "Switch workspace" : "Sign in"} <ChevronRight size={15} /></button>
          </form>
        </div>
      </header>

      <main className="shell">
        <div className="overview">
          <div>
            <h1>Kitchen purchasing</h1>
            <p>Source ingredients, review orders, and manage purchasing rules.</p>
          </div>
          <span className="demo-label"><span /> {liveSupplier ? "Valio Aimo Junction" : "Demo workspace"}</span>
        </div>

        <div className="dashboard-grid">
          <section className="panel chat-panel" aria-labelledby="chat-title">
            <div className="chat-header">
              <div className="chat-icon"><Bot size={23} strokeWidth={1.75} /></div>
              <div>
                <h2 id="chat-title">Kitchen AI Purchasing Agent</h2>
                <p><span className="online-dot" /> Ready to help</p>
              </div>
              <span className="supplier-label">Valio Aimo catalog</span>
            </div>

            <div className="chat-content" role="log" aria-label="Conversation">
              <div className="message">
                <div className="message-icon"><Sparkles size={16} /></div>
                <div className="message-body">
                  <span className="message-author">Purchasing Agent</span>
                  <div className="bubble welcome">
                    <strong>What are you sourcing today?</strong>
                    <p>I can find products in the Valio Aimo catalog, check price and availability, and suggest substitutes.{liveSupplier ? "" : " I can also create demo purchase orders."}</p>
                  </div>
                </div>
              </div>
              {messages.map((message, index) => (
                <div key={index} className={`message ${message.role === "user" ? "user-message" : ""}`}>
                  {message.role === "agent" ? <div className="message-icon"><Sparkles size={16} /></div> : null}
                  <div className="message-body">
                    <span className="message-author">{message.role === "user" ? "You" : "Purchasing Agent"}</span>
                    <div className="bubble">{message.text}</div>
                    {message.products?.map((product) => (
                      <button type="button" className="product" key={product.product_id} onClick={() => {
                        setInput(liveSupplier ? `Check ${product.product_id}` : `Order 1 ${product.product_id}`);
                        chatInput.current?.focus();
                      }}>
                        <span><strong>{product.name}</strong><small>{[product.product_id, product.unit, product.stock === null ? "" : `${product.stock} in stock`].filter(Boolean).join(" · ")}</small></span>
                        <span>{product.unit_price_cents === null ? "Check price" : money(product.unit_price_cents)} <ChevronRight size={14} /></span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {sending ? <p className="chat-loading">Working on your request…</p> : null}
              <div ref={chatEnd} />
            </div>

            <div className="chat-footer">
              <div className="prompts">
                {prompts.map(({ label, text, liveText, Icon }) => (
                  <button type="button" key={label} disabled={sending} onClick={() => {
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
                <label className="sr-only" htmlFor="chat-input">Message the purchasing agent</label>
                <input ref={chatInput} id="chat-input" value={input} maxLength={120} onChange={(event) => setInput(event.target.value)} placeholder={liveSupplier ? "Find an ingredient or check a product ID…" : "Find ingredients or enter an order command…"} />
                <button type="submit" aria-label="Send message" disabled={sending || !input.trim()}><ArrowUp size={19} /></button>
              </form>
              <p className="chat-note"><CircleHelp size={13} /> {liveSupplier ? "The Junction API supports catalog and delivery lookups." : "Demo orders are recorded locally."}</p>
            </div>
          </section>

          <aside className="right-panel" aria-label="Purchasing controls">
            {workspaceError ? <p className="error" role="alert">{workspaceError} <button type="button" onClick={() => void loadWorkspace()}>Retry</button></p> : null}
            {actionError ? <p className="error" role="alert">{actionError}</p> : null}

            <section className="panel side-panel" aria-labelledby="guardrails-title">
              <div className="section-heading">
                <div className="section-icon"><ShieldCheck size={20} /></div>
                <div><h2 id="guardrails-title">Valio Aimo Guardrails</h2><p>Set the rules for automatic approvals.</p></div>
              </div>
              {draft ? (
                <form className="settings" onSubmit={saveSettings}>
                  <div className="slider-label">
                    <label htmlFor="spend">Max auto-approve spend</label>
                    <output htmlFor="spend">{money(draft.max_auto_approve_cents)}</output>
                  </div>
                  <input id="spend" type="range" min="0" max="100000" step="500" value={draft.max_auto_approve_cents}
                    aria-valuetext={money(draft.max_auto_approve_cents)}
                    disabled={Boolean(activeAction)}
                    style={{ background: `linear-gradient(to right, var(--accent) ${draft.max_auto_approve_cents / 1000}%, var(--line) 0)` }}
                    onChange={(event) => {
                      setSettingsSaved(false);
                      setDraft({ ...draft, max_auto_approve_cents: Number(event.target.value) });
                    }} />
                  <div className="slider-range"><span>€0</span><span>€1,000</span></div>
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
                    <span role="status">{settingsSaved ? <><Check size={13} /> Settings saved</> : null}</span>
                    <button type="submit" className="secondary-button" disabled={!settingsChanged || Boolean(activeAction)}>Save settings</button>
                  </div>
                </form>
              ) : <p className="empty">{workspaceError ? "Guardrails unavailable." : "Loading guardrails…"}</p>}
            </section>

            <section className="panel side-panel" aria-labelledby="approval-title">
              <div className="section-heading">
                <div className="section-icon amber"><ClipboardList size={19} /></div>
                <div><h2 id="approval-title">Pending Human Approval</h2><p>Orders that need a person to review.</p></div>
                {workspace ? <span className="count">{pending.length}</span> : null}
              </div>
              {pending.length ? <div className="queue">
                {pending.map((order) => (
                  <article className="queue-card" key={order.id}>
                    <div className="queue-top"><span>{order.id}</span><strong>{money(order.total_cents)}</strong></div>
                    <h3>{describeOrder(order)}</h3>
                    <p className="reason"><Clock3 size={13} /> {order.reasons.join(" · ")}</p>
                    <div className="queue-actions">
                      <button type="button" disabled={Boolean(activeAction)} onClick={() => void decideOrder(order.id, "rejected")}>Reject</button>
                      <button type="button" disabled={Boolean(activeAction)} onClick={() => void decideOrder(order.id, "approved")}>Approve <ArrowRight size={13} /></button>
                    </div>
                  </article>
                ))}
              </div> : <p className="empty">{workspace ? "No orders awaiting approval." : workspaceError ? "Approval queue unavailable." : "Loading approvals…"}</p>}
            </section>

            <section className="panel side-panel" aria-labelledby="audit-title">
              <div className="section-heading">
                <div className="section-icon"><History size={19} /></div>
                <div><h2 id="audit-title">Order Audit Log</h2><p>Recent purchase orders and decisions.</p></div>
              </div>
              {audit.length ? <div className="audit-scroll">
                <table className="audit">
                  <thead><tr><th>Order</th><th>Status</th><th>Date</th><th>Total</th></tr></thead>
                  <tbody>
                    {audit.map((order) => (
                      <tr key={order.id}>
                        <th scope="row" title={describeOrder(order)}>{order.id}</th>
                        <td><span className={`status ${order.status}`}><span />{statusLabels[order.status]}</span></td>
                        <td><time dateTime={order.updated_at}>{dates.format(new Date(order.updated_at))}</time></td>
                        <td>{money(order.total_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div> : <p className="empty">{workspace ? "No purchase orders yet." : workspaceError ? "Audit log unavailable." : "Loading order history…"}</p>}
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
