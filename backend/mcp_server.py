from datetime import date
from typing import Annotated

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from pydantic import Field

from valio_client import (
    Allergen, Availability, OrderLine, ProcurementError, Product, ProductId, PurchaseOrder,
    PurchaseOrderRequest, Quantity, SearchTerm, client,
)

mcp = FastMCP("Keittiö Purchasing")


@mcp.tool
def search_products(query: SearchTerm) -> list[Product]:
    """Search the supplier catalog by name, category, or product ID."""
    try:
        return client.search_products(query)
    except ProcurementError as exc:
        raise ToolError(str(exc)) from None


@mcp.tool
def check_availability(
    product_id: ProductId, quantity: Quantity = 1, requested_date: date | None = None,
    customer: Annotated[str | None, Field(min_length=1)] = None,
) -> Availability:
    """Check delivery availability and tax-inclusive unit price for a product, date, and optional customer."""
    try:
        return client.check_availability(product_id, quantity, requested_date, customer)
    except ProcurementError as exc:
        raise ToolError(str(exc)) from None


@mcp.tool
def suggest_substitutes(
    product_id: ProductId,
    exclude_allergens: Annotated[list[Allergen] | None, Field(max_length=6)] = None,
) -> list[Product]:
    """Find alternatives in the same catalog category. Check each candidate's availability separately."""
    try:
        return client.suggest_substitutes(product_id, exclude_allergens or [])
    except ProcurementError as exc:
        raise ToolError(str(exc)) from None


@mcp.tool
def create_purchase_order(
    items: Annotated[list[OrderLine], Field(min_length=1, max_length=50)],
) -> PurchaseOrder:
    """Record a demo purchase order. The Valio Aimo Junction API does not support order submission."""
    try:
        return client.create_purchase_order(PurchaseOrderRequest(items=items))
    except ProcurementError as exc:
        raise ToolError(str(exc)) from None


if __name__ == "__main__":
    client.initialize()
    mcp.run()
