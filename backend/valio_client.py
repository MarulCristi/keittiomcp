"""Valio Aimo Junction API and the local purchasing workspace."""

import os
import sqlite3
from collections import Counter
from contextlib import contextmanager
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from threading import Lock
from typing import Annotated, Literal, TypeVar
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv
from pydantic import AliasChoices, BaseModel, Field, StringConstraints, ValidationError, field_validator

VALIO_BASE_URL = httpx.URL("https://junction26.valioaimo.fi")
Response = TypeVar("Response", bound=BaseModel)

Allergen = Literal["milk", "gluten", "soy", "eggs", "nuts", "fish"]
ProductId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
SearchTerm = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Quantity = Annotated[int, Field(strict=True, ge=1, le=1000)]


class Product(BaseModel):
    product_id: ProductId
    name: str
    category: str
    unit: str
    unit_price_cents: int | None = None
    stock: float | None = None
    allergens: list[Allergen] | None = None


class OrderLine(BaseModel):
    product_id: ProductId
    quantity: Quantity


class PurchaseOrderRequest(BaseModel):
    items: Annotated[list[OrderLine], Field(min_length=1, max_length=50)]


class OrderItem(OrderLine):
    name: str
    unit: str
    unit_price_cents: int


class PurchaseOrder(BaseModel):
    id: str
    items: list[OrderItem]
    total_cents: int
    currency: Literal["EUR"] = "EUR"
    status: Literal["pending", "auto_approved", "approved", "rejected"]
    reasons: list[str]
    created_at: datetime
    updated_at: datetime


class Guardrails(BaseModel):
    max_auto_approve_cents: Annotated[int, Field(strict=True, ge=0, le=100_000)] = 25_000
    review_allergens: list[Allergen] = Field(default_factory=lambda: ["gluten", "nuts"], max_length=6)


class Availability(BaseModel):
    product_id: ProductId
    name: str
    requested_quantity: Quantity
    available_quantity: float | None
    available: bool | None
    requested_date: date | None = None
    available_date: date | None = None
    sales_unit: str | None = None
    sales_block: bool = False
    closing_time: str | None = None
    logistic_model: str | None = None
    unit_price_cents: int | None = None
    currency: str | None = None


class Workspace(BaseModel):
    guardrails: Guardrails
    orders: list[PurchaseOrder]
    supplier_mode: Literal["demo", "junction"] = "demo"


class ProcurementError(Exception):
    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


class CatalogEntry(BaseModel):
    product_id: ProductId = Field(validation_alias=AliasChoices("productId", "productCode", "productNumber"))
    name: str = Field(validation_alias=AliasChoices("name", "productName"), min_length=1)
    category: str = Field("", validation_alias=AliasChoices("category", "productGroup", "productGroupName"))
    unit: str = Field("", validation_alias=AliasChoices("salesUnit", "unit"))
    allergens: list[str] | None = None

    @field_validator("product_id", mode="before")
    @classmethod
    def normalize_numeric_id(cls, value):
        return str(value) if type(value) is int else value

    def as_product(self) -> Product:
        supported = {"milk", "gluten", "soy", "eggs", "nuts", "fish"}
        labels = {value.strip().casefold() for value in self.allergens} if self.allergens is not None else None
        return Product(
            product_id=self.product_id, name=self.name, category=self.category, unit=self.unit,
            allergens=sorted(labels) if labels is not None and labels <= supported else None,
        )


class ScheduleLine(BaseModel):
    sales_block: bool = Field(alias="salesBlock")
    available_amount: Annotated[Decimal, Field(ge=0)] = Field(alias="availableAmount")
    available_date: datetime | date | None = Field(None, alias="availableDate")
    sales_unit: str = Field(alias="salesUnit")


class SupplierAvailability(BaseModel):
    product_id: str = Field(alias="productId")
    closing_time: str | None = Field(None, alias="closingTime")
    sales_block: bool = Field(alias="salesBlock")
    logistic_model: str | None = Field(None, alias="logisticModel")
    schedule_lines: list[ScheduleLine] = Field(alias="scheduleLines", max_length=1)


