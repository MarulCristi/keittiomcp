"""Interactive console test script for KeittioMCP.

Run interactively:
    backend\.venv\Scripts\python.exe backend/test_demo.py

Or pass any query directly:
    backend\.venv\Scripts\python.exe backend/test_demo.py "50 kg salmon"
    backend\.venv\Scripts\python.exe backend/test_demo.py "200 litres of oat drink"
"""

import re
import sys
import time
from valio_client import Allergen, OrderLine, ProcurementError, PurchaseOrderRequest, client


def banner(title: str):
    print("\n" + "=" * 82)
    print(f"  {title}")
    print("=" * 82)


def parse_volume_from_input(user_text: str) -> float:
    """Extract target volume/weight (in L or kg) if the user typed a number like '500 L' or '40 kg'."""
    match = re.search(
        r"\b(\d+(?:[.,]\d+)?)\s*(?:litres?|liters?|l|kilograms?|kilos?|kg|units?|packs?)\b",
        user_text,
        re.IGNORECASE,
    )
    if match:
        return float(match.group(1).replace(",", "."))
    num_match = re.search(r"\b(\d+(?:[.,]\d+)?)\b", user_text)
    if num_match:
        val = float(num_match.group(1).replace(",", "."))
        # Ignore 6-digit Valio SKU numbers when guessing volume
        if val < 100000:
            return val
    return 100.0


def parse_excluded_allergens(user_text: str) -> list[Allergen]:
    """Extract any 'without <allergen>' or '<allergen>-free' rules from the user query."""
    low = user_text.casefold()
    excluded: list[Allergen] = []
    for allergen in ("gluten", "nuts", "milk", "soy", "eggs", "fish"):
        if (
            f"no {allergen}" in low
            or f"without {allergen}" in low
            or f"{allergen}-free" in low
            or f"{allergen} free" in low
        ):
            excluded.append(allergen)  # type: ignore[arg-type]
    return excluded


def run_query_pipeline(user_query: str, create_test_order: bool = False):
    target_vol = parse_volume_from_input(user_query)
    excluded = parse_excluded_allergens(user_query) or ["gluten", "nuts"]

    banner(f"1. SMART LOCAL CATALOG SEARCH FOR: '{user_query}'")
    results = client.search_products(user_query)
    if not results:
        print(f"No products matched '{user_query}'. Try another ingredient name, brand, or SKU.")
        return

    print(f"Found {len(results)} matching products (showing top 5 with full metadata):")
    for idx, p in enumerate(results[:5], 1):
        rel_str = f"{p.delivery_reliability * 100:.1f}%" if p.delivery_reliability is not None else "N/A"
        co2_str = f"{p.carbon_footprint_kg:.2f} kg CO2/kg" if p.carbon_footprint_kg is not None else "N/A"
        print(
            f"  {idx}. SKU {p.product_id} — \"{p.name}\"\n"
            f"     Finnish Name   : {p.name_fi or 'N/A'} | Vendor: {p.vendor or 'N/A'}\n"
            f"     Sales Unit     : {p.unit} | Category: {p.category}\n"
            f"     Reliability    : {rel_str} | Carbon Footprint: {co2_str}\n"
            f"     Dietary Claims : {p.dietary_claims} | Allergens: {p.allergens}\n"
            f"     Certificates   : {p.sustainability_labels}"
        )

    top_product = results[0]

    banner(
        f"2. LIVE VALIO AIMO AVAILABILITY & PRICE FOR TOP MATCH:\n"
        f"     SKU {top_product.product_id} — \"{top_product.name}\""
    )
    try:
        av = client.check_availability(top_product.product_id, quantity=10)
        price_str = f"EUR {av.unit_price_cents / 100:.2f}" if av.unit_price_cents else "N/A"
        comp_str = (
            f"EUR {av.comparison_price_cents / 100:.2f}/{av.comparison_unit}"
            if av.comparison_price_cents and av.comparison_unit
            else "N/A"
        )
        stock_str = (
            "UNLIMITED (Terminal >= 999999)"
            if av.available_quantity is None and av.available
            else f"{av.available_quantity} {av.sales_unit or ''}"
        )
        print(
            f"  Product            : SKU {av.product_id} — \"{av.name}\"\n"
            f"  Available (10 pcs) : {av.available} (Live Stock: {stock_str})\n"
            f"  Unit Price (+tax)  : {price_str} per {av.sales_unit or top_product.unit}\n"
            f"  Comparison Price   : {comp_str}\n"
            f"  Logistic Model     : {av.logistic_model} | Order Cut-off: {av.closing_time}"
        )
    except ProcurementError as exc:
        print(f"  Live lookup error: {exc}")

    banner(
        f"3. GOOD-BETTER-BEST SUBSTITUTES IF OUT OF STOCK:\n"
        f"     Replacing SKU {top_product.product_id} — \"{top_product.name}\"\n"
        f"     (Excluding allergens: {excluded})"
    )
    subs = client.suggest_substitutes(top_product.product_id, exclude_allergens=excluded, enrich_live=True)
    if not subs:
        print("  No substitutes found in the same category matching those allergen rules.")
    else:
        for s in subs[:3]:
            price_str = f"EUR {s.unit_price_cents / 100:.2f}" if s.unit_price_cents else "N/A"
            stock_str = "Terminal (Unlimited)" if s.stock is None else f"{s.stock:g} units"
            print(
                f"  [{(s.substitute_tier or 'option').upper()}] SKU {s.product_id} — \"{s.name}\" ({s.unit})\n"
                f"    Live Unit Price : {price_str} | Live Stock: {stock_str}\n"
                f"    Selection Logic : {s.substitute_reason}"
            )

    banner(
        f"4. WHOLESALE VOLUME PLANNER ({target_vol:g} L/kg of '{user_query}' by Monday 2026-11-16)"
    )
    try:
        plan = client.plan_procurement(
            user_query, target_volume_liters_or_kg=target_vol, exclude_allergens=excluded
        )
        print(f"  Planner Summary: {plan.summary}\n")
        for opt in plan.options:
            print(f"  [{opt.tier.upper()}] {opt.headline}")
            print(f"    Product     : SKU {opt.product.product_id} — \"{opt.product.name}\" ({opt.product.unit})")
            print(f"    Fulfillment : {opt.tradeoff_explanation}")

        if create_test_order and plan.options:
            best_opt = plan.options[0]
            banner(
                f"5. GUARDRAIL EVALUATION FOR ORDERING {best_opt.recommended_packs} × "
                f"SKU {best_opt.product.product_id} — \"{best_opt.product.name}\""
            )
            po = client.create_purchase_order(
                PurchaseOrderRequest(
                    items=[
                        OrderLine(
                            product_id=best_opt.product.product_id,
                            quantity=min(best_opt.recommended_packs, 10000),
                        )
                    ]
                )
            )
            print(f"  Order ID         : {po.id}")
            for i in po.items:
                print(
                    f"  Line Item        : {i.quantity} × SKU {i.product_id} — \"{i.name}\" ({i.unit}) "
                    f"@ EUR {i.unit_price_cents / 100:.2f}/unit"
                )
            print(f"  Total Order Cost : EUR {po.total_cents / 100:,.2f}")
            print(f"  Total Carbon     : {po.total_carbon_kg:,.2f} kg CO2e")
            print(f"  Guardrail Status : {po.status.upper()}")
            print(f"  Review Reasons   : {po.reasons or ['None — within all autonomous guardrails!']}")
            if po.trust_verification:
                print(f"  Trust Protocol   : {po.trust_verification.protocol}")
                print(f"  Order Cut-off    : {po.trust_verification.earliest_closing_time}")
                print(f"  Redacted Fields  : {po.trust_verification.redacted_confidential_fields}")
    except ProcurementError as exc:
        print(f"  Planner note: {exc}")


