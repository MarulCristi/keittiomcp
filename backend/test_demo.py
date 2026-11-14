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
from valio_client import (
    PRIORITY_MODE_LABELS, AgentExecutionRequest, Allergen, OrderLine, PriorityMode,
    ProcurementError, PurchaseOrderRequest, client,
)


def banner(title: str):
    print("\n" + "=" * 82)
    print(f"  {title}")
    print("=" * 82)


def parse_volume_from_input(user_text: str) -> float:
    """Extract target volume/weight (in L or kg) if the user typed a number like '500 L', '40 kg', or '1 ton'."""
    match = re.search(
        r"\b(\d+(?:[.,]\d+)?)\s*(tons?|tonnes?|t|litres?|liters?|l|kilograms?|kilos?|kg|grams?|g|ml|dl|units?|packs?)\b",
        user_text,
        re.IGNORECASE,
    )
    if match:
        val = float(match.group(1).replace(",", "."))
        unit = match.group(2).lower()
        if unit in ("ton", "tons", "tonne", "tonnes", "t"):
            return val * 1000.0
        if unit in ("g", "gram", "grams", "ml"):
            return max(0.1, val / 1000.0)
        if unit == "dl":
            return max(0.1, val / 10.0)
        return val
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


def run_query_pipeline(
    user_query: str, create_test_order: bool = False, priority_mode: PriorityMode | None = None
):
    target_vol = parse_volume_from_input(user_query)
    excluded = parse_excluded_allergens(user_query) or ["gluten", "nuts"]
    active_priority = client._resolve_priority_mode(priority_mode, user_query)

    banner(
        f"1. SMART LOCAL CATALOG SEARCH FOR: '{user_query}'\n"
        f"     Kitchen Priority: {PRIORITY_MODE_LABELS[active_priority]}"
    )
    results = client.search_products(user_query, priority_mode=active_priority)
    if not results:
        print(f"No products matched '{user_query}'. Try another ingredient name, brand, or SKU.")
        return

    print(f"Found {len(results)} matching products (showing top 5 with full metadata):")
    for idx, p in enumerate(results[:5], 1):
        rel_str = f"{p.delivery_reliability * 100:.1f}%" if p.delivery_reliability is not None else "N/A"
        co2_str = p.co2_range_label or (f"{p.carbon_footprint_kg:.2f} kg CO2/kg" if p.carbon_footprint_kg is not None else "N/A")
        print(
            f"  {idx}. SKU {p.product_id} — \"{p.name}\"\n"
            f"     Finnish Name   : {p.name_fi or 'N/A'} | Vendor: {p.vendor or 'N/A'} | Origin: {(p.country_of_origin or 'N/A').upper()}\n"
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
            f"  Category CO2 Range : {av.co2_range_label or 'N/A'}\n"
            f"  Logistic Model     : {av.logistic_model} | Order Cut-off: {av.closing_time}"
        )
    except ProcurementError as exc:
        print(f"  Live lookup error: {exc}")

    banner(
        f"3. GOOD-BETTER-BEST SUBSTITUTES IF OUT OF STOCK:\n"
        f"     Replacing SKU {top_product.product_id} — \"{top_product.name}\"\n"
        f"     (Priority: {PRIORITY_MODE_LABELS[active_priority]} | Excluding allergens: {excluded})"
    )
    subs = client.suggest_substitutes(
        top_product.product_id, exclude_allergens=excluded, enrich_live=True, priority_mode=active_priority
    )
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
            user_query,
            target_volume_liters_or_kg=target_vol,
            exclude_allergens=excluded,
            priority_mode=active_priority,
        )
        print(f"  Planner Summary: {plan.summary}\n")
        for opt in plan.options:
            print(f"  [{opt.tier.upper()}] {opt.headline}")
            print(f"    Product     : SKU {opt.product.product_id} — \"{opt.product.name}\" ({opt.product.unit})")
            print(f"    Fulfillment : {opt.tradeoff_explanation}")

        if create_test_order and plan.options:
            best_opt = plan.options[0]
            banner(
                f"5. GUARDRAIL EVALUATION & TRUST PROTOCOL RECEIPT FOR ORDERING {best_opt.recommended_packs} × "
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
            print(f"  Order ID           : {po.id}")
            for i in po.items:
                print(
                    f"  Line Item          : {i.quantity} × SKU {i.product_id} — \"{i.name}\" ({i.unit}) "
                    f"@ EUR {i.unit_price_cents / 100:.2f}/unit"
                )
            print(f"  Total Order Cost   : EUR {po.total_cents / 100:,.2f}")
            print(f"  Total Carbon       : {po.total_carbon_kg:,.2f} kg CO2e")
            print(f"  Guardrail Status   : {po.status.upper()}")
            print(f"  Review Reasons     : {po.reasons or ['None — within all autonomous guardrails!']}")
            if po.trust_verification:
                tv = po.trust_verification
                print(f"  Trust Protocol     : {tv.protocol} (Quote Lock ID: {tv.quote_lock_id})")
                print(f"  HMAC-SHA256 Sig    : {tv.signature_hmac_sha256}")
                print(f"  Gemma 4 Audit Model: {tv.privacy_audit_model}")
                print(f"  Gemma 4 Attestation: {tv.privacy_audit_summary}")
                print(f"  Order Cut-off      : {tv.earliest_closing_time}")
                print(f"  Redacted Fields    : {tv.redacted_confidential_fields}")
    except ProcurementError as exc:
        print(f"  Planner note: {exc}")


def run_agent_orchestrator_demo(
    user_prompt: str, test_permissions: bool = False, priority_mode: PriorityMode | None = None
):
    banner(f"AUTONOMOUS TRADE AGENT ORCHESTRATOR\n  Prompt: '{user_prompt}'")
    result = client.execute_trade_request(
        AgentExecutionRequest(
            prompt=user_prompt,
            agent_id="kitchen",
            priority_mode=priority_mode,
            auto_place_order=True,
            simulate_shortage_on_primary=test_permissions,
        )
    )
    print(f"  Orchestrator Model : {result.orchestrator_model}")
    print(f"  Kitchen Priority   : {PRIORITY_MODE_LABELS[result.priority_mode]}")
    print(f"  Acting Agent       : {result.agent.name} (id='{result.agent.id}', limit=EUR {result.agent.spending_limit_cents / 100:,.2f})")
    print(f"  Delivery Date      : {result.requested_date.isoformat()}")
    print("\n  Explainable Decision Audit Trail (4-Stage Trace):")
    for step_idx, trace_line in enumerate(result.decision_trace, 1):
        print(f"    {step_idx}. {trace_line}")

    if result.order:
        po = result.order
        banner(f"RECORDED ORDER, GUARDRAILS & STEP 3 TRUST PROTOCOL RECEIPT: {po.id}")
        print(f"  Order ID           : {po.id} (Placed by: {po.agent_name})")
        for item in po.items:
            sub_tag = f" [SUBSTITUTE FOR {item.substituted_for}]" if item.is_substitution else ""
            print(
                f"  Line Item          : {item.quantity} × SKU {item.product_id} — \"{item.name}\" ({item.unit}) "
                f"@ EUR {item.unit_price_cents / 100:.2f}/unit{sub_tag}"
            )
        print(f"  Total Order Cost   : EUR {po.total_cents / 100:,.2f}")
        print(f"  Total Carbon       : {po.total_carbon_kg or 0.0:,.2f} kg CO2e")
        print(f"  Guardrail Status   : {po.status.upper()}")
        print(f"  Review Reasons     : {po.reasons or ['None — auto-approved within all guardrails!']}")
        if po.trust_verification:
            tv = po.trust_verification
            print("\n  --- STEP 3: VERIFIABLE TRUST PROTOCOL & GEMMA 4 PRIVACY RECEIPT ---")
            print(f"  Trust Protocol     : {tv.protocol}")
            print(f"  Quote Lock ID      : {tv.quote_lock_id}")
            print(f"  HMAC-SHA256 Sig    : {tv.signature_hmac_sha256}")
            print(f"  Order Cut-off Time : {tv.earliest_closing_time}")
            print(f"  Privacy Audit Model: {tv.privacy_audit_model}")
            print(f"  Privacy Attestation: {tv.privacy_audit_summary}")
            print(f"  Redacted Fields    : {tv.redacted_confidential_fields}")

    if test_permissions:
        banner("TESTING PER-AGENT PERMISSIONS & BLOCKED ACTION AUDIT LOG (inventory agent)")
        agents = client.list_agents()
        for ag in agents:
            print(
                f"  • Agent '{ag.name}' (id='{ag.id}'): status={ag.status}, "
                f"permissions={ag.permissions}, limit=EUR {ag.spending_limit_cents / 100:,.2f}"
            )
        print("\n  Attempting purchase using 'inventory' agent (which only has ['search', 'prepare'] permissions)...")
        try:
            client.execute_trade_request(
                AgentExecutionRequest(
                    prompt=user_prompt,
                    agent_id="inventory",
                    priority_mode=priority_mode,
                    auto_place_order=True,
                )
            )
        except ProcurementError as exc:
            print(f"  [EXPECTED BLOCK] HTTP {exc.status}: {exc}")

        banner("RECENT SERVER AUDIT EVENTS (GET /api/events)")
        for ev in client.list_events()[:5]:
            print(f"  • [{ev.result.upper()}] {ev.timestamp} | {ev.agent_name} -> {ev.action}: {ev.detail}")


PRIORITY_CHOICES: dict[str, PriorityMode] = {
    "1": "balanced",
    "2": "low_carbon",
    "3": "lowest_price",
    "4": "authentic_finnish",
    "5": "highest_reliability",
    "balanced": "balanced",
    "low_carbon": "low_carbon",
    "carbon": "low_carbon",
    "lowest_price": "lowest_price",
    "cheap": "lowest_price",
    "price": "lowest_price",
    "authentic_finnish": "authentic_finnish",
    "finnish": "authentic_finnish",
    "highest_reliability": "highest_reliability",
    "reliability": "highest_reliability",
}


def ask_kitchen_priority() -> PriorityMode:
    print("\n" + "=" * 82)
    print("  STEP 0 · SELECT YOUR KITCHEN PURCHASING PRIORITY (Valio Aimo Booth Mode)")
    print("=" * 82)
    print("  What should the autonomous trade agent prioritize for your kitchen today?")
    print("    [1] Balanced (Best Overall: Reliability + Carbon + Price) [Default]")
    print("    [2] Lowest Carbon Footprint (Sustainability First)")
    print("    [3] Lowest Price / Cheapness (Budget First)")
    print("    [4] Authentic Finnish Origin (Kotimainen / Blue Swan / Key Flag First)")
    print("    [5] Highest Delivery Reliability (100% On-Time First)")
    try:
        choice = input("\n  Choose priority [1-5, press Enter for 1]: ").strip().lower()
    except EOFError:
        choice = "1"
    selected = PRIORITY_CHOICES.get(choice, "balanced")
    # Save selected priority into active workspace guardrails so all tools use it automatically
    ws = client.workspace()
    client.update_guardrails(ws.guardrails.model_copy(update={"priority_mode": selected}))
    print(f"  -> Active Kitchen Priority set to: {PRIORITY_MODE_LABELS[selected]}")
    return selected


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
        f"Min Reliability = {ws.guardrails.min_delivery_reliability * 100:.0f}% | "
        f"Priority = {PRIORITY_MODE_LABELS[ws.guardrails.priority_mode]}"
    )

    # If the user passed a query on the command line, run it once and exit
    if len(sys.argv) > 1:
        args = list(sys.argv[1:])
        explicit_priority: PriorityMode | None = None
        if "--priority" in args:
            p_idx = args.index("--priority")
            if p_idx + 1 < len(args):
                explicit_priority = PRIORITY_CHOICES.get(args[p_idx + 1].lower(), "balanced")
                del args[p_idx : p_idx + 2]
            else:
                del args[p_idx]

        if "--agent" in args:
            test_perms = "--test-permissions" in args
            clean_args = [a for a in args if a not in ("--agent", "--test-permissions")]
            prompt_str = " ".join(clean_args).strip() or "30 L of lactose-free milk for Monday"
            run_agent_orchestrator_demo(
                prompt_str, test_permissions=test_perms, priority_mode=explicit_priority
            )
            return
        user_query = " ".join(args).strip()
        run_query_pipeline(user_query, create_test_order=False, priority_mode=explicit_priority)
        return

    # Interactive mode: Ask the kitchen what they want to prioritize right at the beginning!
    selected_priority = ask_kitchen_priority()
    print("\n" + "-" * 82)
    print("INTERACTIVE MODE: Type any food request, ingredient, or SKU to test the engine!")
    print("Examples you can type:")
    print("  • 1000 litres of lactose-free milk")
    print("  • 50 kg salmon")
    print("  • 15 kg tomatoes")
    print("  • 20 packs of toilet paper")
    print("  • 40 kg potato salad")
    print("Type 'p' to change Kitchen Priority, 'q' to quit, or press Enter for '1000 litres of lactose-free milk'.")
    print("-" * 82)

    while True:
        try:
            raw_input_str = input("\nEnter your kitchen request ('p' to change priority, 'q' to quit): ").strip()
        except EOFError:
            run_query_pipeline("1000 litres of lactose-free milk", create_test_order=False, priority_mode=selected_priority)
            break

        if raw_input_str.lower() in ("q", "quit", "exit"):
            print("Exiting interactive test.")
            break
        if raw_input_str.lower() in ("p", "priority"):
            selected_priority = ask_kitchen_priority()
            continue

        query = raw_input_str or "1000 litres of lactose-free milk"
        ask_order = input("Also simulate creating a purchase order for this request? [y/N]: ").strip().lower() == "y"
        run_query_pipeline(query, create_test_order=ask_order, priority_mode=selected_priority)


if __name__ == "__main__":
    main()