class AvailabilityResponse(BaseModel):
    products: list[SupplierAvailability]


class TaxInclusivePrice(BaseModel):
    value: Annotated[Decimal, Field(ge=0)]


class CatalogPrice(BaseModel):
    value_with_tax: Annotated[Decimal, Field(ge=0)] = Field(alias="valueWithTax")


class SupplierPrice(BaseModel):
    product_id: str = Field(alias="productId")
    price_with_tax: TaxInclusivePrice | None = Field(None, alias="priceWithTax")
    catalog_price: CatalogPrice | None = Field(None, alias="catalogPrice")
    error: bool


class PriceResponse(BaseModel):
    currency: str
    products: list[SupplierPrice]


class ValioAPI:
    def __init__(self, api_key: str, customer: str = "123", *, transport: httpx.BaseTransport | None = None):
        self.api_key = api_key
        self.customer = customer
        self.transport = transport
        self._catalog: tuple[Product, ...] | None = None
        self._catalog_lock = Lock()

    def _http(self) -> httpx.Client:
        return httpx.Client(timeout=15, transport=self.transport, follow_redirects=False)

    def _request(self, http: httpx.Client, method: str, url: httpx.URL, **kwargs) -> httpx.Response:
        headers = {"Accept": "application/json"}
        if (url.scheme, url.host, url.port) == (VALIO_BASE_URL.scheme, VALIO_BASE_URL.host, VALIO_BASE_URL.port):
            headers["X-API-Key"] = self.api_key
        try:
            return http.request(method, url, headers=headers, **kwargs)
        except httpx.TimeoutException:
            raise ProcurementError("Valio Aimo did not respond in time.", 504) from None
        except httpx.RequestError:
            raise ProcurementError("Could not reach Valio Aimo.", 502) from None

    @staticmethod
    def _json(response: httpx.Response):
        if response.status_code in (401, 403):
            raise ProcurementError("Valio Aimo denied access. Check the configured API key and catalog access.", 502)
        if response.status_code == 429:
            raise ProcurementError("Valio Aimo rate limited the request. Try again later.", 503)
        if not response.is_success:
            raise ProcurementError(f"Valio Aimo returned HTTP {response.status_code}.", 502)
        try:
            return response.json()
        except ValueError:
            raise ProcurementError("Valio Aimo returned invalid JSON.", 502) from None

    def catalog(self) -> tuple[Product, ...]:
        with self._catalog_lock:
            if self._catalog is None:
                self._catalog = self._download_catalog()
            return self._catalog

    def _download_catalog(self) -> tuple[Product, ...]:
        url = VALIO_BASE_URL.join("/api/products/download")
        with self._http() as http:
            for _ in range(6):
                response = self._request(http, "GET", url)
                if not response.has_redirect_location:
                    break
                try:
                    url = response.url.join(response.headers["Location"])
                except httpx.InvalidURL:
                    raise ProcurementError("Valio Aimo returned an invalid catalog redirect.", 502) from None
                if url.scheme != "https" or not url.host:
                    raise ProcurementError("Valio Aimo returned an invalid catalog redirect.", 502)
            else:
                raise ProcurementError("Valio Aimo returned too many catalog redirects.", 502)
        data = self._json(response)
        rows = data.get("products") if isinstance(data, dict) else data
        if not isinstance(rows, list):
            raise ProcurementError("Valio Aimo returned an unsupported catalog format.", 502)
        try:
            return tuple(CatalogEntry.model_validate(row).as_product() for row in rows)
        except ValidationError:
            raise ProcurementError("Valio Aimo returned an unsupported catalog entry.", 502) from None

    def check_availability(
        self, product_id: str, quantity: int, requested_date: date | None, customer: str | None,
    ) -> Availability:
        delivery_date = requested_date or datetime.now(ZoneInfo("Europe/Helsinki")).date()
        payload = {
            "customer": customer or self.customer,
            "requestedDate": delivery_date.isoformat(),
            "products": [product_id],
        }
        with self._http() as http:
            availability = self._lookup(http, "/api/availability", payload, AvailabilityResponse)
            pricing = self._lookup(http, "/api/price", payload, PriceResponse)
        product = next((row for row in availability.products if row.product_id == product_id), None)
        if product is None:
            raise ProcurementError(f"Valio Aimo returned no availability for {product_id}.", 502)
        price = next((row for row in pricing.products if row.product_id == product_id and not row.error), None)
        amount = None
        if price is not None:
            if price.price_with_tax is not None:
                amount = price.price_with_tax.value
            elif price.catalog_price is not None:
                amount = price.catalog_price.value_with_tax
        cents = int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)) if amount is not None else None
        line = next(iter(product.schedule_lines), None)
        available_date = line.available_date if line else None
        if isinstance(available_date, datetime):
            available_date = available_date.date()
        blocked = product.sales_block or bool(line and line.sales_block)
        terminal = line is not None and line.available_amount == 999999
        available_quantity = float(line.available_amount) if line else 0
        if terminal:
            available_quantity = None
        available = False
        if not blocked and line and line.available_amount > 0:
            if available_date is None:
                available = None
            elif available_date <= delivery_date:
                available = None if terminal else line.available_amount >= quantity
        name = next((item.name for item in self._catalog or () if item.product_id == product_id), product_id)
        return Availability(
            product_id=product_id, name=name, requested_quantity=quantity, requested_date=delivery_date,
            available_quantity=available_quantity, available=available, available_date=available_date,
            sales_unit=line.sales_unit if line else None, sales_block=blocked,
            closing_time=product.closing_time, logistic_model=product.logistic_model,
            unit_price_cents=cents, currency=pricing.currency if cents is not None else None,
        )

    def _lookup(self, http: httpx.Client, path: str, payload: dict, schema: type[Response]) -> Response:
        response = self._request(http, "POST", VALIO_BASE_URL.join(path), json=payload)
        try:
            return schema.model_validate(self._json(response))
        except ValidationError:
            raise ProcurementError("Valio Aimo returned an unexpected pricing or availability response.", 502) from None


