from contextlib import asynccontextmanager
from datetime import date
from typing import Annotated, Literal

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from mcp_server import mcp
from valio_client import (
    Allergen, Availability, Guardrails, ProcurementError, ProcurementPlan, Product, ProductId,
    PurchaseOrder, PurchaseOrderRequest, SearchTerm, Workspace, client,
)

mcp_app = mcp.http_app(path="/mcp", stateless_http=True, json_response=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    client.initialize()
    async with mcp_app.lifespan(app):
        yield


app = FastAPI(title="Keittiö Purchasing API", version="0.2.0", lifespan=lifespan)


@app.exception_handler(ProcurementError)
async def procurement_error(_request: Request, exc: ProcurementError):
    return JSONResponse(status_code=exc.status, content={"detail": str(exc)})


@app.get("/api/search_products")
def search_products(query: SearchTerm) -> list[Product]:
    return client.search_products(query)


@app.get("/api/check_availability")
def check_availability(
    product_id: ProductId, quantity: Annotated[int, Query(ge=1, le=10000)] = 1,
    requested_date: date | None = None, customer: Annotated[str | None, Query(min_length=1)] = None,
) -> Availability:
    return client.check_availability(product_id, quantity, requested_date, customer)


@app.get("/api/suggest_substitutes")
def suggest_substitutes(
    product_id: ProductId,
    exclude_allergens: Annotated[list[Allergen] | None, Query(max_length=6)] = None,
    requested_date: date | None = None,
    enrich_live: bool = True,
) -> list[Product]:
    return client.suggest_substitutes(
        product_id, exclude_allergens or [], requested_date=requested_date, enrich_live=enrich_live
    )


@app.get("/api/plan_procurement")
def plan_procurement(
    query: SearchTerm,
    target_volume_liters_or_kg: Annotated[float, Query(gt=0, le=100_000)] = 1000.0,
    requested_date: date | None = None,
    exclude_allergens: Annotated[list[Allergen] | None, Query(max_length=6)] = None,
) -> ProcurementPlan:
    return client.plan_procurement(query, target_volume_liters_or_kg, requested_date, exclude_allergens)


@app.post("/api/create_purchase_order", status_code=201)
def create_purchase_order(order: PurchaseOrderRequest) -> PurchaseOrder:
    return client.create_purchase_order(order)


@app.get("/api/workspace")
def workspace() -> Workspace:
    return client.workspace()


@app.put("/api/guardrails")
def update_guardrails(guardrails: Guardrails) -> Guardrails:
    return client.update_guardrails(guardrails)


class OrderDecision(BaseModel):
    decision: Literal["approved", "rejected"]


@app.patch("/api/orders/{order_id}")
def decide_order(order_id: str, body: OrderDecision) -> PurchaseOrder:
    return client.decide_order(order_id, body.decision)


app.mount("/", mcp_app)
