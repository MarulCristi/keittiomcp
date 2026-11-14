"use client";

import { useState } from "react";
import type { ActivityEvent } from "../lib/browser-preview";

export default function EventLog({ events }: { events: ActivityEvent[] }) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const matches = events.filter((event) => (filter === "all" || event.result === filter) &&
    `${event.agent_name} ${event.action} ${event.order_id ?? ""} ${event.detail}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="panel side-panel" aria-labelledby="event-log-title">
    <div className="control-heading"><h2 id="event-log-title">Agent activity</h2><span className="review-caption">{matches.length} events</span></div>
    <div className="event-filters">
      <label>Search activity<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Agent, action or order" /></label>
      <label>Result<select value={filter} onChange={(event) => setFilter(event.target.value)}>
        <option value="all">All results</option>{["completed", "pending", "approved", "rejected", "blocked"].map((value) => <option key={value} value={value}>{value}</option>)}
      </select></label>
    </div>
    {!matches.length && <p className="empty">No events match these filters.</p>}
    <div className="activity-list">{matches.map((event) => <details key={event.id} className="activity-entry">
      <summary><div><strong>{event.action}</strong><span className="event-agent">{event.agent_name}</span><time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleString("en-GB")}</time></div>
        <span className={`status ${event.result === "blocked" ? "rejected" : event.result}`}><span />{event.result}</span>
      </summary>
      <div className="activity-details"><p>{event.detail}</p>{event.order_id && <p>Order {event.order_id}</p>}</div>
    </details>)}</div>
  </section>;
}