CATALOG = {
    product.product_id: product
    for product in (
        Product(product_id="AIMO-101", name="Whole milk", category="milk", unit="1 L", unit_price_cents=189, stock=160, allergens=["milk"]),
        Product(product_id="AIMO-102", name="Oat drink", category="milk", unit="1 L", unit_price_cents=249, stock=84, allergens=["gluten"]),
        Product(product_id="AIMO-103", name="Soy drink", category="milk", unit="1 L", unit_price_cents=239, stock=60, allergens=["soy"]),
        Product(product_id="AIMO-201", name="Lactose-free cooking cream", category="cream", unit="1 L", unit_price_cents=649, stock=100, allergens=["milk"]),
        Product(product_id="AIMO-202", name="Oat cooking cream", category="cream", unit="1 L", unit_price_cents=569, stock=75, allergens=["gluten"]),
        Product(product_id="AIMO-301", name="Sourdough bread", category="bread", unit="800 g", unit_price_cents=590, stock=80, allergens=["gluten"]),
        Product(product_id="AIMO-302", name="Gluten-free oat loaf", category="bread", unit="500 g", unit_price_cents=725, stock=36, allergens=[]),
        Product(product_id="AIMO-401", name="Atlantic salmon fillet", category="seafood", unit="1 kg", unit_price_cents=2490, stock=25, allergens=["fish"]),
        Product(product_id="AIMO-402", name="Rainbow trout fillet", category="seafood", unit="1 kg", unit_price_cents=1960, stock=24, allergens=["fish"]),
        Product(product_id="AIMO-501", name="Free-range eggs", category="eggs", unit="30 pcs", unit_price_cents=899, stock=35, allergens=["eggs"]),
    )
}


