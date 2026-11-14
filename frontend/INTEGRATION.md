# Frontend integration handoff

The frontend has two explicit modes. **Service connection** calls the existing backend through `/api/`. **Browser preview** injects an in-memory adapter and makes no purchasing API calls. Preview data is discarded on reload and is never copied into the service workspace.

## Existing connection points

- `app/lib/purchasing.ts`: shared product, availability, workspace and order types; `api` implements the HTTP client.
- `app/page.tsx`: selects the client and loads workspace policies/orders. Mode switches clear messages, selections and workspace state.
- `app/components/request-planner.tsx` and `order-review.tsx`: accept a `request` client, so the same screens work with service responses or preview fixtures.
- `app/lib/browser-preview.ts`: isolated fixture adapter. This is not a replacement backend or a security boundary.
- `next.config.ts`: existing `/api/` forwarding configuration. Set `BACKEND_URL` in the ignored `.env.local` file and restart Next.js when the backend owner supplies the service address.

Current screens use `workspace`, `guardrails`, `orders/{id}`, `search_products`, `check_availability`, `suggest_substitutes`, `plan_procurement` and `create_purchase_order` routes. Keep the existing server contracts as the authority; map returned data in the frontend when necessary.

## Agent and event screens awaiting agreed contracts

Agent management and detailed events currently run only in browser preview. Service mode does not call speculative agent/event endpoints. These are proposed shapes to discuss with the backend owner:

| Proposed route | Data |
| --- | --- |
| `GET /api/agents` | Array of agents: `id`, `name`, `status` (`connected` or `paused`), `permissions` (`search`, `prepare`, `purchase`), `spending_limit_cents`, `last_active` (ISO timestamp or null). |
| `PUT /api/agents/{id}` | Editable `status`, `permissions`, `spending_limit_cents`; returns the saved agent. |
| `GET /api/events` | Array of events: `id`, `agent_name`, `action`, `result` (`completed`, `pending`, `approved`, `rejected`, `blocked`), `detail`, `timestamp`, optional `order_id`. |

The exact frontend types are exported from `browser-preview.ts`. `agent-management.tsx` and `event-log.tsx` are reusable presentation components. Once contracts are agreed, move the shared types to the service model, fetch real agents/events, and replace the service-mode placeholders with these components. Adapt labels such as the preview save notice at that point. Error/loading and empty states must remain explicit.

The backend must authenticate agent identity and enforce permissions, limits and approval decisions independently. Browser controls do not secure external MCP or REST clients. Activity must come from server events in connected mode.

## Final joint rehearsal

Verify the full request → lookup → recorded order → approval flow against the actual mock service, including declined permission, shortage, substitution, allergy exclusions and delivery date. Confirm price validity/quote commitment and what happens after approval with the backend owner; an approved record is not proof of supplier submission. See CHALLENGE-COVERAGE.md for outstanding integration findings.
