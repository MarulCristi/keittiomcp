"""Step-by-step console test script to see KeittioMCP's backend engine in action."""

import time
from valio_client import OrderLine, PurchaseOrderRequest, client


def banner(title: str):
    print("\n" + "=" * 78)
    print(f"  {title}")
    print("=" * 78)


def main():
    banner("STEP 1: INITIALIZE WORKSPACE & LOAD STATIC DATASETS (GS1 Synkka + CSVs)")
    t0 = time.time()
    client.initialize()
    ws = client.workspace()
    print(f"Supplier Mode      : {ws.supplier_mode.upper()}")
    print(f"Guardrail Limit    : EUR {ws.guardrails.max_auto_approve_cents / 100:,.2f}")
    print(f"Review Allergens   : {ws.guardrails.review_allergens}")
    print(f"Min Reliability    : {ws.guardrails.min_delivery_reliability * 100:.0f}%")

    if client.supplier:
        catalog = client.supplier.catalog()
        with_rel = sum(1 for p in catalog if p.delivery_reliability is not None)
        with_co2 = sum(1 for p in catalog if p.carbon_footprint_kg is not None)
        print(f"Loaded Catalog     : {len(catalog):,} products in {time.time() - t0:.2f}s")
        print(f"With Reliability % : {with_rel:,} products (from delivery_reliability.csv)")
        print(f"With Carbon CO2e   : {with_co2:,} products (from carbon_footprint.csv)")

    banner("STEP 2: LOCAL SMART SEARCH ('lactose-free milk')")
    results = client.search_products("lactose-free milk")
    print(f"Found {len(results)} matching products (showing top 5):")
    for idx, p in enumerate(results[:5], 1):
        rel_str = f"{p.delivery_reliability * 100:.1f}%" if p.delivery_reliability is not None else "N/A"
        co2_str = f"{p.carbon_footprint_kg:.2f} kg CO2/kg" if p.carbon_footprint_kg is not None else "N/A"
        print(
            f"  {idx}. [{p.product_id}] {p.name}\n"
            f"     Unit: {p.unit} | Reliability: {rel_str} | Carbon: {co2_str}\n"
            f"     Dietary Claims: {p.dietary_claims} | Allergens: {p.allergens}\n"
            f"     Labels: {p.sustainability_labels}"
        )

    banner("STEP 3: LIVE VALIO AIMO AVAILABILITY & PRICE LOOKUP")
    for test_id in ("460000", "460013", "464119"):
        av = client.check_availability(test_id, quantity=10)
        price_str = f"EUR {av.unit_price_cents / 100:.2f}" if av.unit_price_cents else "N/A"
        comp_str = (
            f"EUR {av.comparison_price_cents / 100:.2f}/{av.comparison_unit}"
            if av.comparison_price_cents and av.comparison_unit
            else "N/A"
        )
        stock_str = "UNLIMITED (Terminal >= 999999)" if av.available_quantity is None and av.available else str(av.available_quantity)
        print(
            f"  SKU {av.product_id} ({av.name}):\n"
            f"    Available for 10 units? : {av.available} (Stock: {stock_str} {av.sales_unit or ''})\n"
            f"    Unit Price (incl. tax)  : {price_str} | Comparison Price: {comp_str}\n"
            f"    Logistic Model          : {av.logistic_model} | Order Cut-off: {av.closing_time}"
        )

    banner("STEP 4: GOOD-BETTER-BEST SUBSTITUTION ENGINE (FOR SKU 463038)")
    subs = client.suggest_substitutes("463038", exclude_allergens=["gluten", "nuts"], enrich_live=True)
    print(f"Top 3 Ranked Substitutes for 463038 (excluding gluten & nuts, keeping lactose_free):")
    for s in subs[:3]:
        price_str = f"EUR {s.unit_price_cents / 100:.2f}" if s.unit_price_cents else "N/A"
        print(
            f"  [{(s.substitute_tier or 'option').upper()}] SKU {s.product_id}: {s.name} ({s.unit})\n"
            f"    Live Unit Price : {price_str} | Stock: {s.stock if s.stock is not None else 'Terminal (Unlimited)'}\n"
            f"    Why Ranked Here : {s.substitute_reason}"
        )

    banner("STEP 5: WHOLESALE VOLUME PLANNER ('1,000 litres of lactose-free milk by Monday')")
    plan = client.plan_procurement("1000 litres of lactose-free milk", target_volume_liters_or_kg=1000.0)
    print(f"Summary: {plan.summary}\n")
    for opt in plan.options:
        print(f"  [{opt.tier.upper()}] {opt.headline}")
        print(f"    Product     : [{opt.product.product_id}] {opt.product.name}")
        print(f"    Fulfillment : {opt.tradeoff_explanation}")

    banner("STEP 6: CREATE LIVE PURCHASE ORDER & EVALUATE GUARDRAILS")
    order_req = PurchaseOrderRequest(
        items=[
            OrderLine(
                product_id=plan.options[0].product.product_id,
                quantity=plan.options[0].recommended_packs,
            )
        ]
    )
    po = client.create_purchase_order(order_req)
    print(f"Created Order ID   : {po.id}")
    print(f"Items              : {[(i.product_id, i.name, i.quantity, i.unit) for i in po.items]}")
    print(f"Total Cost         : EUR {po.total_cents / 100:,.2f}")
    print(f"Total Carbon       : {po.total_carbon_kg:,.2f} kg CO2e")
    print(f"Guardrail Status   : {po.status.upper()}")
    print(f"Flagged Reasons    : {po.reasons}")
    if po.trust_verification:
        print(f"Trust Protocol     : {po.trust_verification.protocol}")
        print(f"Valio Server Time  : {po.trust_verification.valio_server_time}")
        print(f"Order Cutoff Time  : {po.trust_verification.earliest_closing_time}")
        print(f"Redacted Fields    : {po.trust_verification.redacted_confidential_fields}")


if __name__ == "__main__":
    main()
