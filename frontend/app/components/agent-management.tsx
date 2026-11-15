"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Bot, Check } from "lucide-react";
import { errorMessage, type ApiClient } from "../lib/purchasing";
import type { Agent } from "../lib/browser-preview";

const AGENT_ROLES: Record<string, string> = {
  kitchen: "Intake, allergen filtering & everyday orders up to €500.",
  inventory: "Autonomous stock audits, pack math & shortage detection.",
  purchasing: "High-limit execution, quote locks & scheduled replenishment.",
};

function AgentCard({ agent, request, onSaved, busy, onBusy }: { agent: Agent; request: ApiClient; onSaved: () => void; busy: boolean; onBusy: (value: string) => void }) {
  const [permissions, setPermissions] = useState(agent.permissions);
  const [limit, setLimit] = useState(String(agent.spending_limit_cents / 100));
  const [status, setStatus] = useState(agent.status);
  const [error, setError] = useState("");
  const changed = status !== agent.status || Number(limit) * 100 !== agent.spending_limit_cents || permissions.join() !== agent.permissions.join();

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    onBusy(agent.id);
    setError("");
    try {
      await request(`agents/${agent.id}`, "PUT", { ...agent, status, permissions, spending_limit_cents: Math.round(Number(limit) * 100) });
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      onBusy("");
    }
  }
  return <article className="panel agent-card">
    <div className="control-heading"><h2><Bot size={20} />{agent.name}</h2><span className={`status ${agent.status === "paused" ? "pending" : ""}`}><span />{agent.status}</span></div>
    <p className="review-caption">{AGENT_ROLES[agent.id] ?? "Autonomous purchasing worker."} · Last activity {agent.last_active ? new Date(agent.last_active).toLocaleTimeString("en-GB") : "No activity yet"}</p>
    <form onSubmit={save}>
      <fieldset disabled={busy}>
        <legend>Allowed actions</legend>
        <div className="agent-permissions">{(["search", "prepare", "purchase"] as const).map((permission) => <label key={permission}>
          <input type="checkbox" checked={permissions.includes(permission)} onChange={(event) => setPermissions(event.target.checked ? [...permissions, permission] : permissions.filter((entry) => entry !== permission))} />{permission}
        </label>)}</div>
        <label className="agent-field">Automatic approval limit (€)<input required type="number" min="0" max="5000" step="0.01" value={limit} onChange={(event) => setLimit(event.target.value)} /></label>
        <p className="review-caption">Purchases above this amount need human review. Purchase permission controls whether this agent can submit a purchase request.</p>
        <label className="agent-field">Agent status<select value={status} onChange={(event) => setStatus(event.target.value as Agent["status"])}><option value="connected">Connected</option><option value="paused">Paused</option></select></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary-button" type="submit" disabled={busy || !changed}>Save agent settings</button>
      </fieldset>
    </form>
  </article>;
}

export default function AgentManagement({ agents, request, onChanged, busy, onBusy }: { agents: Agent[]; request: ApiClient; onChanged: () => void; busy: boolean; onBusy: (value: string) => void }) {
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return <section aria-label="Agent management">
    <p className="decision-feedback" role="status">{notice && <><Check size={14} /> {notice}</>}</p>
    <div className="agent-grid">{agents.map((agent) => <AgentCard key={`${agent.id}:${agent.last_active}`} agent={agent} request={request} busy={busy} onBusy={onBusy}
      onSaved={() => { setNotice("Agent settings saved."); onChanged(); }} />)}</div>
  </section>;
}