class ValioClient:
    def __init__(self, database: Path, supplier: ValioAPI | None = None):
        self.database = database
        self.supplier = supplier

    @contextmanager
    def transaction(self, *, write: bool = False):
        db = sqlite3.connect(self.database)
        try:
            with db:
                db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
                yield db
        finally:
            db.close()

    def initialize(self):
        with self.transaction(write=True) as db:
            db.execute("CREATE TABLE IF NOT EXISTS orders (number INTEGER PRIMARY KEY, payload TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)")
            inserted = db.execute(
                "INSERT OR IGNORE INTO settings VALUES (1, ?)", (Guardrails().model_dump_json(),)
            )
            if inserted.rowcount and self.supplier is None:
                seed = [
                    ("AIMO-201", 12, "auto_approved", []),
                    ("AIMO-101", 18, "auto_approved", []),
                    ("AIMO-501", 6, "approved", []),
                    ("AIMO-301", 12, "pending", ["Contains gluten"]),
                    ("AIMO-401", 14, "pending", ["Over €250.00 auto-approval limit"]),
                ]
                for number, (product_id, quantity, status, reasons) in enumerate(seed, 1044):
                    product = CATALOG[product_id]
                    timestamp = datetime(2026, 11, 13, 8, (number - 1044) * 10, tzinfo=timezone.utc)
                    order = PurchaseOrder(
                        id=f"PO-{number}", items=[self.order_item(product, quantity)],
                        total_cents=product.unit_price_cents * quantity, status=status,
                        reasons=reasons, created_at=timestamp, updated_at=timestamp,
                    )
                    db.execute("INSERT INTO orders VALUES (?, ?)", (number, order.model_dump_json()))

    @staticmethod
    def product(product_id: str) -> Product:
        product = CATALOG.get(product_id.upper())
        if product is None:
            raise ProcurementError(f"Unknown product ID: {product_id}", 404)
        return product

    @staticmethod
    def order_item(product: Product, quantity: int) -> OrderItem:
        return OrderItem(
            product_id=product.product_id, quantity=quantity, name=product.name,
            unit=product.unit, unit_price_cents=product.unit_price_cents,
        )

    @staticmethod
    def orders(db) -> list[PurchaseOrder]:
        return [
            PurchaseOrder.model_validate_json(payload)
            for (payload,) in db.execute("SELECT payload FROM orders ORDER BY number DESC")
        ]

    @staticmethod
    def guardrails(db) -> Guardrails:
        (payload,) = db.execute("SELECT payload FROM settings WHERE id = 1").fetchone()
        return Guardrails.model_validate_json(payload)

    @staticmethod
    def stock(orders: list[PurchaseOrder]) -> dict[str, int]:
        ordered = Counter()
        for order in orders:
            if order.status in ("auto_approved", "approved"):
                for item in order.items:
                    ordered[item.product_id] += item.quantity
        return {key: product.stock - ordered[key] for key, product in CATALOG.items()}

    def search_products(self, query: str) -> list[Product]:
        terms = query.casefold().split()
        if self.supplier:
            matches = [
                product for product in self.supplier.catalog()
                if all(term in f"{product.product_id} {product.name} {product.category}".casefold() for term in terms)
            ]
            matches.sort(key=lambda item: item.product_id.casefold() != query.casefold())
            return matches[:25]
        with self.transaction() as db:
            stock = self.stock(self.orders(db))
        return [
            product.model_copy(update={"stock": stock[product.product_id]})
            for product in CATALOG.values()
            if all(term in f"{product.product_id} {product.name} {product.category}".casefold() for term in terms)
        ]

    def check_availability(
        self, product_id: str, quantity: int, requested_date: date | None = None, customer: str | None = None,
    ) -> Availability:
        if self.supplier:
            return self.supplier.check_availability(product_id, quantity, requested_date, customer)
        product = self.product(product_id)
        with self.transaction() as db:
            available = self.stock(self.orders(db))[product.product_id]
        return Availability(
            product_id=product.product_id, name=product.name, requested_quantity=quantity,
            available_quantity=available, available=available >= quantity, requested_date=requested_date,
            unit_price_cents=product.unit_price_cents, currency="EUR",
        )

    def suggest_substitutes(self, product_id: str, exclude_allergens: list[Allergen]) -> list[Product]:
        if self.supplier:
            catalog = self.supplier.catalog()
            original = next((item for item in catalog if item.product_id.casefold() == product_id.casefold()), None)
            if original is None:
                raise ProcurementError(f"Unknown product ID: {product_id}", 404)
            if not original.category:
                return []
            excluded = set(exclude_allergens)
            return [
                item for item in catalog if item.product_id != original.product_id
                and item.category == original.category
                and (not excluded or (item.allergens is not None and excluded.isdisjoint(item.allergens)))
            ][:25]
        original = self.product(product_id)
        return [
            product for product in self.search_products(original.category)
            if product.category == original.category and product.product_id != original.product_id
            and product.stock > 0 and set(exclude_allergens).isdisjoint(product.allergens)
        ]

    def workspace(self) -> Workspace:
        with self.transaction() as db:
            return Workspace(
                guardrails=self.guardrails(db), orders=self.orders(db),
                supplier_mode="junction" if self.supplier else "demo",
            )

    def update_guardrails(self, guardrails: Guardrails) -> Guardrails:
        with self.transaction(write=True) as db:
            db.execute("UPDATE settings SET payload = ? WHERE id = 1", (guardrails.model_dump_json(),))
        return guardrails

    def create_purchase_order(self, request: PurchaseOrderRequest) -> PurchaseOrder:
        if self.supplier:
            raise ProcurementError("The Valio Aimo Junction API does not provide an order submission endpoint.", 501)
        quantities = Counter()
        for line in request.items:
            quantities[self.product(line.product_id).product_id] += line.quantity

        with self.transaction(write=True) as db:
            stock = self.stock(self.orders(db))
            items = []
            allergens = set()
            for product_id, quantity in quantities.items():
                product = self.product(product_id)
                if quantity > stock[product_id]:
                    raise ProcurementError(f"Only {stock[product_id]} units of {product.name} are available")
                items.append(self.order_item(product, quantity))
                allergens.update(product.allergens)

            total = sum(item.quantity * item.unit_price_cents for item in items)
            guardrails = self.guardrails(db)
            reasons = [f"Contains {name}" for name in sorted(allergens.intersection(guardrails.review_allergens))]
            if total > guardrails.max_auto_approve_cents or guardrails.max_auto_approve_cents == 0:
                limit = guardrails.max_auto_approve_cents / 100
                reasons.append(f"Over €{limit:,.2f} auto-approval limit")

            (number,) = db.execute("SELECT COALESCE(MAX(number), 1043) + 1 FROM orders").fetchone()
            now = datetime.now(timezone.utc)
            order = PurchaseOrder(
                id=f"PO-{number}", items=items, total_cents=total, reasons=reasons,
                status="pending" if reasons else "auto_approved", created_at=now, updated_at=now,
            )
            db.execute("INSERT INTO orders VALUES (?, ?)", (number, order.model_dump_json()))
            return order

    def decide_order(self, order_id: str, decision: Literal["approved", "rejected"]) -> PurchaseOrder:
        with self.transaction(write=True) as db:
            orders = self.orders(db)
            order = next((order for order in orders if order.id == order_id), None)
            if order is None:
                raise ProcurementError(f"Unknown order ID: {order_id}", 404)
            if order.status == decision:
                return order
            if order.status != "pending":
                raise ProcurementError(f"{order_id} has already been decided")
            if decision == "approved":
                stock = self.stock(orders)
                for item in order.items:
                    if item.quantity > stock[item.product_id]:
                        raise ProcurementError(f"Only {stock[item.product_id]} units of {item.name} are available")
            order.status = decision
            order.updated_at = datetime.now(timezone.utc)
            db.execute(
                "UPDATE orders SET payload = ? WHERE number = ?",
                (order.model_dump_json(), int(order.id.removeprefix("PO-"))),
            )
            return order


load_dotenv(Path(__file__).with_name(".env"))
api_key = os.getenv("VALIO_API_KEY", "").strip()
supplier = ValioAPI(api_key, os.getenv("VALIO_CUSTOMER_ID", "").strip() or "123") if api_key else None
client = ValioClient(Path(__file__).with_name("junction.sqlite3" if supplier else "demo.sqlite3"), supplier)