def main():
    banner("INITIALIZING KEITTIOMCP BACKEND & LOADING 3 STATIC VALIO DATASETS")
    t0 = time.time()
    client.initialize()
    ws = client.workspace()
    if client.supplier:
        cat = client.supplier.catalog()
        print(f"Loaded {len(cat):,} Valio Aimo products in {time.time() - t0:.2f}s (Mode: {ws.supplier_mode.upper()})")
    print(
        f"Active Guardrails: Max Auto-Approve = EUR {ws.guardrails.max_auto_approve_cents / 100:,.2f} | "
        f"Restricted Allergens = {ws.guardrails.review_allergens} | "
        f"Min Reliability = {ws.guardrails.min_delivery_reliability * 100:.0f}%"
    )

    # If the user passed a query on the command line, run it once and exit
    if len(sys.argv) > 1:
        user_query = " ".join(sys.argv[1:]).strip()
        run_query_pipeline(user_query, create_test_order=False)
        return

    # Interactive mode
    print("\n" + "-" * 82)
    print("INTERACTIVE MODE: Type any food request, ingredient, or SKU to test the engine!")
    print("Examples you can type:")
    print("  • 1000 litres of lactose-free milk")
    print("  • 50 kg salmon")
    print("  • 200 litres of oat drink")
    print("  • gluten-free bread")
    print("  • 40 kg potato salad")
    print("  • 463038")
    print("Type 'q' or 'exit' to quit, or press Enter for '1000 litres of lactose-free milk'.")
    print("-" * 82)

    while True:
        try:
            raw_input_str = input("\nEnter your kitchen request (or 'q' to quit): ").strip()
        except EOFError:
            # If run non-interactively without stdin, run the default showcase once
            run_query_pipeline("1000 litres of lactose-free milk", create_test_order=False)
            break

        if raw_input_str.lower() in ("q", "quit", "exit"):
            print("Exiting interactive test.")
            break

        query = raw_input_str or "1000 litres of lactose-free milk"
        ask_order = input("Also simulate creating a purchase order for this request? [y/N]: ").strip().lower() == "y"
        run_query_pipeline(query, create_test_order=ask_order)


if __name__ == "__main__":
    main()
