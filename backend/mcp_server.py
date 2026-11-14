from datetime import date
from typing import Annotated

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from pydantic import Field

from valio_client import (
    Allergen, Availability, OrderLine, ProcurementError, ProcurementPlan, Product, ProductId,
    PurchaseOrder, PurchaseOrderRequest, Quantity, SearchTerm, client,
)

mcp = FastMCP("Keittiö Purchasing")


@mcp.tool
def search_products(query: SearchTerm) -> list[Product]:
    """Search the Valio Aimo wholesale catalog by name, dietary claim (e.g. lactose-free, gluten-free, vegan), category, or product ID."""
    try:
        return client.search_products(query)
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
) -> list[Product]:
    """Find Good-Better-Best ranked alternatives in the same category that preserve dietary claims and exclude specified allergens."""
    try:
        return client.suggest_substitutes(
            product_id, exclude_allergens or [], requested_date=requested_date, enrich_live=True
        )
    except ProcurementError as exc:
        raise ToolError(str(exc)) from None


@mcp.tool
def plan_procurement(
    query: SearchTerm,
    target_volume_liters_or_kg: Annotated[float, Field(gt=0, le=100_000)] = 1000.0,
    requested_date: date | None = None,
    exclude_allergens: Annotated[list[Allergen] | None, Field(max_length=6)] = None,
) -> ProcurementPlan:
    """Plan bulk wholesale fulfillment (e.g. 1,000 litres of lactose-free milk by Monday) with Good-Better-Best options and pack math."""
    try:
        return client.plan_procurement(query, target_volume_liters_or_kg, requested_date, exclude_allergens)
    except ProcurementError as exc:
        raise ToolError(str(exc)) from None


@mcp.tool
def create_purchase_order(
    items: Annotated[list[OrderLine], Field(min_length=1, max_length=50)],
    requested_date: date | None = None,
    customer: Annotated[str | None, Field(min_length=1)] = None,
) -> PurchaseOrder:
    """Create and evaluate a purchase order against Valio Aimo pricing, availability, and kitchen guardrails (auto-approve vs human review)."""
    try:
        return client.create_purchase_order(
            PurchaseOrderRequest(items=items, requested_date=requested_date, customer=customer)
        )
    except ProcurementError as exc:
        raise ToolError(str(exc)) from None


if __name__ == "__main__":
    client.initialize()
    mcp.run()
