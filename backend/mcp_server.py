from datetime import date
from typing import Annotated

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from pydantic import Field

from valio_client import (
    AgentExecutionRequest, AgentExecutionResult, Allergen, Availability, OrderLine,
    PriorityMode, ProcurementError, ProcurementPlan, Product, ProductId, PurchaseOrder,
    PurchaseOrderRequest, Quantity, SearchTerm, client,
)

mcp = FastMCP("Keittiö Purchasing")


@mcp.tool
def search_products(query: SearchTerm, priority_mode: PriorityMode | None = None) -> list[Product]:
    """Search the Valio Aimo wholesale catalog by name, dietary claim, or SKU, ranked by the kitchen's priority_mode (balanced, low_carbon, lowest_price, authentic_finnish, highest_reliability)."""
    try:
        return client.search_products(query, priority_mode=priority_mode)
    except ProcurementError as exc:
        raise ToolError(str(exc)) from None


@mcp.tool
def check_availability(
    product_id: ProductId, quantity: Quantity = 1, requested_date: date | None = None,
    customer: Annotated[str | None, Field(min_length=1)] = None,
) -> Availability:
    """Check delivery availability, cutoff time, reliability, CO2 footprint, and tax-inclusive unit/comparison price for a product."""
    try:
        return client.check_availability(product_id, quantity, requested_date, customer)
    except ProcurementError as exc:
        raise ToolError(str(exc)) from None


@mcp.tool
def suggest_substitutes(
    product_id: ProductId,
    exclude_allergens: Annotated[list[Allergen] | None, Field(max_length=6)] = None,
    requested_date: date | None = None,
    priority_mode: PriorityMode | None = None,
) -> list[Product]:
    """Find Good-Better-Best ranked alternatives in the same category that preserve dietary claims, exclude specified allergens, and honor priority_mode."""
    try:
        return client.suggest_substitutes(
            product_id,
            exclude_allergens or [],
            requested_date=requested_date,
            enrich_live=True,
            priority_mode=priority_mode,
        )
    except ProcurementError as exc:
        raise ToolError(str(exc)) from None


@mcp.tool
def plan_procurement(
    query: SearchTerm,
    target_volume_liters_or_kg: Annotated[float, Field(gt=0, le=100_000)] = 1000.0,
    requested_date: date | None = None,
    exclude_allergens: Annotated[list[Allergen] | None, Field(max_length=6)] = None,
    priority_mode: PriorityMode | None = None,
) -> ProcurementPlan:
    """Plan bulk wholesale fulfillment (e.g. 1,000 litres of lactose-free milk by Monday) with Good-Better-Best options ranked by priority_mode."""
    try:
        return client.plan_procurement(
            query, target_volume_liters_or_kg, requested_date, exclude_allergens, priority_mode=priority_mode
        )
    except ProcurementError as exc:
        raise ToolError(str(exc)) from None


@mcp.tool
def create_purchase_order(
    items: Annotated[list[OrderLine], Field(min_length=1, max_length=50)],
    requested_date: date | None = None,
    customer: Annotated[str | None, Field(min_length=1)] = None,
    agent_id: Annotated[str | None, Field(min_length=1)] = None,
) -> PurchaseOrder:
    """Create and evaluate a purchase order against Valio Aimo pricing, availability, and kitchen guardrails (auto-approve vs human review)."""
    try:
        return client.create_purchase_order(
            PurchaseOrderRequest(items=items, requested_date=requested_date, customer=customer, agent_id=agent_id)
        )
    except ProcurementError as exc:
        raise ToolError(str(exc)) from None


@mcp.tool
def execute_trade_request(
    prompt: Annotated[str, Field(min_length=2, max_length=1000)],
    agent_id: str = "kitchen",
    priority_mode: PriorityMode | None = None,
    requested_date: date | None = None,
    exclude_allergens: Annotated[list[Allergen] | None, Field(max_length=6)] = None,
    auto_place_order: bool = True,
    simulate_shortage_on_primary: bool = False,
) -> AgentExecutionResult:
    """Autonomous End-to-End Trade Agent Orchestrator: parses natural-language chef requests, applies kitchen priority_mode, compares offers, automatically substitutes out-of-stock/shortage SKUs, and places/evaluates the purchase order."""
    try:
        return client.execute_trade_request(
            AgentExecutionRequest(
                prompt=prompt,
                agent_id=agent_id,
                priority_mode=priority_mode,
                requested_date=requested_date,
                exclude_allergens=exclude_allergens,
                auto_place_order=auto_place_order,
                simulate_shortage_on_primary=simulate_shortage_on_primary,
            )
        )
    except ProcurementError as exc:
        raise ToolError(str(exc)) from None


if __name__ == "__main__":
    client.initialize()
    mcp.run()
