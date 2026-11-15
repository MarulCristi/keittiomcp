from contextlib import asynccontextmanager
from datetime import date
from typing import Annotated, Literal

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from mcp_server import mcp
from image_references import ImageReferences, image_search
from valio_client import (
    ActivityEvent, AgentExecutionRequest, AgentExecutionResult, AgentProfile, AgentUpdate,
    Allergen, Availability, ClockAdvanceRequest, ClockAdvanceResponse, CreateScheduleRequest,
    Guardrails, PriorityMode, ProcurementError, ProcurementPlan, Product, ProductId,
    PurchaseOrder, PurchaseOrderRequest, ScheduleUpdate, ScheduleWorkspaceState,
    SearchTerm, Workspace, client,
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


@app.exception_handler(Exception)
async def unhandled_error(_request: Request, exc: Exception):
    import traceback
    traceback.print_exc()
    return JSONResponse(status_code=500, content={"detail": f"Purchasing service error ({type(exc).__name__}): {exc}"})


@app.get("/api/search_products")
def search_products(query: SearchTerm, priority_mode: PriorityMode | None = None) -> list[Product]:
    return client.search_products(query, priority_mode=priority_mode)


class BlockedAllergenMatches(BaseModel):
    products: list[Product]
    blocking_allergens: list[Allergen]


@app.get("/api/blocked_allergen_matches")
def blocked_allergen_matches(
    query: SearchTerm,
    exclude_allergens: Annotated[list[Allergen] | None, Query(max_length=6)] = None,
    priority_mode: PriorityMode | None = None,
) -> BlockedAllergenMatches:
    products, blocking = client.blocked_allergen_matches(
        query, exclude_allergens=exclude_allergens, priority_mode=priority_mode
    )
    return BlockedAllergenMatches(products=products[:3], blocking_allergens=blocking)


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
    priority_mode: PriorityMode | None = None,
) -> list[Product]:
    return client.suggest_substitutes(
        product_id,
        exclude_allergens or [],
        requested_date=requested_date,
        enrich_live=enrich_live,
        priority_mode=priority_mode,
    )


@app.get("/api/plan_procurement")
def plan_procurement(
    query: SearchTerm,
    target_volume_liters_or_kg: Annotated[float, Query(gt=0, le=100_000)] = 1000.0,
    requested_date: date | None = None,
    exclude_allergens: Annotated[list[Allergen] | None, Query(max_length=6)] = None,
    priority_mode: PriorityMode | None = None,
) -> ProcurementPlan:
    return client.plan_procurement(
        query, target_volume_liters_or_kg, requested_date, exclude_allergens, priority_mode=priority_mode
    )


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


@app.get("/api/agents")
def list_agents() -> list[AgentProfile]:
    return client.list_agents()


@app.put("/api/agents/{agent_id}")
def update_agent(agent_id: str, body: AgentUpdate) -> AgentProfile:
    return client.update_agent(agent_id, body)


@app.get("/api/events")
def list_events() -> list[ActivityEvent]:
    return client.list_events()


@app.post("/api/agent_execute")
def agent_execute(request: AgentExecutionRequest) -> AgentExecutionResult:
    return client.execute_trade_request(request)


@app.get("/api/schedules")
def list_schedules() -> ScheduleWorkspaceState:
    return client.schedule_state()


@app.post("/api/schedules", status_code=201)
def create_schedule(request: CreateScheduleRequest) -> ScheduleWorkspaceState:
    return client.create_schedule(request)


@app.patch("/api/schedules/{rule_id}")
def update_schedule(rule_id: str, body: ScheduleUpdate) -> ScheduleWorkspaceState:
    return client.update_schedule(rule_id, body)


@app.delete("/api/schedules/{rule_id}")
def delete_schedule(rule_id: str) -> ScheduleWorkspaceState:
    return client.delete_schedule(rule_id)


@app.post("/api/clock/advance")
def advance_clock(request: ClockAdvanceRequest) -> ClockAdvanceResponse:
    return client.advance_clock(request)


@app.get("/api/image_references")
async def image_references(
    query: Annotated[str, Query(min_length=2, max_length=200)],
    product_id: Annotated[str | None, Query(max_length=64)] = None,
) -> ImageReferences:
    if product_id:
        pid = product_id.strip()
        lookup_fn = getattr(client.supplier, "product_by_id", None)
        product = lookup_fn(pid) if callable(lookup_fn) else None
        gtins = product.gtins if product else []
        search_label = (product.name_fi or product.name) if product else query
        return await image_search.resolve_product_thumbnail(pid, search_label, gtins)
    return await image_search.lookup(query)


app.mount("/", mcp_app)
