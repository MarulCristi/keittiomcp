# Trusted Trade Agents requirement check

Checked against the supplied Junction 2026 poster and repository revision 01e5207.

## Core flow

| Requirement | Frontend coverage | Remaining verification |
| --- | --- | --- |
| Buyer request | Demo tools accepts ingredient requirements, target litres/kg, delivery date and allergen exclusions through the existing procurement planner endpoint. | Run with the mock backend and verify returned products satisfy the request. |
| Product, price and availability lookup | Catalog results, price comparisons, quantity/date lookup and unknown-data states. Lookups run on user actions. | Verify supplier data and units in the connected demo. |
| Order at fixed prices | Review price and quantity, check availability, then submit to the existing order endpoint in demo or Junction mode. Display the recorded total. | Backend must define price validity or quote locking. The current request contract has no accepted-price/quote ID. |
| Permissions and human approval | Workspace spending, allergen, reliability and substitution policies. Approval cards send approve/reject decisions and display returned status. | Agent identity, per-agent permissions and blocked-action audit records need backend contracts. |
| Complete external-agent demonstration | Existing REST/MCP backend can be paired with the management frontend. Refresh workspace loads externally created orders. | Rehearse external request → lookup → order → decision with the backend owner. |

## Optional features and judging support

| Requirement | Coverage |
| --- | --- |
| Delivery reliability and sustainability labels | Display supplier-provided values on product cards and lookup results. Missing fields remain explicit. |
| Partial availability | Show requested-quantity shortages, keep order action disabled and provide alternatives. Procurement planner shows fulfillment options and trade-offs. |
| Substitutions | Display returned ranking/reasons. Alternative selections retain original SKU and delivery date, and submit substitution metadata for policy enforcement. |
| Explain decisions | Display returned approval reasons and order verification metadata in Activity. Tool-call history needs a backend event feed. |
| Open standards | The repository uses FastAPI REST/JSON with generated OpenAPI and MCP. The order verification protocol is application-specific metadata. |
| Production path | Agree agent authentication and permissions, idempotent order creation, fixed-price quote validity, final supplier submission, and persistent decision events. |

## Browser-only rehearsal

The explicit **Browser preview** mode now supports simulated purchasing, approvals, editable per-agent permissions/limits/status, workspace policies, and searchable/filterable event explanations. It includes routine, over-limit and permission-blocked scenarios and uses the same request-planning and order-review screens. All preview data is synthetic and session-only. It does not establish backend enforcement, supplier delivery or fixed-price commitment. Agent and event screens remain awaiting agreed contracts in service mode; see INTEGRATION.md.

## Service integration findings

The frontend session does not start or modify the backend. The local preview currently reports a disconnected purchasing service.

The reviewed Junction order code records an order and evaluates guardrails locally. It does not demonstrate a supplier submission. It also allows a missing price to fall back to zero and checks batch availability with quantity 1 before constructing higher-quantity orders. These are backend-owner review items for external-agent requests, even though the frontend review blocks unknown prices and known shortages.

Approval changes the recorded status. A passing frontend check does not verify supplier commitment or backend enforcement.

## Required demo rehearsal

1. Connect the mock backend and external MCP client.
2. Run an eligible routine purchase and inspect its returned decision and recorded total.
3. Run an over-limit purchase, approve it in the Approval Centre, and verify the backend result.
4. Run an unauthorized or sales-blocked request and verify backend denial plus its audit record.
5. Run a shortage request, inspect alternatives and verify substitution approval policy.
6. Verify the chosen delivery date and dietary requirements survive the full flow.

All scenarios still need connected end-to-end verification.
