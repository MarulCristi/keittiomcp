"""Regression checks use temporary databases and synthetic catalog entries, never live orders."""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from valio_client import (
    CATALOG, Product, ProcurementError, ValioClient,
    _normalize_quantity_numbers, _normalize_query_terms,
)


class QuantityParsingTests(unittest.TestCase):
    def test_screenshot_request_is_one_line_of_four_thousand_litres(self):
        lines = ValioClient._parse_trade_lines_fallback("order 4,000 l skimmed-milk for tomorrow", ["nuts"])
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0].target_volume_liters_or_kg, 4000)
        self.assertEqual(lines[0].query, "skimmed-milk")
        self.assertEqual(lines[0].unit_hint, "L")
        self.assertEqual(lines[0].exclude_allergens, ["nuts"])

    def test_grouping_decimal_commas_and_item_separators(self):
        cases = [
            ("4,000 L milk, 1,5 kg tomatoes", [4000, 1.5], ["milk", "tomatoes"]),
            ("4,000.5 L milk and 2 kg tomatoes", [4000.5, 2], ["milk", "tomatoes"]),
            ("4.000,5 L milk; 2 kg tomatoes", [4000.5, 2], ["milk", "tomatoes"]),
            ("1,000 kg flour,2 L milk", [1000, 2], ["flour", "milk"]),
            ("4 L milk, 5 kg flour", [4, 5], ["milk", "flour"]),
            ("1,5 tonnes tomatoes", [1500], ["tomatoes"]),
        ]
        for prompt, quantities, names in cases:
            with self.subTest(prompt=prompt):
                lines = ValioClient._parse_trade_lines_fallback(prompt, [])
                self.assertEqual([line.target_volume_liters_or_kg for line in lines], quantities)
                self.assertEqual([line.query for line in lines], names)

    def test_dietary_exclusions_survive_number_normalization(self):
        lines = ValioClient._parse_trade_lines_fallback("4,000 L lactose-free milk, no nuts or gluten", [])
        self.assertEqual(len(lines), 1)
        self.assertEqual(set(lines[0].exclude_allergens), {"nuts", "gluten"})
        self.assertNotIn("milk", lines[0].exclude_allergens)
        self.assertEqual(lines[0].query, "lactose-free milk")

    def test_normalizes_numbers_without_changing_dates_or_skus(self):
        self.assertEqual(_normalize_quantity_numbers("0,125 kg / 1,000,000 g / AIMO-101 / 2026-11-16"),
                         "0.125 kg / 1000000 g / AIMO-101 / 2026-11-16")

    def test_malformed_grouping_reports_quantity_error(self):
        with self.assertRaises(ProcurementError) as caught:
            ValioClient._parse_trade_lines_fallback("4,00,0 L milk", [])
        self.assertEqual(caught.exception.status, 400)
        self.assertIn("Could not read quantity", str(caught.exception))

    def test_ai_receives_the_same_normalized_quantity(self):
        client = ValioClient(Path("unused.sqlite3"))
        with patch.dict("os.environ", {"GEMINI_API_KEY": "test-only"}), \
                patch("valio_client.httpx.post", return_value=SimpleNamespace(is_success=False)) as post:
            lines, _ = client._parse_trade_request_with_gemini("order 4,000 L skimmed-milk", [])
        prompt = post.call_args.kwargs["json"]["contents"][0]["parts"][0]["text"]
        self.assertIn("Chef Request: order 4000 L skimmed-milk", prompt)
        self.assertEqual(lines[0].target_volume_liters_or_kg, 4000)


class CatalogAndErrorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.client = ValioClient(Path(self.directory.name) / "test.sqlite3")
        self.client.initialize()

    def test_hyphenated_names_and_unicode_hyphens_match_without_changing_skus(self):
        product = Product(product_id="TEST-101", name="Skimmed milk", category="123", unit="1 L",
                          unit_price_cents=100, allergens=["milk"], dietary_claims=["lactose_free"])
        self.client.supplier = SimpleNamespace(transport=object(), catalog=lambda: (product,))
        for query in ["skimmed milk", "skimmed-milk", "skimmed\u2011milk", "lactose\u2011free skimmed-milk", "TEST-101"]:
            with self.subTest(query=query):
                self.assertEqual([p.product_id for p in self.client.search_products(query)], ["TEST-101"])
        self.assertEqual(_normalize_query_terms("AIMO-101"), ["AIMO-101"])

    def test_hyphenated_culinary_phrases_use_existing_synonyms(self):
        self.assertEqual(_normalize_query_terms("bell-peppers"), ["paprika"])

    def test_dietary_constraints_are_not_relaxed_by_hyphen_normalization(self):
        product = Product(product_id="TEST-101", name="Skimmed milk", category="123", unit="1 L", allergens=["milk"])
        self.client.supplier = SimpleNamespace(transport=object(), catalog=lambda: (product,))
        self.assertEqual(self.client.search_products("lactose\u2011free skimmed-milk"), [])

    def test_no_catalog_match_does_not_blame_allergens(self):
        with patch.object(self.client, "search_products", return_value=[]):
            with self.assertRaises(ProcurementError) as caught:
                self.client.plan_procurement("unknown-product", exclude_allergens=["nuts"])
        self.assertIn("No catalog products matched", str(caught.exception))
        self.assertNotIn("allergen rules", str(caught.exception))
        self.assertEqual(caught.exception.status, 404)

    def test_real_allergen_exclusion_names_the_blocking_rule(self):
        with patch.object(self.client, "search_products", return_value=[CATALOG["AIMO-101"]]):
            with self.assertRaises(ProcurementError) as caught:
                self.client.plan_procurement("milk", exclude_allergens=["milk", "nuts"])
        self.assertIn("all were excluded by your allergen rules (milk)", str(caught.exception))
        self.assertEqual(caught.exception.status, 404)

    def test_supplier_failure_is_not_relabelled_as_no_match(self):
        with patch.object(self.client, "search_products", side_effect=ProcurementError("Supplier lookup unavailable", 503)):
            with self.assertRaises(ProcurementError) as caught:
                self.client.plan_procurement("milk", exclude_allergens=["nuts"])
        self.assertEqual(str(caught.exception), "Supplier lookup unavailable")
        self.assertEqual(caught.exception.status, 503)

    def test_normal_quantity_and_pack_math_still_work(self):
        product = CATALOG["AIMO-101"].model_copy(update={"net_volume_liters_or_kg": 1.0, "stock": 5000})
        with patch.object(self.client, "search_products", return_value=[product]):
            plan = self.client.plan_procurement("milk", target_volume_liters_or_kg=4000, exclude_allergens=["nuts"])
        self.assertEqual(plan.options[0].recommended_packs, 4000)
        self.assertTrue(plan.options[0].can_fulfill_full_volume)

    def test_ingredient_text_allergen_is_detected_and_ignored(self):
        from valio_client import _parse_synkka_product, AgentExecutionRequest

        parsed = _parse_synkka_product(
            {
                "id": "SYN-BREAD-1",
                "category": "10100",
                "salesUnit": "PAK",
                "synkkaData": {
                    "names": [{"language": "en", "value": "Bakery Roll 1kg"}],
                    "ingredients": [{"names": [{"language": "en", "value": "wheat flour"}]}],
                    "classifications": [],
                },
            },
            {},
            {},
        )
        self.assertIsNotNone(parsed)
        roll, _ = parsed
        self.assertIn("gluten", roll.allergens or [])

        # Searching while gluten is in workspace guardrails must ignore the roll completely
        self.client.supplier = SimpleNamespace(
            transport=None,
            catalog=lambda: (roll,),
            product_by_id=lambda pid: roll if pid == roll.product_id else None,
            explicit_substitutes=lambda pid: [],
            check_batch_availability=lambda *a, **k: ({}, "2026-11-14T20:00:00Z"),
        )
        self.assertEqual(self.client.search_products("bakery roll"), [])

        # Autonomous trade request with 0 safe matches returns rejected=True with blocked product cards
        result = self.client.execute_trade_request(
            AgentExecutionRequest(prompt="10 packs of bakery roll", auto_place_order=True)
        )
        self.assertTrue(result.rejected)
        self.assertIsNone(result.order)
        self.assertIn("gluten", result.rejection_reason or "")
        self.assertEqual([p.product_id for p in result.rejected_products], ["SYN-BREAD-1"])

    def test_gluten_free_milk_selects_dairy_milk_never_chocolate(self):
        from valio_client import AgentExecutionRequest

        milk = Product(
            product_id="MILK-1",
            name="Valio skimmed milk 10 l",
            category="10400",
            unit="10 L",
            unit_price_cents=1200,
            net_volume_liters_or_kg=10.0,
            allergens=["milk"],
            dietary_claims=[],
            delivery_reliability=1.0,
        )
        chocolate = Product(
            product_id="CHOC-1",
            name="Panda milk chocolate praline 280g",
            category="52290",
            unit="280 g",
            unit_price_cents=590,
            net_volume_liters_or_kg=0.28,
            allergens=["milk"],
            dietary_claims=["gluten_free"],
            delivery_reliability=1.0,
        )
        self.client.supplier = SimpleNamespace(
            transport=None,
            data_dir=None,
            mode="junction",
            catalog=lambda: (chocolate, milk),
            product_by_id=lambda pid: {"MILK-1": milk, "CHOC-1": chocolate}.get(pid),
            explicit_substitutes=lambda pid: [],
            check_batch_availability=lambda *a, **k: ({}, "2026-11-14T20:00:00Z"),
        )
        result = self.client.execute_trade_request(
            AgentExecutionRequest(prompt="20 L of gluten-free milk", auto_place_order=False)
        )
        self.assertFalse(result.rejected)
        self.assertEqual(result.proposed_order_lines[0].product_id, "MILK-1")
        self.assertEqual(result.plans[0].options[0].product.product_id, "MILK-1")

    def test_strict_category_lock_never_jumps_categories(self):
        # When fish category exists in catalog with 0 vegan salmon, search must NEVER jump to another category
        real_salmon = Product(
            product_id="SALMON-1",
            name="Norwegian Salmon Fillet 2kg",
            category="18701",
            unit="2 kg",
            unit_price_cents=2500,
            net_volume_liters_or_kg=2.0,
            allergens=["fish"],
            dietary_claims=[],
        )
        chocolate = Product(
            product_id="CHOC-V",
            name="Vegan salmon-flavored snack 100g",
            category="52290",
            unit="100 g",
            unit_price_cents=290,
            net_volume_liters_or_kg=0.1,
            allergens=[],
            dietary_claims=["vegan"],
        )
        self.client.supplier = SimpleNamespace(
            transport=None,
            data_dir=None,
            mode="junction",
            catalog=lambda: (real_salmon, chocolate),
            product_by_id=lambda pid: {"SALMON-1": real_salmon, "CHOC-V": chocolate}.get(pid),
            explicit_substitutes=lambda pid: [],
            check_batch_availability=lambda *a, **k: ({}, "2026-11-14T20:00:00Z"),
        )
        self.assertEqual(self.client.search_products("vegan salmon"), [])

    def test_uniform_base_and_combined_priorities(self):
        from valio_client import _rank_substitutes_good_better_best

        # Processed/flavored variant should lose to pure ingredient even if cheaper or Finnish
        pure_non_fi = Product(
            product_id="MILK-PURE-EU",
            name="Skimmed milk 1L",
            category="10400",
            unit="1 L",
            unit_price_cents=180,
            comparison_price_cents=180,
            comparison_unit="L",
            country_of_origin="SE",
            purity_tier=0,
            carbon_footprint_kg=1.4,
            delivery_reliability=0.98,
            stock=50,
        )
        pure_fi_low_co2 = Product(
            product_id="MILK-FI-ECO",
            name="Valio skimmed milk 1L",
            category="10400",
            unit="1 L",
            unit_price_cents=155,
            comparison_price_cents=155,
            comparison_unit="L",
            country_of_origin="FI",
            purity_tier=0,
            carbon_footprint_kg=0.9,
            delivery_reliability=0.99,
            stock=50,
        )
        chocolate_milk_fi = Product(
            product_id="MILK-CHOC-FI",
            name="Chocolate milk drink 1L",
            category="10400",
            unit="1 L",
            unit_price_cents=90,
            comparison_price_cents=90,
            comparison_unit="L",
            country_of_origin="FI",
            purity_tier=2,
            carbon_footprint_kg=0.7,
            delivery_reliability=1.0,
            stock=50,
        )
        ranked_cheap = _rank_substitutes_good_better_best(
            pure_non_fi,
            [chocolate_milk_fi, pure_non_fi, pure_fi_low_co2],
            priority_mode="lowest_price",
        )
        # Uniform base puts pure ingredient matches ahead of processed chocolate milk even in lowest_price
        self.assertEqual(ranked_cheap[0].product_id, "MILK-FI-ECO")
        self.assertEqual(ranked_cheap[-1].product_id, "MILK-CHOC-FI")

        ranked_combined = _rank_substitutes_good_better_best(
            pure_non_fi,
            [pure_non_fi, pure_fi_low_co2],
            priority_modes=["authentic_finnish", "low_carbon"],
        )
        self.assertEqual(ranked_combined[0].product_id, "MILK-FI-ECO")
        self.assertIn("COMBINED PRIORITY", ranked_combined[0].substitute_reason or "")

    def test_schedule_creation_and_future_clock_execution(self):
        from valio_client import ClockAdvanceRequest, CreateScheduleRequest

        state = self.client.create_schedule(CreateScheduleRequest(prompt="Every day at 07:00 buy 20 L milk"))
        self.assertEqual(len(state.rules), 1)
        rule = state.rules[0]
        self.assertEqual(rule.cadence, "daily")
        self.assertEqual(rule.run_time, "07:00")
        self.assertIn("milk", rule.prompt.lower())

        adv = self.client.advance_clock(ClockAdvanceRequest(days=1))
        self.assertEqual(len(adv.executed_runs), 1)
        self.assertIsNotNone(adv.executed_runs[0].execution.order)
        self.assertEqual(adv.rules[0].runs_completed, 1)

        reset_state = self.client.advance_clock(ClockAdvanceRequest(reset=True))
        self.assertEqual(reset_state.offset_seconds, 0)


if __name__ == "__main__":
    unittest.main()
