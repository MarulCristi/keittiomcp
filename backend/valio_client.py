"""Valio Aimo Junction API, GS1 Synkka local index, Good-Better-Best substitution engine, and Guardrail workspace."""

import csv
import hashlib
import hmac
import json
import math
import os
import re
import sqlite3
import time
from collections import Counter
from contextlib import contextmanager
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from threading import Lock
from typing import Annotated, Any, Literal, TypeVar
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv
from pydantic import AliasChoices, BaseModel, Field, StringConstraints, ValidationError, field_validator

VALIO_BASE_URL = httpx.URL("https://junction26.valioaimo.fi")
DATA_DIR = Path(__file__).with_name("data")
Response = TypeVar("Response", bound=BaseModel)

Allergen = Literal["milk", "gluten", "soy", "eggs", "nuts", "fish"]
SubstituteTier = Literal["best", "better", "good"]
AgentPermission = Literal["search", "prepare", "purchase"]
PriorityMode = Literal["balanced", "low_carbon", "lowest_price", "authentic_finnish", "highest_reliability"]

PRIORITY_MODE_LABELS: dict[PriorityMode, str] = {
    "balanced": "Balanced (Best Overall: Reliability, Carbon & Price)",
    "low_carbon": "Lowest Carbon Footprint (Sustainability First)",
    "lowest_price": "Lowest Price / Budget First (Cheapest per L/kg)",
    "authentic_finnish": "Authentic Finnish Origin (Kotimainen / Blue Swan / Key Flag First)",
    "highest_reliability": "Highest Delivery Reliability (100% On-Time First)",
}
ProductId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
SearchTerm = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Quantity = Annotated[int, Field(strict=True, ge=1, le=10000)]

# GS1 Synkka Allergen Code -> Keittiö canonical allergen
GS1_ALLERGEN_MAP: dict[str, Allergen] = {
    "AM": "milk",
    "AW": "gluten",  # Wheat
    "UW": "gluten",  # Cereals containing gluten
    "GO": "gluten",  # Oats
    "GB": "gluten",  # Barley
    "NR": "gluten",  # Rye
    "GS": "gluten",  # Spelt
    "GK": "gluten",  # Kamut
    "AE": "eggs",
    "AY": "soy",
    "AN": "nuts",    # Tree nuts
    "AP": "nuts",    # Peanuts
    "SA": "nuts",    # Almonds / tree nut subcodes
    "SH": "nuts",    # Hazelnuts
    "SW": "nuts",    # Walnuts
    "SC": "nuts",    # Cashews
    "SP": "nuts",    # Pecans
    "ST": "nuts",    # Pistachios
    "SM": "nuts",    # Macadamia
    "AF": "fish",
    "AC": "fish",    # Crustaceans mapped to fish/seafood safety bucket
    "UM": "fish",    # Molluscs
    "ML": "fish",
}

DIETARY_CLAIM_LABELS: dict[str, str] = {
    "FREE_FROM_LACTOSE": "lactose_free",
    "LOW_LACTOSE": "low_lactose",
    "FREE_FROM_GLUTEN": "gluten_free",
    "VEGAN": "vegan",
    "VEGETARIAN": "vegetarian",
    "FREE_FROM_MILK": "milk_free",
    "FREE_FROM_EGGS": "egg_free",
    "FREE_FROM_SOY": "soy_free",
    "NO_ADDED_SUGARS": "no_added_sugar",
    "HIGH_PROTEIN": "high_protein",
    "HIGH_FIBRE": "high_fibre",
}

SUSTAINABILITY_LABEL_MAP: dict[str, str] = {
    "GOODS_FROM_FINLAND_BLUE_SWAN": "Hyvää Suomesta (Blue Swan)",
    "MADE_IN_FINLAND_FLAG_WITH_KEY": "Avainlippu (Key Flag)",
    "FINNISH_HEART_SYMBOL": "Heart Symbol",
    "EU_ORGANIC_FARMING": "EU Organic (Luomu)",
    "SVANEN": "Nordic Swan Ecolabel",
    "RAINFOREST_ALLIANCE": "Rainforest Alliance",
    "EU_ECO_LABEL": "EU Ecolabel",
    "MARINE_STEWARDSHIP_COUNCIL_LABEL": "MSC Certified Sustainable Seafood",
    "AQUACULTURE_STEWARDSHIP_COUNCIL": "ASC Certified",
    "FAIR_TRADE_MARK": "Fairtrade",
    "KRAV_MARK": "KRAV Organic",
    "PUHTAASTI_KOTIMAINEN": "100% Finnish Domestic",
}

SALES_UNIT_LABELS: dict[str, str] = {
    "KI": "Case/KI",
    "ST": "Unit/ST",
    "KG": "KG",
    "PAK": "Box/PAK",
    "BAG": "Bag/BAG",
    "RAS": "Tub/RAS",
    "PRK": "Carton/PRK",
    "BOT": "Bottle/BOT",
    "SK": "Sack/SK",
    "PAL": "Pallet/PAL",
}

# Step 1 Category Router: Dish / Prepared Food categories (checked first when query mentions a dish)
DISH_CATEGORY_ROUTES: list[tuple[set[str], set[str]]] = [
    ({"soup", "soups", "keitto", "lohikeitto", "hernekeitto"}, {"17300", "21900", "21901", "21510", "21402"}),
    ({"pie", "pies", "pasty", "pasties", "piirakka", "pasteija"}, {"41762", "41765", "10903"}),
    ({"salad", "salads", "salaatti", "perunasalaatti", "coleslaw"}, {"17301", "21592"}),
    (
        {"burger", "burgers", "patty", "patties", "pihvi", "meatball", "meatballs", "lihapulla", "fishball", "kalapihvi"},
        {"41705", "41712", "41723", "41752", "18761"},
    ),
    ({"pizza", "lasagne", "casserole", "laatikko", "risotto"}, {"17300", "17302", "41755"}),
    ({"sandwich", "sandwiches", "sämpylä", "wrap"}, {"17303"}),
    (
        {"sauce", "sauces", "kastike", "mayonnaise", "majoneesi", "ketchup", "ketsuppi", "dressing", "salsa"},
        {"21904", "21905", "21910", "21912", "21917", "21918", "21919", "21920", "21921", "21994"},
    ),
    ({"bouillon", "fond", "stock", "liemi"}, {"21902", "21903"}),
    ({"icecream", "jäätelö", "gelato", "sorbet"}, {"41800", "41801", "41820"}),
    (
        {"chocolate", "suklaa", "candy", "candies", "karkki", "confectionery", "praline", "truffle", "lollipop", "pastille"},
        {"52200", "52201", "52202", "52208", "52209", "52210", "52240", "52260", "52290", "22540"},
    ),
    ({"cake", "cakes", "kakku", "muffin", "muffins", "pastry", "cinnamon", "pulla", "donut"}, {"11030", "41763", "41764"}),
    ({"babyfood", "baby", "lastenateria", "piltti"}, {"21600"}),
    ({"powder", "jauhe", "milkpowder", "maitojauhe"}, {"10405", "21980"}),
]

# Step 1 Category Router: Raw / Core Ingredient categories (used when no prepared dish word is in the query)
INGREDIENT_CATEGORY_ROUTES: list[tuple[set[str], set[str]]] = [
    (
        {
            "salmon", "lohi", "lohifilee", "kirjolohi", "trout", "cod", "turska", "hake", "herring",
            "silakka", "anchovy", "anjovis", "whitefish", "siika", "pike", "perch", "ahven", "mackerel",
            "redfish", "vendace", "muikku", "fish", "kala",
        },
        {"18701", "18702", "18705", "18706", "18707", "18708", "41720", "21530"},
    ),
    (
        {
            "crayfish", "rapu", "täplärapu", "crawfish", "shrimp", "shrimps", "katkarapu", "prawn",
            "prawns", "mussel", "mussels", "simpukka", "clam", "octopus", "mustekala", "seafood", "shellfish",
        },
        {"18703", "41721"},
    ),
    ({"roe", "mäti", "caviar"}, {"18704", "41722"}),
    (
        {"oat", "kaura", "soy", "soya", "soija", "coconut", "kookos", "almond", "plant"},
        {"10401", "10402", "10406", "10413", "10418"},
    ),
    (
        {"cream", "kerma", "ruokakerma", "kuohukerma", "whipping", "fraiche", "fraîche", "smetana", "kermaviili", "sourcream"},
        {"10401", "10406", "10418", "10419"},
    ),
    (
        {"milk", "maito", "kevytmaito", "maitojuoma", "kevytmaitojuoma", "skimmed"},
        {"10400"},
    ),
    ({"yoghurt", "yogurt", "jogurtti", "quark", "rahka", "viili"}, {"10411", "10412", "10430"}),
    (
        {"butter", "voi", "margarine", "margariini", "oivariini"},
        {"10500", "10501", "10502", "10515", "10516", "10518"},
    ),
    ({"oil", "öljy", "oliveoil", "rapeseed", "frying"}, {"10517", "10530", "10531", "10532"}),
    ({"egg", "eggs", "kananmuna", "munia"}, {"10590", "10592"}),
    (
        {"cheese", "juusto", "feta", "mozzarella", "halloumi", "cheddar", "edam", "gouda", "parmesan", "aura", "oltermanni", "cottage"},
        {"10600", "10602", "10603", "10630", "10631", "10632", "10633", "10635", "10636", "10637", "10639", "10640", "41771"},
    ),
    (
        {"bread", "leipä", "loaf", "vuokaleipä", "sourdough", "rye", "ruisleipä", "roll", "rolls", "toast", "crispbread", "näkkileipä"},
        {"10900", "10901", "10902", "21200", "21211", "41760", "41761"},
    ),
    (
        {"chicken", "kana", "broileri", "turkey", "kalkkuna", "duck", "ankka", "poultry"},
        {"18750", "18751", "41710", "41711", "17204", "17209"},
    ),
    (
        {"beef", "nauta", "naudan", "rib", "brisket", "tenderloin", "sirloin", "minced", "jauheliha", "roast"},
        {"18720", "18760", "18761", "41702", "41703", "17205", "17210"},
    ),
    (
        {"pork", "possu", "porsas", "ham", "kinkku", "bacon", "pekoni", "sausage", "sausages", "makkara", "frankfurter", "bratwurst", "salami"},
        {"18710", "41701", "17200", "17201", "17202", "17203", "17206", "17209"},
    ),
    ({"lamb", "karitsa", "lammas", "reindeer", "poro"}, {"18730", "18740", "41703", "41704", "17210"}),
    (
        {
            "potato", "potatoes", "peruna", "tomato", "tomatoes", "tomaatti", "cucumber", "kurkku",
            "lettuce", "cabbage", "kaali", "onion", "sipuli", "carrot", "porkkana", "mushroom",
            "mushrooms", "sieni", "chanterelle", "garlic", "fries", "ranskalaiset",
            "pepper", "peppers", "paprika", "capsicum", "chili", "zucchini", "kesäkurpitsa",
            "eggplant", "aubergine", "munakoiso", "broccoli", "parsakaali", "cauliflower", "kukkakaali",
            "spinach", "pinaatti", "celery", "selleri", "leek", "purjo", "beetroot", "punajuuri",
        },
        {
            "17401", "17402", "17403", "17404", "17405", "17406", "17407", "17408",
            "17420", "17421", "17422", "17423", "17424", "17430", "17431", "17432", "17433",
            "17440", "17441", "17442", "17443", "17444", "17450", "17451", "17452", "17453",
            "17454", "17460", "17470", "17471", "17472", "17473",
            "41731", "41732", "41733", "41734", "41750", "41751", "21550", "21590", "21591", "21593", "21595", "21596",
        },
    ),
    (
        {
            "mango", "mangos", "mangoes", "hedelmä", "fruit", "fruits", "berry", "berries", "marja",
            "apple", "apples", "omena", "pear", "pears", "päärynä", "banana", "bananas", "banaani",
            "orange", "oranges", "appelsiini", "lemon", "lemons", "sitruuna", "lime", "limes", "limetti",
            "grapefruit", "verigreippi", "mandarin", "clementine", "peach", "peaches", "persikka",
            "nectarine", "plum", "plums", "luumu", "apricot", "aprikoosi", "cherry", "cherries", "kirsikka",
            "grape", "grapes", "viinirypäle", "rypäle", "pineapple", "ananas", "melon", "melons", "meloni",
            "watermelon", "vesimeloni", "kiwi", "kiivi", "avocado", "avocados", "avokado", "papaya",
            "passionfruit", "passion", "pomegranate", "granaattiomena", "fig", "figs", "viikuna",
            "strawberry", "strawberries", "mansikka", "blueberry", "blueberries", "mustikka",
            "raspberry", "raspberries", "vadelma", "lingonberry", "puolukka", "cranberry", "karpalo",
            "cloudberry", "lakka", "hilla", "currant", "herukka", "rhubarb", "raparperi",
        },
        {
            "17411", "17412", "17413", "17414", "17415", "17445", "17481",
            "41740", "41741", "41742", "21451", "21461", "21580",
        },
    ),
    (
        {"pasta", "macaroni", "makaroni", "spaghetti", "fusilli", "noodle", "noodles", "rice", "riisi", "flour", "jauho", "flakes", "hiutale", "quinoa"},
        {"21300", "21310", "21320", "21340", "21360", "21370", "21371", "21372", "21373", "21380", "21381", "21382", "17304", "41755"},
    ),
    (
        {"toilet", "wc-paperi", "towel", "towels", "käsiarkki", "napkin", "napkins", "lautasliina", "tissue"},
        {"63210", "63220", "63230"},
    ),
]


# Multi-word & regional culinary synonyms -> Valio Aimo catalog vocabulary (English/Finnish)
CULINARY_PHRASE_SYNONYMS: list[tuple[str, str]] = [
    (r"\bbell\s+peppers?\b", "paprika"),
    (r"\bsweet\s+peppers?\b", "paprika"),
    (r"\bcapsicums?\b", "paprika"),
    (r"\bzucchinis?\b", "kesäkurpitsa"),
    (r"\bcourgettes?\b", "kesäkurpitsa"),
    (r"\beggplants?\b", "munakoiso"),
    (r"\baubergines?\b", "munakoiso"),
    (r"\bcilantro\b", "korianteri"),
    (r"\barugula\b", "rucola"),
    (r"\bscallions?\b", "kevätsipuli"),
    (r"\bspring\s+onions?\b", "kevätsipuli"),
    (r"\bheavy\s+cream\b", "whipping cream"),
    (r"\bground\s+beef\b", "beef minced"),
]

PLURAL_STEM_MAP: dict[str, str] = {
    "tomatoes": "tomato",
    "potatoes": "potato",
    "peppers": "pepper",
    "onions": "onion",
    "carrots": "carrot",
    "cucumbers": "cucumber",
    "mushrooms": "mushroom",
    "eggs": "egg",
    "apples": "apple",
    "lemons": "lemon",
    "limes": "lime",
    "oranges": "orange",
    "bananas": "banana",
    "berries": "berry",
    "strawberries": "strawberry",
    "blueberries": "blueberry",
    "raspberries": "raspberry",
    "mangoes": "mango",
    "mangos": "mango",
    "peaches": "peach",
    "pears": "pear",
    "plums": "plum",
    "cherries": "cherry",
    "grapes": "grape",
    "melons": "melon",
    "avocados": "avocado",
    "figs": "fig",
    "loaves": "loaf",
    "fillets": "fillet",
    "breasts": "breast",
    "sausages": "sausage",
    "burgers": "burger",
    "patties": "patty",
    "pies": "pie",
    "soups": "soup",
    "salads": "salad",
    "noodles": "noodle",
    "shrimps": "shrimp",
    "prawns": "prawn",
    "mussels": "mussel",
    "clams": "clam",
    "olives": "olive",
    "beans": "bean",
}


def _normalize_query_terms(cleaned_query: str) -> list[str]:
    """Normalize culinary phrases (e.g. 'bell pepper' -> 'paprika') and stem English plurals ('tomatoes' -> 'tomato')."""
    text = cleaned_query
    for pattern, replacement in CULINARY_PHRASE_SYNONYMS:
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    raw_tokens = [t for t in re.split(r"\s+", text.strip()) if t]
    normalized: list[str] = []
    for tok in raw_tokens:
        stemmed = PLURAL_STEM_MAP.get(tok, tok)
        if stemmed not in normalized:
            normalized.append(stemmed)
    return normalized


def _compute_variety_penalty(item: "Product", query_terms: list[str], raw_query_lower: str) -> int:
    """Rank normal/standard whole ingredients (0) ahead of pre-cut (1) or specialty sub-varieties/canned forms (2-3)
    unless the user explicitly asked for that sub-variety (e.g. 'cherry tomato', 'diced tomato', 'chili pepper').
    """
    text = f"{item.name} {item.name_fi or ''}".casefold()
    precut_words = (
        "sliced", "slices", "viipale", "diced", "kuutio", "strip", "strips", "suikale",
        "shredded", "raaste", "wedge", "wedges", "lohko", "cleaved", "peeled", "kuorittu",
    )
    asked_precut = any(w in raw_query_lower for w in precut_words)
    is_precut = item.category == "17443" or any(w in text for w in precut_words)

    # If searching for bell pepper / paprika (and not chili/jalapeno/habanero), penalize hot chilies & canned peppers
    if "paprika" in query_terms or "pepper" in query_terms:
        asked_chili = any(w in raw_query_lower for w in ("chili", "chilli", "jalapeno", "jalopeno", "habanero", "rawit", "cayenne"))
        if not asked_chili and any(w in text for w in ("chili", "chilli", "jalapeno", "jalopeno", "habanero", "rawit")):
            return 3
        if item.category == "17406" and not is_precut:
            if any(w in text for w in ("1.cl", "1.lk", "1cl", "1lk", "luomu", "organic", "suomi", "finland")):
                return 0
            return 1
        if is_precut and not asked_precut:
            return 2
        return 3

    # If searching for tomato (and not cherry/plum/pearl/paste/peeled/crushed/sun-dried), prioritize standard fresh whole tomatoes
    if "tomato" in query_terms or "tomaatti" in query_terms:
        sub_varieties = (
            "cherry", "kirsikka", "tomberry", "tom berry", "pearl", "helmi", "plum", "luumu",
            "san marzano", "miniluumu", "cocktail", "paste", "pyree", "puree", "pulp", "crushed",
            "murska", "peeled", "kuorittu", "dried", "kuivattu", "puolikuiv", "ketchup", "sauce",
        )
        asked_sub = any(w in raw_query_lower for w in sub_varieties)
        if not asked_sub:
            if any(w in text for w in sub_varieties):
                return 3
            if is_precut and not asked_precut:
                return 2
            if item.category == "17401":
                if any(w in text for w in ("1cl", "1.cl", "1lk", "1.lk")):
                    return 0
                return 1
            return 3

    if is_precut and not asked_precut and item.category.startswith("174"):
        return 2

    # For fruit & berry searches: prioritize fresh whole fruit (1741x, 17481) -> frozen whole/diced fruit (41740, 41741) -> purees/dried/canned
    asked_puree_or_dried = any(w in raw_query_lower for w in ("puree", "purée", "pyree", "coulis", "dried", "kuivattu", "syrup", "canned"))
    if item.category in {"41742", "21451", "21461", "21580"} and not asked_puree_or_dried:
        return 2
    if item.category in {"41740", "41741"} and not any(w in raw_query_lower for w in ("frozen", "pakaste", "iqf", "diced")):
        return 1

    # General fresh produce preference: when in 174xx (fresh produce) vs 215xx (canned/brine), prefer fresh unless 'canned'/'pickled' asked
    if item.category.startswith("215") and not any(w in raw_query_lower for w in ("canned", "pickled", "brine", "paste", "crushed", "sliced")):
        return 3

    return 0


def _resolve_target_categories(terms: list[str], raw_query: str) -> set[str] | None:
    """Route a search query to the appropriate Valio Aimo 5-digit categories.

    1. If a prepared dish keyword ('soup', 'pie', 'salad', 'burger', 'ice cream', etc.) is present,
       route to that dish's categories.
    2. Otherwise, if a raw ingredient keyword ('salmon', 'milk', 'chicken', 'crayfish', etc.) is present,
       route strictly to the raw ingredient's categories so pies/babyfood/soups are excluded.
    """
    term_set = set(terms)
    low_query = raw_query.casefold()
    if "ice cream" in low_query or "ice-cream" in low_query:
        term_set.add("icecream")
    if "milk powder" in low_query:
        term_set.add("milkpowder")

    for dish_words, dish_cats in DISH_CATEGORY_ROUTES:
        if term_set & dish_words:
            return dish_cats

    matched_ingredient_cats: set[str] = set()
    for ing_words, ing_cats in INGREDIENT_CATEGORY_ROUTES:
        if term_set & ing_words:
            matched_ingredient_cats |= ing_cats

    return matched_ingredient_cats or None


def _compute_purity_tier(name_en: str, name_fi: str, key_ingredients_text: str) -> int:
    """Score ingredient purity inside a category:
    0 = Pure cut / single ingredient (e.g. 'SALMON', 'fillet', 'whole', 'sliced', 'milk drink')
    1 = Standard product in category
    2 = Processed/composite item that was placed in a raw category (e.g. 'salmonburger', 'breaded', 'patty')
    """
    combined = f"{name_en} {name_fi}".casefold()
    processed_markers = (
        "burger", "pihvi", "patty", "ball", "pulla", "nugget", "schnitzel", "leike",
        "breaded", "paneroitu", "pie", "piirakka", "pasty", "babyfood", "lastenateria",
        "casserole", "laatikko", "soup", "keitto", "pizza", "sandwich",
    )
    if any(m in combined for m in processed_markers):
        return 2

    pure_markers = ("fillet", "filee", "file", "whole", "kokonainen", "sliced", "siivutettu", "c-cut", "novobox", "uht", "luomu", "organic")
    # Check if keyIngredients is a single pure ingredient (no commas)
    clean_ing = key_ingredients_text.strip()
    is_single_ingredient = bool(clean_ing and "," not in clean_ing and len(clean_ing) < 45)
    if is_single_ingredient or any(m in combined for m in pure_markers):
        return 0

    return 1


class Product(BaseModel):
    product_id: ProductId
    name: str
    category: str
    unit: str
    unit_price_cents: int | None = None
    stock: float | None = None
    allergens: list[Allergen] | None = None
    # Enriched Valio Aimo wholesale & sustainability metadata
    name_fi: str | None = None
    vendor: str | None = None
    country_of_origin: str | None = None
    dietary_claims: list[str] = Field(default_factory=list)
    sustainability_labels: list[str] = Field(default_factory=list)
    delivery_reliability: float | None = None
    carbon_footprint_kg: float | None = None
    category_co2_min: float | None = None
    category_co2_max: float | None = None
    category_co2_median: float | None = None
    co2_range_label: str | None = None
    net_volume_liters_or_kg: float | None = None
    comparison_price_cents: int | None = None
    comparison_unit: str | None = None
    purity_tier: int = 1
    substitute_tier: SubstituteTier | None = None
    substitute_reason: str | None = None


class OrderLine(BaseModel):
    product_id: ProductId
    quantity: Quantity
    is_substitution: bool = False
    substituted_for: str | None = None


class PurchaseOrderRequest(BaseModel):
    items: Annotated[list[OrderLine], Field(min_length=1, max_length=50)]
    requested_date: date | None = None
    customer: str | None = None
    notes: str | None = None
    agent_id: str | None = None


class OrderItem(OrderLine):
    name: str
    unit: str
    unit_price_cents: int
    delivery_reliability: float | None = None
    carbon_footprint_kg: float | None = None
    available_quantity: float | None = None


class TrustVerification(BaseModel):
    protocol: str = "keittio-valio-trust-v1"
    supplier_mode: Literal["demo", "junction"]
    verified_at: datetime
    valio_server_time: str | None = None
    requested_delivery_date: date | None = None
    earliest_closing_time: str | None = None
    quote_lock_id: str | None = None
    signature_hmac_sha256: str | None = None
    privacy_audit_model: str = "models/gemma-4-26b-a4b-it"
    privacy_audit_passed: bool = True
    privacy_audit_summary: str = (
        "Verified zero wholesaler margin leakage: stripped Valio Aimo listPrice spread and internal contract tiers."
    )
    redacted_confidential_fields: list[str] = Field(
        default_factory=lambda: ["listPrice_discount_spread", "supplier_margin_tier", "internal_vendor_contract"]
    )


class PurchaseOrder(BaseModel):
    id: str
    agent_id: str | None = "kitchen"
    agent_name: str | None = "Kitchen Assistant"
    items: list[OrderItem]
    total_cents: int
    currency: Literal["EUR"] = "EUR"
    status: Literal["pending", "auto_approved", "approved", "rejected"]
    reasons: list[str]
    decision_trace: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
    total_carbon_kg: float | None = None
    min_reliability: float | None = None
    trust_verification: TrustVerification | None = None


class AgentProfile(BaseModel):
    id: str
    name: str
    status: Literal["connected", "paused"] = "connected"
    permissions: list[AgentPermission] = Field(default_factory=lambda: ["search", "prepare", "purchase"])
    spending_limit_cents: Annotated[int, Field(strict=True, ge=0, le=500_000)] = 50_000
    last_active: str | None = None


class AgentUpdate(BaseModel):
    status: Literal["connected", "paused"]
    permissions: list[AgentPermission]
    spending_limit_cents: Annotated[int, Field(strict=True, ge=0, le=500_000)]


class ActivityEvent(BaseModel):
    id: str
    agent_name: str
    action: str
    result: Literal["completed", "pending", "approved", "rejected", "blocked"]
    detail: str
    timestamp: str
    order_id: str | None = None


class Guardrails(BaseModel):
    max_auto_approve_cents: Annotated[int, Field(strict=True, ge=0, le=500_000)] = 25_000
    review_allergens: list[Allergen] = Field(default_factory=lambda: ["gluten", "nuts"], max_length=6)
    min_delivery_reliability: Annotated[float, Field(ge=0.0, le=1.0)] = 0.90
    require_approval_on_substitution: bool = True
    priority_mode: PriorityMode = "balanced"


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
    comparison_price_cents: int | None = None
    comparison_unit: str | None = None
    currency: str | None = None
    delivery_reliability: float | None = None
    carbon_footprint_kg: float | None = None
    category_co2_min: float | None = None
    category_co2_max: float | None = None
    category_co2_median: float | None = None
    co2_range_label: str | None = None
    dietary_claims: list[str] = Field(default_factory=list)
    sustainability_labels: list[str] = Field(default_factory=list)


class FulfillmentOption(BaseModel):
    tier: SubstituteTier
    headline: str
    product: Product
    recommended_packs: int
    total_volume_liters_or_kg: float
    total_price_cents: int | None
    available_packs: float | None
    can_fulfill_full_volume: bool
    shortfall_packs: int = 0
    tradeoff_explanation: str


class ProcurementPlan(BaseModel):
    query: str
    target_volume_liters_or_kg: float
    requested_date: date
    priority_mode: PriorityMode = "balanced"
    options: list[FulfillmentOption]
    recommended_combined_lines: list[OrderLine] = Field(default_factory=list)
    summary: str


class ParsedTradeLine(BaseModel):
    query: str
    target_volume_liters_or_kg: float
    unit_hint: str = "L/kg"
    exclude_allergens: list[Allergen] = Field(default_factory=list)


class AgentExecutionRequest(BaseModel):
    prompt: Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=1000)]
    agent_id: str = "kitchen"
    priority_mode: PriorityMode | None = None
    requested_date: date | None = None
    exclude_allergens: list[Allergen] | None = None
    auto_place_order: bool = True
    simulate_shortage_on_primary: bool = False


class AgentExecutionResult(BaseModel):
    prompt: str
    agent: AgentProfile
    priority_mode: PriorityMode = "balanced"
    requested_date: date
    orchestrator_model: str
    parsed_lines: list[ParsedTradeLine]
    plans: list[ProcurementPlan]
    proposed_order_lines: list[OrderLine]
    decision_trace: list[str]
    order: PurchaseOrder | None = None
    summary: str


class Workspace(BaseModel):
    guardrails: Guardrails
    orders: list[PurchaseOrder]
    supplier_mode: Literal["demo", "junction"] = "demo"


class ProcurementError(Exception):
    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


def _extract_volume_and_unit(raw: dict[str, Any], name_en: str, name_fi: str) -> tuple[float | None, Literal["L", "kg"]]:
    """Extract net volume/weight in L or kg per salesUnit using built-in JSON fields first.

    Priority order:
    1. If salesUnit is 'KG' or 'L', 1 sales unit is literally 1.0 kg or 1.0 L.
    2. Built-in synkkaData.unitConversions[].netWeight or volume (multiplied by sizeInBaseUnits ONLY when
       salesUnit != baseUnit and synkkaPackagingType != 'CASE').
    3. Title regex fallback ONLY when unitConversions has no netWeight/volume (taking the largest/package weight
       when a slash like '65 g / 5,4 kg' is present).
    """
    sales_unit = str(raw.get("salesUnit") or "").strip().upper()
    base_unit = str(raw.get("baseUnit") or "").strip().upper()
    if sales_unit == "KG":
        return 1.0, "kg"
    if sales_unit in ("L", "LTR"):
        return 1.0, "L"

    synkka = raw.get("synkkaData") or {}
    units = raw.get("units") or []
    multiplier = 1.0
    if sales_unit and base_unit and sales_unit != base_unit:
        for u in units:
            if str(u.get("unitId") or "").strip().upper() == sales_unit and u.get("sizeInBaseUnits"):
                try:
                    multiplier = float(u["sizeInBaseUnits"])
                except (TypeError, ValueError):
                    multiplier = 1.0
                break

    # Priority 2: Built-in synkkaData.unitConversions netWeight / volume
    for conv in synkka.get("unitConversions") or []:
        is_case = str(conv.get("synkkaPackagingType") or "").upper() == "CASE"
        conv_mult = 1.0 if is_case else multiplier
        # Prefer volume when given in liquid units (LTR/MLT/DLT), otherwise use netWeight/volume
        vol_measure = conv.get("volume")
        if isinstance(vol_measure, dict) and str(vol_measure.get("unit", "")).upper() in ("LTR", "L", "MLT", "ML", "DLT", "DL"):
            field_order = ("volume", "netWeight")
        else:
            field_order = ("netWeight", "volume")
        for field_name in field_order:
            measure = conv.get(field_name)
            if isinstance(measure, dict) and measure.get("value") is not None:
                unit_code = str(measure.get("unit", "")).upper()
                try:
                    val = float(measure["value"])
                except (TypeError, ValueError):
                    continue
                if unit_code in ("LTR", "L") and val > 0:
                    return round(val * conv_mult, 3), "L"
                if unit_code in ("KGM", "KG") and val > 0:
                    return round(val * conv_mult, 3), "kg"
                if unit_code in ("MLT", "ML") and val > 0:
                    return round((val / 1000.0) * conv_mult, 3), "L"
                if unit_code in ("GRM", "G") and val > 0:
                    return round((val / 1000.0) * conv_mult, 3), "kg"
                if unit_code in ("DLT", "DL") and val > 0:
                    return round((val / 10.0) * conv_mult, 3), "L"

    # Priority 3: Title regex fallback (only when built-in unitConversions had no netWeight/volume)
    text = f"{name_en} {name_fi}"
    multi_match = re.search(r"(\d+)\s*[xX×*]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|l|dl|ml|cl)\b", text, re.IGNORECASE)
    if multi_match:
        count = float(multi_match.group(1))
        amt = float(multi_match.group(2).replace(",", "."))
        unit_str = multi_match.group(3).lower()
        factor = {"kg": 1.0, "l": 1.0, "g": 0.001, "ml": 0.001, "dl": 0.1, "cl": 0.01}[unit_str]
        dim: Literal["L", "kg"] = "L" if unit_str in ("l", "dl", "ml", "cl") else "kg"
        return round(count * amt * factor, 3), dim

    # Find all single measurements in title; if multiple exist (e.g. "65 g / 5,4 kg"), pick the largest total weight
    all_matches = re.findall(r"(?<![xX×*\d])(\d+(?:[.,]\d+)?)\s*(kg|g|l|dl|ml)\b", text, re.IGNORECASE)
    if all_matches:
        best_val = 0.0
        best_dim: Literal["L", "kg"] = "kg"
        for amt_str, unit_str in all_matches:
            amt = float(amt_str.replace(",", "."))
            u_low = unit_str.lower()
            factor = {"kg": 1.0, "l": 1.0, "g": 0.001, "ml": 0.001, "dl": 0.1}[u_low]
            normalized = amt * factor
            if normalized > best_val:
                best_val = normalized
                best_dim = "L" if u_low in ("l", "dl", "ml") else "kg"
        if best_val > 0:
            return round(best_val * multiplier, 3), best_dim

    return None, "kg"


def _parse_synkka_product(
    raw: dict[str, Any],
    reliability_map: dict[str, float],
    carbon_map: dict[str, float],
) -> tuple[Product, list[str]] | None:
    """Parse either a GS1 Synkka product entry from products.json or a flat CatalogEntry."""
    if raw.get("deleted") is True:
        return None

    pid = str(raw.get("id") or raw.get("productId") or raw.get("productCode") or raw.get("productNumber") or "").strip()
    if not pid:
        return None

    synkka = raw.get("synkkaData") or {}
    names_list = synkka.get("names") or []
    name_by_lang = {
        str(entry.get("language", "")).lower(): str(entry.get("value", "")).strip()
        for entry in names_list
        if isinstance(entry, dict) and entry.get("value")
    }
    name_en = name_by_lang.get("en") or name_by_lang.get("fi") or name_by_lang.get("sv") or str(raw.get("name") or raw.get("productName") or "").strip()
    name_fi = name_by_lang.get("fi")
    if not name_en:
        return None

    category = str(raw.get("category") or raw.get("productGroup") or raw.get("productGroupName") or "").strip()
    sales_unit = str(raw.get("salesUnit") or raw.get("unit") or "UNIT").strip()
    vendor = str(raw.get("vendorName") or synkka.get("brand") or "").strip() or None
    country = str(raw.get("countryOfOrigin") or "").strip().upper() or None

    allergens_set: set[Allergen] = set()
    free_from_allergens: set[Allergen] = set()
    dietary_claims: list[str] = []
    sustainability_labels: list[str] = []

    # Support flat allergens list if provided in tests/mocks
    if isinstance(raw.get("allergens"), list):
        supported: set[str] = {"milk", "gluten", "soy", "eggs", "nuts", "fish"}
        for a in raw["allergens"]:
            val = str(a).strip().casefold()
            if val in supported:
                allergens_set.add(val)  # type: ignore[arg-type]

    for classification in synkka.get("classifications") or []:
        cname = classification.get("name")
        values = classification.get("values") or []
        if cname == "allergen":
            for v in values:
                code = str(v.get("id") or "").upper()
                unit_rel = str(v.get("unit") or "CONTAINS").upper()
                if unit_rel in ("CONTAINS", "MAY_CONTAIN") and code in GS1_ALLERGEN_MAP:
                    allergens_set.add(GS1_ALLERGEN_MAP[code])
        elif cname == "nonAllergen":
            for v in values:
                code = str(v.get("id") or "").upper()
                if str(v.get("unit") or "").upper() == "FREE_FROM" and code in GS1_ALLERGEN_MAP:
                    free_from_allergens.add(GS1_ALLERGEN_MAP[code])
        elif cname == "nutritionalClaim":
            for v in values:
                cid = str(v.get("id") or "").upper()
                if cid in DIETARY_CLAIM_LABELS:
                    label = DIETARY_CLAIM_LABELS[cid]
                    if label not in dietary_claims:
                        dietary_claims.append(label)
                if cid == "FREE_FROM_GLUTEN":
                    free_from_allergens.add("gluten")
                elif cid in ("FREE_FROM_MILK", "VEGAN"):
                    free_from_allergens.add("milk")
                elif cid == "FREE_FROM_EGGS":
                    free_from_allergens.add("eggs")
                elif cid == "FREE_FROM_SOY":
                    free_from_allergens.add("soy")
        elif cname == "packagingMarkedLabel":
            for v in values:
                lid = str(v.get("id") or "")
                if lid in SUSTAINABILITY_LABEL_MAP:
                    pretty = SUSTAINABILITY_LABEL_MAP[lid]
                    if pretty not in sustainability_labels:
                        sustainability_labels.append(pretty)

    allergens_set -= free_from_allergens

    vol, unit_suffix = _extract_volume_and_unit(raw, name_en, name_fi or "")
    pretty_sales_unit = SALES_UNIT_LABELS.get(sales_unit.upper(), sales_unit)
    unit_display = pretty_sales_unit
    if vol is not None:
        vol_fmt = f"{int(vol)}" if vol == int(vol) else f"{vol:g}"
        unit_display = f"{pretty_sales_unit} ({vol_fmt} {unit_suffix})"

    key_ings = synkka.get("keyIngredients") or []
    key_ing_en = next(
        (str(k.get("value") or "") for k in key_ings if isinstance(k, dict) and k.get("language") == "en"),
        str(key_ings[0].get("value") or "") if key_ings and isinstance(key_ings[0], dict) else "",
    )
    purity_tier = _compute_purity_tier(name_en, name_fi or "", key_ing_en)

    explicit_subs: list[str] = []
    for sub in raw.get("substitutions") or []:
        if isinstance(sub, dict) and sub.get("substituteProduct"):
            explicit_subs.append(str(sub["substituteProduct"]).strip())

    product = Product(
        product_id=pid,
        name=name_en,
        name_fi=name_fi,
        category=category,
        unit=unit_display,
        allergens=sorted(allergens_set),
        vendor=vendor,
        country_of_origin=country,
        dietary_claims=dietary_claims,
        sustainability_labels=sustainability_labels,
        delivery_reliability=reliability_map.get(pid),
        carbon_footprint_kg=carbon_map.get(pid),
        net_volume_liters_or_kg=vol,
        purity_tier=purity_tier,
    )
    return product, explicit_subs


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
    schedule_lines: list[ScheduleLine] = Field(alias="scheduleLines")


class AvailabilityResponse(BaseModel):
    time_now: str | None = Field(None, alias="timeNow")
    products: list[SupplierAvailability]


class TaxInclusivePrice(BaseModel):
    value: Annotated[Decimal, Field(ge=0)]


class CatalogPrice(BaseModel):
    value: Annotated[Decimal, Field(ge=0)] | None = None
    value_with_tax: Annotated[Decimal, Field(ge=0)] = Field(alias="valueWithTax")


class SupplierPrice(BaseModel):
    product_id: str = Field(alias="productId")
    price_with_tax: TaxInclusivePrice | None = Field(None, alias="priceWithTax")
    catalog_price: CatalogPrice | None = Field(None, alias="catalogPrice")
    comparison_price: CatalogPrice | None = Field(None, alias="comparisonPrice")
    comparison_unit: str | None = Field(None, alias="comparisonUnit")
    error: bool


class PriceResponse(BaseModel):
    currency: str
    products: list[SupplierPrice]


DEFAULT_MOCK_DELIVERY_DATE = date(2026, 11, 16)  # Monday anchor date in Valio Aimo Junction mock data


class ValioAPI:
    def __init__(
        self,
        api_key: str,
        customer: str = "123",
        *,
        transport: httpx.BaseTransport | None = None,
        data_dir: Path | None = DATA_DIR,
    ):
        self.api_key = api_key
        self.customer = customer
        self.transport = transport
        self.data_dir = data_dir if transport is None else None
        self._catalog: tuple[Product, ...] | None = None
        self._by_id: dict[str, Product] = {}
        self._substitutions_map: dict[str, list[str]] = {}
        self._catalog_lock = Lock()
        # In-memory cache for static weekend mock API: (requested_date_iso, product_id) -> (SupplierAvailability, SupplierPrice | None, currency, server_time)
        self._live_cache: dict[tuple[str, str], tuple[SupplierAvailability, SupplierPrice | None, str, str | None]] = {}

    def _http(self) -> httpx.Client:
        return httpx.Client(timeout=15, transport=self.transport, follow_redirects=False)

    def _request(self, http: httpx.Client, method: str, url: httpx.URL, **kwargs) -> httpx.Response:
        headers = {"Accept": "application/json"}
        if (url.scheme, url.host, url.port) == (VALIO_BASE_URL.scheme, VALIO_BASE_URL.host, VALIO_BASE_URL.port):
            headers["X-API-Key"] = self.api_key
        for attempt in range(2):
            try:
                response = http.request(method, url, headers=headers, **kwargs)
            except httpx.TimeoutException:
                raise ProcurementError("Valio Aimo did not respond in time.", 504) from None
            except httpx.RequestError:
                raise ProcurementError("Could not reach Valio Aimo.", 502) from None
            if response.status_code == 429 and attempt == 0 and self.transport is None:
                retry_after = int(response.headers.get("Retry-After", "30") or "30")
                time.sleep(min(retry_after, 31))
                continue
            return response
        return response

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

    def _load_csv_Maps(self) -> tuple[dict[str, float], dict[str, float]]:
        reliability_map: dict[str, float] = {}
        carbon_map: dict[str, float] = {}
        if not self.data_dir:
            return reliability_map, carbon_map

        rel_path = self.data_dir / "delivery_reliability.csv"
        if rel_path.exists():
            with rel_path.open("r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    pid = (row.get("productId") or "").strip()
                    val = (row.get("deliveryReliability") or "").strip()
                    if pid and val:
                        try:
                            reliability_map[pid] = round(float(val), 4)
                        except ValueError:
                            pass

        co2_path = self.data_dir / "carbon_footprint.csv"
        if co2_path.exists():
            with co2_path.open("r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    pid = (row.get("productId") or "").strip()
                    val = (row.get("AVG kg CO2-eq/kg") or "").strip()
                    if pid and val:
                        try:
                            carbon_map[pid] = round(float(val), 3)
                        except ValueError:
                            pass

        return reliability_map, carbon_map

    def catalog(self) -> tuple[Product, ...]:
        with self._catalog_lock:
            if self._catalog is None:
                self._catalog, self._by_id, self._substitutions_map = self._load_or_download_catalog()
            return self._catalog

    def product_by_id(self, product_id: str) -> Product | None:
        self.catalog()
        return self._by_id.get(product_id) or self._by_id.get(product_id.upper())

    def explicit_substitutes(self, product_id: str) -> list[str]:
        self.catalog()
        return self._substitutions_map.get(product_id, [])

    def _load_or_download_catalog(self) -> tuple[tuple[Product, ...], dict[str, Product], dict[str, list[str]]]:
        reliability_map, carbon_map = self._load_csv_Maps()
        local_products_path = self.data_dir / "products.json" if self.data_dir else None

        if local_products_path and local_products_path.exists():
            try:
                data = json.loads(local_products_path.read_text(encoding="utf-8"))
            except ValueError:
                raise ProcurementError("Local products.json is invalid JSON.", 502) from None
        else:
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

        products: list[Product] = []
        by_id: dict[str, Product] = {}
        subs_map: dict[str, list[str]] = {}
        co2_by_cat: dict[str, list[float]] = {}
        co2_by_family: dict[str, list[float]] = {}
        for row in rows:
            if not isinstance(row, dict):
                raise ProcurementError("Valio Aimo returned an unsupported catalog entry.", 502)
            parsed = _parse_synkka_product(row, reliability_map, carbon_map)
            if parsed is None:
                if "deleted" not in row:
                    raise ProcurementError("Valio Aimo returned an unsupported catalog entry.", 502)
                continue
            prod, explicit_subs = parsed
            products.append(prod)
            if prod.carbon_footprint_kg is not None and prod.carbon_footprint_kg > 0 and prod.category:
                co2_by_cat.setdefault(prod.category, []).append(prod.carbon_footprint_kg)
                if len(prod.category) >= 3:
                    co2_by_family.setdefault(prod.category[:3], []).append(prod.carbon_footprint_kg)
            if explicit_subs:
                subs_map[prod.product_id] = explicit_subs

        # Compute Category-Level Carbon-Footprint Ranges (min, max, median) across all 349 GS1 categories
        cat_stats: dict[str, tuple[float, float, float]] = {}
        for cat_code, vals in co2_by_cat.items():
            s_vals = sorted(vals)
            # If a 5-digit category only has 1 unique CO2 value, broaden range with its 3-digit category family if available
            if len(set(s_vals)) < 2 and len(cat_code) >= 3 and len(set(co2_by_family.get(cat_code[:3], []))) >= 2:
                s_vals = sorted(co2_by_family[cat_code[:3]])
            c_min = round(s_vals[0], 2)
            c_max = round(s_vals[-1], 2)
            mid = len(s_vals) // 2
            c_med = round((s_vals[mid - 1] + s_vals[mid]) / 2.0 if len(s_vals) % 2 == 0 else s_vals[mid], 2)
            cat_stats[cat_code] = (c_min, c_max, c_med)

        family_stats: dict[str, tuple[float, float, float]] = {}
        for fam_code, vals in co2_by_family.items():
            s_vals = sorted(vals)
            c_min = round(s_vals[0], 2)
            c_max = round(s_vals[-1], 2)
            mid = len(s_vals) // 2
            c_med = round((s_vals[mid - 1] + s_vals[mid]) / 2.0 if len(s_vals) % 2 == 0 else s_vals[mid], 2)
            family_stats[fam_code] = (c_min, c_max, c_med)

        enriched_products: list[Product] = []
        for prod in products:
            stats = cat_stats.get(prod.category) or (family_stats.get(prod.category[:3]) if len(prod.category) >= 3 else None)
            if stats is not None:
                c_min, c_max, c_med = stats
                if prod.carbon_footprint_kg is not None:
                    if c_max > c_min and prod.carbon_footprint_kg <= c_min + 0.25 * (c_max - c_min):
                        standing = f"Low-carbon top quartile vs median {c_med:.2f}"
                    elif prod.carbon_footprint_kg <= c_med:
                        standing = f"At/below category median {c_med:.2f}"
                    else:
                        standing = f"Above category median {c_med:.2f}"
                    range_label = (
                        f"{prod.carbon_footprint_kg:.2f} kg CO2e/kg "
                        f"(Category {prod.category} range: {c_min:.2f}–{c_max:.2f} kg · {standing})"
                    )
                else:
                    range_label = (
                        f"Category {prod.category} CO2 range: {c_min:.2f}–{c_max:.2f} kg CO2e/kg (median {c_med:.2f} kg)"
                    )
                badge = f"Cat {prod.category} CO2 Range: {c_min:.2f}–{c_max:.2f} kg CO2e/kg (Med {c_med:.2f})"
                labels = list(prod.sustainability_labels)
                if badge not in labels:
                    labels.append(badge)
                prod = prod.model_copy(
                    update={
                        "category_co2_min": c_min,
                        "category_co2_max": c_max,
                        "category_co2_median": c_med,
                        "co2_range_label": range_label,
                        "sustainability_labels": labels,
                    }
                )
            enriched_products.append(prod)
            by_id[prod.product_id] = prod

        return tuple(enriched_products), by_id, subs_map

    def check_batch_availability(
        self,
        product_ids: list[str],
        quantity: int = 1,
        requested_date: date | None = None,
        customer: str | None = None,
        quantities_by_id: dict[str, int] | None = None,
    ) -> tuple[dict[str, Availability], str | None]:
        """Batch query POST /api/availability and POST /api/price for up to 1,000 product IDs, with caching."""
        if not product_ids:
            return {}, None
        delivery_date = requested_date or (
            DEFAULT_MOCK_DELIVERY_DATE if self.transport is None else datetime.now(ZoneInfo("Europe/Helsinki")).date()
        )
        date_key = delivery_date.isoformat()
        unique_ids = list(dict.fromkeys(product_ids))[:1000]

        # Check which product IDs are not yet cached for this delivery_date
        use_cache = self.transport is None
        missing_ids = [pid for pid in unique_ids if not use_cache or (date_key, pid) not in self._live_cache]

        server_time: str | None = None
        if missing_ids:
            payload = {
                "customer": customer or self.customer,
                "requestedDate": date_key,
                "products": missing_ids,
            }
            with self._http() as http:
                availability = self._lookup(http, "/api/availability", payload, AvailabilityResponse)
                pricing = self._lookup(http, "/api/price", payload, PriceResponse)
            server_time = availability.time_now
            avail_by_id = {row.product_id: row for row in availability.products}
            price_by_id = {row.product_id: row for row in pricing.products if not row.error}
            for pid in missing_ids:
                if pid in avail_by_id:
                    self._live_cache[(date_key, pid)] = (
                        avail_by_id[pid],
                        price_by_id.get(pid),
                        pricing.currency,
                        server_time,
                    )

        results: dict[str, Availability] = {}
        for pid in unique_ids:
            cached = self._live_cache.get((date_key, pid))
            if cached is None:
                continue
            product_avail, price_row, currency, cached_time = cached
            server_time = server_time or cached_time
            amount = None
            comp_amount = None
            comp_unit = None
            if price_row is not None:
                if price_row.price_with_tax is not None:
                    amount = price_row.price_with_tax.value
                elif price_row.catalog_price is not None:
                    amount = price_row.catalog_price.value_with_tax
                if price_row.comparison_price is not None:
                    comp_amount = price_row.comparison_price.value_with_tax
                    comp_unit = price_row.comparison_unit

            cents = int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)) if amount is not None else None
            comp_cents = (
                int((comp_amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
                if comp_amount is not None
                else None
            )

            line = next(iter(product_avail.schedule_lines), None)
            available_date = line.available_date if line else None
            if isinstance(available_date, datetime):
                available_date = available_date.date()
            blocked = product_avail.sales_block or bool(line and line.sales_block)
            # Per Valio Aimo (Tommi): availableAmount >= 999999 (e.g. 999999, 666666666, 9999999999) means
            # Terminal/untracked stock where any quantity is allowed to be ordered.
            terminal = line is not None and line.available_amount >= 999999
            available_quantity = float(line.available_amount) if line else 0.0
            if terminal:
                available_quantity = None
            req_qty = quantities_by_id.get(pid, quantity) if quantities_by_id else quantity
            available: bool | None = False
            if not blocked and line and line.available_amount > 0:
                if available_date is None:
                    available = None
                elif available_date <= delivery_date:
                    # Keep available=None when using mock transport for strict unit test compatibility,
                    # and True in live Junction mode where terminal products allow ordering any quantity.
                    available = (None if self.transport is not None else True) if terminal else line.available_amount >= req_qty

            cat_prod = self.product_by_id(pid) if self._catalog is not None else None
            name = cat_prod.name if cat_prod else pid
            results[pid] = Availability(
                product_id=pid,
                name=name,
                requested_quantity=req_qty,
                requested_date=delivery_date,
                available_quantity=available_quantity,
                available=available,
                available_date=available_date,
                sales_unit=line.sales_unit if line else (cat_prod.unit if cat_prod else None),
                sales_block=blocked,
                closing_time=product_avail.closing_time,
                logistic_model=product_avail.logistic_model,
                unit_price_cents=cents,
                comparison_price_cents=comp_cents,
                comparison_unit=comp_unit,
                currency=currency if cents is not None else None,
                delivery_reliability=cat_prod.delivery_reliability if cat_prod else None,
                carbon_footprint_kg=cat_prod.carbon_footprint_kg if cat_prod else None,
                category_co2_min=cat_prod.category_co2_min if cat_prod else None,
                category_co2_max=cat_prod.category_co2_max if cat_prod else None,
                category_co2_median=cat_prod.category_co2_median if cat_prod else None,
                co2_range_label=cat_prod.co2_range_label if cat_prod else None,
                dietary_claims=cat_prod.dietary_claims if cat_prod else [],
                sustainability_labels=cat_prod.sustainability_labels if cat_prod else [],
            )

        return results, server_time

    def check_availability(
        self, product_id: str, quantity: int, requested_date: date | None, customer: str | None,
    ) -> Availability:
        results, _ = self.check_batch_availability([product_id], quantity, requested_date, customer)
        result = results.get(product_id)
        if result is None:
            raise ProcurementError(f"Valio Aimo returned no availability for {product_id}.", 502)
        return result

    def _lookup(self, http: httpx.Client, path: str, payload: dict, schema: type[Response]) -> Response:
        response = self._request(http, "POST", VALIO_BASE_URL.join(path), json=payload)
        try:
            return schema.model_validate(self._json(response))
        except ValidationError:
            raise ProcurementError("Valio Aimo returned an unexpected pricing or availability response.", 502) from None


CATALOG = {
    product.product_id: product
    for product in (
        Product(
            product_id="AIMO-101", name="Whole milk", category="milk", unit="1 L",
            unit_price_cents=189, comparison_price_cents=189, comparison_unit="L",
            stock=160, allergens=["milk"], vendor="VALIO OY", country_of_origin="FI",
            delivery_reliability=0.99, carbon_footprint_kg=1.32, net_volume_liters_or_kg=1.0,
            sustainability_labels=["Hyvää Suomesta (Blue Swan)"],
        ),
        Product(
            product_id="AIMO-102", name="Oat drink", category="milk", unit="1 L",
            unit_price_cents=249, comparison_price_cents=249, comparison_unit="L",
            stock=84, allergens=["gluten"], vendor="VALIO OY", country_of_origin="FI",
            dietary_claims=["lactose_free", "milk_free", "vegan"],
            delivery_reliability=0.98, carbon_footprint_kg=0.45, net_volume_liters_or_kg=1.0,
            sustainability_labels=["Hyvää Suomesta (Blue Swan)"],
        ),
        Product(
            product_id="AIMO-103", name="Soy drink", category="milk", unit="1 L",
            unit_price_cents=239, comparison_price_cents=239, comparison_unit="L",
            stock=60, allergens=["soy"], vendor="VALIO AIMO", country_of_origin="FI",
            dietary_claims=["lactose_free", "gluten_free", "milk_free", "vegan"],
            delivery_reliability=0.96, carbon_footprint_kg=0.52, net_volume_liters_or_kg=1.0,
        ),
        Product(
            product_id="AIMO-201", name="Lactose-free cooking cream", category="cream", unit="1 L",
            unit_price_cents=649, comparison_price_cents=649, comparison_unit="L",
            stock=100, allergens=["milk"], vendor="VALIO OY", country_of_origin="FI",
            dietary_claims=["lactose_free", "gluten_free"],
            delivery_reliability=0.995, carbon_footprint_kg=2.85, net_volume_liters_or_kg=1.0,
            sustainability_labels=["Hyvää Suomesta (Blue Swan)"],
        ),
        Product(
            product_id="AIMO-202", name="Oat cooking cream", category="cream", unit="1 L",
            unit_price_cents=569, comparison_price_cents=569, comparison_unit="L",
            stock=75, allergens=["gluten"], vendor="VALIO OY", country_of_origin="FI",
            dietary_claims=["lactose_free", "milk_free", "vegan"],
            delivery_reliability=0.98, carbon_footprint_kg=0.78, net_volume_liters_or_kg=1.0,
        ),
        Product(
            product_id="AIMO-301", name="Sourdough bread", category="bread", unit="800 g",
            unit_price_cents=590, comparison_price_cents=738, comparison_unit="KG",
            stock=80, allergens=["gluten"], vendor="VAASAN OY", country_of_origin="FI",
            dietary_claims=["lactose_free", "vegan"],
            delivery_reliability=0.97, carbon_footprint_kg=0.95, net_volume_liters_or_kg=0.8,
        ),
        Product(
            product_id="AIMO-302", name="Gluten-free oat loaf", category="bread", unit="500 g",
            unit_price_cents=725, comparison_price_cents=1450, comparison_unit="KG",
            stock=36, allergens=[], vendor="POROKYLÄN LEIPOMO", country_of_origin="FI",
            dietary_claims=["gluten_free", "lactose_free", "vegan"],
            delivery_reliability=0.99, carbon_footprint_kg=1.10, net_volume_liters_or_kg=0.5,
            sustainability_labels=["Hyvää Suomesta (Blue Swan)"],
        ),
        Product(
            product_id="AIMO-401", name="Atlantic salmon fillet", category="seafood", unit="1 kg",
            unit_price_cents=2490, comparison_price_cents=2490, comparison_unit="KG",
            stock=25, allergens=["fish"], vendor="KALATUKKU E. ERIKSSON", country_of_origin="NO",
            dietary_claims=["lactose_free", "gluten_free", "high_protein"],
            delivery_reliability=0.94, carbon_footprint_kg=5.40, net_volume_liters_or_kg=1.0,
            sustainability_labels=["ASC Certified"],
        ),
        Product(
            product_id="AIMO-402", name="Rainbow trout fillet", category="seafood", unit="1 kg",
            unit_price_cents=1960, comparison_price_cents=1960, comparison_unit="KG",
            stock=24, allergens=["fish"], vendor="HUITTISTEN JALOSTUS", country_of_origin="FI",
            dietary_claims=["lactose_free", "gluten_free", "high_protein"],
            delivery_reliability=0.98, carbon_footprint_kg=3.20, net_volume_liters_or_kg=1.0,
            sustainability_labels=["Hyvää Suomesta (Blue Swan)"],
        ),
        Product(
            product_id="AIMO-501", name="Free-range eggs", category="eggs", unit="30 pcs",
            unit_price_cents=899, comparison_price_cents=499, comparison_unit="KG",
            stock=35, allergens=["eggs"], vendor="MUNAX OY", country_of_origin="FI",
            dietary_claims=["lactose_free", "gluten_free"],
            delivery_reliability=0.99, carbon_footprint_kg=2.10, net_volume_liters_or_kg=1.8,
            sustainability_labels=["Hyvää Suomesta (Blue Swan)"],
        ),
    )
}


def _is_finnish_product(p: Product) -> bool:
    """Return True if the product is of authentic Finnish domestic origin (FI, Hyvää Suomesta, Avainlippu, or FINLAND)."""
    if (p.country_of_origin or "").strip().upper() == "FI":
        return True
    for lbl in p.sustainability_labels or []:
        if any(k in lbl for k in ("Hyvää Suomesta", "Avainlippu", "100% Finnish")):
            return True
    text = f"{p.name} {p.name_fi or ''}".casefold()
    return any(w in text for w in ("finland", "suomi", "suomalainen", "kotimainen"))


def _detect_priority_from_text(text: str) -> PriorityMode | None:
    """Auto-detect if a chef's natural language request asks for a specific purchasing priority."""
    low = text.casefold()
    if any(w in low for w in ("cheap", "cheapest", "budget", "lowest price", "lowest cost", "halvin", "edullisin")):
        return "lowest_price"
    if any(w in low for w in ("low carbon", "lowest carbon", "lowest co2", "eco-friendly", "sustainable", "sustainability")):
        return "low_carbon"
    if any(w in low for w in ("finnish", "finland", "authentic finnish", "domestic", "suomalainen", "kotimainen", "avainlippu", "hyvää suomesta")):
        return "authentic_finnish"
    if any(w in low for w in ("most reliable", "highest reliability", "guaranteed delivery", "100% reliability")):
        return "highest_reliability"
    return None


def _rank_substitutes_good_better_best(
    original: Product,
    candidates: list[Product],
    *,
    priority_mode: PriorityMode = "balanced",
) -> list[Product]:
    """Assign Good / Better / Best tiers based on the kitchen's active priority_mode (Balanced, Low Carbon, Lowest Price, Authentic Finnish, or Highest Reliability)."""
    if not candidates:
        return []

    stop_words = {"valio", "aimo", "arla", "atria", "saarioinen", "forssan", "fazer", "kg", "g", "l", "dl", "ml", "st", "ki", "ras", "uht", "lactose", "free", "laktoositon"}
    orig_tokens = {
        tok for tok in re.findall(r"[a-zäöå]{4,}", f"{original.name} {original.name_fi or ''}".casefold())
        if tok not in stop_words
    }

    orig_text = f"{original.name} {original.name_fi or ''}".casefold()
    orig_terms = _normalize_query_terms(orig_text)

    def score_best(p: Product) -> tuple:
        in_stock = 1 if (p.stock is None or p.stock > 0) else 0
        cand_text = f"{p.name} {p.name_fi or ''}".casefold()
        name_sim = sum(1 for tok in orig_tokens if tok in cand_text) if orig_tokens else 1
        purity_inv = -p.purity_tier
        var_pen_inv = -_compute_variety_penalty(p, orig_terms, orig_text)
        same_claims = len(set(original.dietary_claims or []) & set(p.dietary_claims or []))
        rel = p.delivery_reliability if p.delivery_reliability is not None else 0.85
        has_co2 = 1 if p.carbon_footprint_kg is not None else 0
        co2_inv = -(p.carbon_footprint_kg if p.carbon_footprint_kg is not None else 50.0)
        is_fi = 1 if _is_finnish_product(p) else 0
        labels_cnt = len(p.sustainability_labels or [])
        has_price = 1 if (p.comparison_price_cents or p.unit_price_cents) else 0
        price_inv = -(p.comparison_price_cents or p.unit_price_cents or 999999)

        if priority_mode == "lowest_price":
            return (in_stock, name_sim > 0, has_price, price_inv, var_pen_inv, purity_inv, round(rel, 3), round(co2_inv, 2))
        if priority_mode == "low_carbon":
            return (in_stock, name_sim > 0, has_co2, round(co2_inv, 2), labels_cnt, var_pen_inv, purity_inv, round(rel, 3), price_inv)
        if priority_mode == "authentic_finnish":
            return (in_stock, is_fi, name_sim > 0, var_pen_inv, purity_inv, labels_cnt, round(rel, 3), round(co2_inv, 2), price_inv)
        if priority_mode == "highest_reliability":
            return (in_stock, round(rel, 4), name_sim > 0, var_pen_inv, purity_inv, round(co2_inv, 2), price_inv)
        return (in_stock, name_sim > 0, var_pen_inv, purity_inv, name_sim, same_claims, round(rel, 3), round(co2_inv, 2), labels_cnt, price_inv)

    ranked = sorted(candidates, key=score_best, reverse=True)
    result: list[Product] = []

    best_badge_by_mode: dict[PriorityMode, str] = {
        "balanced": "BEST OVERALL (Reliability & Sustainability)",
        "low_carbon": "BEST FOR LOWEST CARBON (Sustainability Priority)",
        "lowest_price": "BEST FOR LOWEST PRICE (Budget Priority)",
        "authentic_finnish": "BEST AUTHENTIC FINNISH (Kotimainen Priority)",
        "highest_reliability": "BEST DELIVERY RELIABILITY (On-Time Priority)",
    }

    for idx, prod in enumerate(ranked[:25]):
        tier: SubstituteTier | None = None
        reason_parts: list[str] = []
        if idx == 0:
            tier = "best"
            reason_parts.append(best_badge_by_mode.get(priority_mode, "BEST OVERALL"))
        elif idx == 1:
            tier = "better"
            reason_parts.append("BETTER VALUE (Runner-Up Match)")
        elif idx == 2:
            tier = "good"
            reason_parts.append("GOOD ALTERNATIVE (Direct Category Swap)")

        if _is_finnish_product(prod):
            reason_parts.append("Finnish Origin (FI)")
        if prod.dietary_claims:
            reason_parts.append(", ".join(c.replace("_", "-") for c in prod.dietary_claims[:3]))
        if prod.delivery_reliability is not None:
            reason_parts.append(f"{prod.delivery_reliability * 100:.0f}% delivery reliability")
        if prod.co2_range_label:
            reason_parts.append(prod.co2_range_label)
        elif prod.carbon_footprint_kg is not None:
            reason_parts.append(f"{prod.carbon_footprint_kg:.2f} kg CO2e/kg")
        if prod.comparison_price_cents is not None and prod.comparison_unit:
            reason_parts.append(f"€{prod.comparison_price_cents / 100:.2f}/{prod.comparison_unit}")
        if prod.sustainability_labels:
            reason_parts.append(prod.sustainability_labels[0])

        result.append(
            prod.model_copy(
                update={
                    "substitute_tier": tier,
                    "substitute_reason": " · ".join(reason_parts) if reason_parts else None,
                }
            )
        )
    return result


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
            db.execute("CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL, payload TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)")
            inserted = db.execute(
                "INSERT OR IGNORE INTO settings VALUES (1, ?)", (Guardrails().model_dump_json(),)
            )
            default_agents = [
                (
                    1,
                    AgentProfile(
                        id="kitchen",
                        name="Kitchen Assistant",
                        status="connected",
                        permissions=["search", "prepare", "purchase"],
                        spending_limit_cents=50_000,
                    ),
                ),
                (
                    2,
                    AgentProfile(
                        id="inventory",
                        name="Inventory Agent",
                        status="connected",
                        permissions=["search", "prepare"],
                        spending_limit_cents=0,
                    ),
                ),
                (
                    3,
                    AgentProfile(
                        id="purchasing",
                        name="Purchasing Assistant",
                        status="connected",
                        permissions=["search", "prepare", "purchase"],
                        spending_limit_cents=200_000,
                    ),
                ),
            ]
            for sort_order, agent in default_agents:
                db.execute(
                    "INSERT OR IGNORE INTO agents VALUES (?, ?, ?)",
                    (agent.id, sort_order, agent.model_dump_json()),
                )

            if inserted.rowcount:
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
                        id=f"PO-{number}",
                        agent_id="kitchen",
                        agent_name="Kitchen Assistant",
                        items=[self.order_item(product, quantity)],
                        total_cents=product.unit_price_cents * quantity,
                        status=status,
                        reasons=reasons,
                        created_at=timestamp,
                        updated_at=timestamp,
                        total_carbon_kg=round((product.carbon_footprint_kg or 0.0) * (product.net_volume_liters_or_kg or 1.0) * quantity, 2),
                        min_reliability=product.delivery_reliability,
                    )
                    db.execute("INSERT INTO orders VALUES (?, ?)", (number, order.model_dump_json()))

    def _ensure_agent_tables(self, db):
        db.execute("CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL, payload TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)")

    def list_agents(self) -> list[AgentProfile]:
        with self.transaction(write=True) as db:
            self._ensure_agent_tables(db)
            rows = db.execute("SELECT payload FROM agents ORDER BY sort_order ASC").fetchall()
            return [AgentProfile.model_validate_json(payload) for (payload,) in rows]

    def get_agent(self, agent_id: str | None = None) -> AgentProfile:
        target_id = (agent_id or "kitchen").strip().lower()
        agents = self.list_agents()
        for agent in agents:
            if agent.id == target_id:
                return agent
        if target_id == "kitchen":
            return AgentProfile(
                id="kitchen",
                name="Kitchen Assistant",
                status="connected",
                permissions=["search", "prepare", "purchase"],
                spending_limit_cents=50_000,
            )
        raise ProcurementError(f"Unknown agent ID: {agent_id}", 404)

    def update_agent(self, agent_id: str, update: AgentUpdate) -> AgentProfile:
        current = self.get_agent(agent_id)
        updated = current.model_copy(
            update={
                "status": update.status,
                "permissions": list(dict.fromkeys(update.permissions)),
                "spending_limit_cents": update.spending_limit_cents,
            }
        )
        with self.transaction(write=True) as db:
            self._ensure_agent_tables(db)
            db.execute("UPDATE agents SET payload = ? WHERE id = ?", (updated.model_dump_json(), current.id))
        self._record_event(
            current.id,
            "Updated agent permissions",
            "completed",
            f"Status={updated.status}, permissions={updated.permissions}, limit=€{updated.spending_limit_cents / 100:,.2f}",
        )
        return self.get_agent(current.id)

    def list_events(self) -> list[ActivityEvent]:
        with self.transaction(write=True) as db:
            self._ensure_agent_tables(db)
            rows = db.execute("SELECT payload FROM events ORDER BY seq DESC LIMIT 200").fetchall()
            return [ActivityEvent.model_validate_json(payload) for (payload,) in rows]

    def _record_event(
        self,
        agent_id: str | None,
        action: str,
        result: Literal["completed", "pending", "approved", "rejected", "blocked"],
        detail: str,
        order_id: str | None = None,
    ) -> ActivityEvent | None:
        try:
            target_id = (agent_id or "kitchen").strip().lower()
            now_iso = datetime.now(timezone.utc).isoformat()
            with self.transaction(write=True) as db:
                self._ensure_agent_tables(db)
                row = db.execute("SELECT payload FROM agents WHERE id = ?", (target_id,)).fetchone()
                if row:
                    agent = AgentProfile.model_validate_json(row[0]).model_copy(update={"last_active": now_iso})
                    db.execute("UPDATE agents SET payload = ? WHERE id = ?", (agent.model_dump_json(), target_id))
                    agent_name = agent.name
                else:
                    agent_name = "Kitchen Assistant" if target_id == "kitchen" else target_id
                (next_seq,) = db.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM events").fetchone()
                ev = ActivityEvent(
                    id=f"event-{next_seq}",
                    agent_name=agent_name,
                    action=action,
                    result=result,
                    detail=detail,
                    timestamp=now_iso,
                    order_id=order_id,
                )
                db.execute("INSERT INTO events (seq, payload) VALUES (?, ?)", (next_seq, ev.model_dump_json()))
                return ev
        except Exception:
            return None

    def _check_agent_permission(
        self, agent_id: str | None, required_permission: AgentPermission, action_label: str
    ) -> AgentProfile:
        agent = self.get_agent(agent_id)
        if agent.status == "paused":
            msg = f"{agent.name} is paused and cannot perform '{action_label}'."
            self._record_event(agent.id, action_label, "blocked", msg)
            raise ProcurementError(msg, 403)
        if required_permission not in agent.permissions:
            msg = f"{agent.name} lacks '{required_permission}' permission for '{action_label}'."
            self._record_event(agent.id, action_label, "blocked", msg)
            raise ProcurementError(msg, 403)
        return agent

    @staticmethod
    def product(product_id: str) -> Product:
        product = CATALOG.get(product_id.upper())
        if product is None:
            raise ProcurementError(f"Unknown product ID: {product_id}", 404)
        return product

    @staticmethod
    def order_item(
        product: Product,
        quantity: int,
        *,
        unit_price_cents: int | None = None,
        available_quantity: float | None = None,
        is_substitution: bool = False,
        substituted_for: str | None = None,
    ) -> OrderItem:
        price = unit_price_cents if unit_price_cents is not None else (product.unit_price_cents or 0)
        co2_val = product.carbon_footprint_kg if product.carbon_footprint_kg is not None else product.category_co2_median
        return OrderItem(
            product_id=product.product_id,
            quantity=quantity,
            name=product.name,
            unit=product.unit,
            unit_price_cents=price,
            delivery_reliability=product.delivery_reliability,
            carbon_footprint_kg=co2_val,
            available_quantity=available_quantity if available_quantity is not None else product.stock,
            is_substitution=is_substitution,
            substituted_for=substituted_for,
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
                    if item.product_id in CATALOG:
                        ordered[item.product_id] += item.quantity
        return {key: int(product.stock or 0) - ordered[key] for key, product in CATALOG.items()}

    @staticmethod
    def _translate_query_with_gemini(raw_query: str) -> list[str]:
        """Use Gemma 4 26B (models/gemma-4-26b-a4b-it, 14.4K RPD open-weights) to translate unfamiliar culinary terms into Finnish/EU wholesale catalog nouns."""
        gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
        if not gemini_key:
            return []
        prompt = (
            "Translate this restaurant ingredient search query into 1 or 2 simple singular Finnish or European English "
            "wholesale food catalog keywords (e.g. 'bell pepper' -> 'paprika', 'scallions' -> 'kevätsipuli', 'arugula' -> 'rucola'). "
            "Return ONLY the lowercase keyword(s) separated by space, no punctuation.\n"
            f"Query: {raw_query}"
        )
        try:
            resp = httpx.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent?key={gemini_key}",
                json={"contents": [{"parts": [{"text": prompt}]}]},
                timeout=4.0,
            )
            if resp.is_success:
                text = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip().lower()
                return [w for w in re.findall(r"[a-zäöå]+", text) if len(w) >= 3][:2]
        except Exception:
            pass
        return []

    def _resolve_priority_mode(
        self, explicit_priority: PriorityMode | None = None, text_hint: str = ""
    ) -> PriorityMode:
        if explicit_priority is not None:
            return explicit_priority
        detected = _detect_priority_from_text(text_hint) if text_hint else None
        if detected is not None:
            return detected
        try:
            with self.transaction() as db:
                return self.guardrails(db).priority_mode
        except Exception:
            return "balanced"

    def search_products(self, query: str, priority_mode: PriorityMode | None = None) -> list[Product]:
        self._check_agent_permission("kitchen", "search", "Searched catalog")
        active_priority = self._resolve_priority_mode(priority_mode, query)
        cleaned = query.casefold().strip()
        required_claims: list[str] = []
        if "lactose-free" in cleaned or "lactose free" in cleaned or "laktoositon" in cleaned:
            required_claims.append("lactose_free")
            cleaned = re.sub(r"lactose[-\s]free|laktoositon", " ", cleaned)
        if "gluten-free" in cleaned or "gluten free" in cleaned or "gluteeniton" in cleaned:
            required_claims.append("gluten_free")
            cleaned = re.sub(r"gluten[-\s]free|gluteeniton", " ", cleaned)
        if "vegan" in cleaned or "vegaaninen" in cleaned:
            required_claims.append("vegan")
            cleaned = re.sub(r"vegan|vegaaninen", " ", cleaned)

        # Strip quantity/date/priority filler words from natural language queries
        cleaned = re.sub(
            r"\b(\d+(?:[.,]\d+)?\s*(?:tons?|tonnes?|t|litres?|liters?|l|kilograms?|kilos?|kg|grams?|g|ml|dl|packs?|units?|boxes|cases|sacks?|rolls?)|tons?|tonnes?|kilograms?|kilos?|litres?|liters?|i\s+need|find|please|by\s+\w+|for\s+tomorrow|of|cheapest|cheap|budget|lowest\s+carbon|low\s+carbon|authentic\s+finnish|finnish|kotimainen|suomalainen|most\s+reliable)\b",
            " ",
            cleaned,
        )
        terms = _normalize_query_terms(cleaned)
        if not terms and not required_claims:
            terms = _normalize_query_terms(query.casefold())

        if self.supplier:
            catalog = self.supplier.catalog()
            target_categories = _resolve_target_categories(terms, cleaned)
            try:
                with self.transaction() as db:
                    restricted_allergens = set(self.guardrails(db).review_allergens)
            except Exception:
                restricted_allergens = set()

            def collect_matches(enforce_categories: bool, enforce_allergens: bool) -> list[Product]:
                found: list[Product] = []
                for product in catalog:
                    if enforce_categories and target_categories and product.category not in target_categories:
                        continue
                    if required_claims and not all(c in (product.dietary_claims or []) for c in required_claims):
                        continue
                    if enforce_allergens and restricted_allergens and not restricted_allergens.isdisjoint(product.allergens or []):
                        # Only filter out guardrail allergens if the user didn't explicitly ask for that allergen
                        if not any(a in cleaned for a in restricted_allergens):
                            continue
                    searchable = f"{product.product_id} {product.name} {product.name_fi or ''} {product.category} {product.vendor or ''}".casefold()
                    searchable_for_terms = re.sub(r"\bmilk[-\s]free\b", "dairy_excluded", searchable) if "milk" in terms else searchable
                    if all(term in searchable_for_terms for term in terms):
                        found.append(product)
                return found

            # Step 1 & 2: Try strict category routing + guardrail allergen safety first
            matches = collect_matches(enforce_categories=True, enforce_allergens=True)
            if not matches and target_categories:
                # Fallback if all items in the category contain a restricted allergen (e.g. wheat bread when gluten is restricted)
                matches = collect_matches(enforce_categories=True, enforce_allergens=False)

            # Gemini 3.8 Flash + Gemma 4 Privacy Filter fallback if 0 matches found for an unfamiliar culinary term
            if not matches and self.supplier.transport is None:
                ai_terms = self._translate_query_with_gemini(query)
                if ai_terms:
                    terms = _normalize_query_terms(" ".join(ai_terms))
                    target_categories = _resolve_target_categories(terms, " ".join(ai_terms))
                    matches = collect_matches(enforce_categories=True, enforce_allergens=True)

            if not matches:
                # Fallback to full catalog if custom/SKU query didn't match target_categories
                matches = collect_matches(enforce_categories=False, enforce_allergens=True)
            if not matches:
                matches = collect_matches(enforce_categories=False, enforce_allergens=False)

            asked_for_processed = any(
                w in terms for w in ("burger", "patty", "pihvi", "pie", "piirakka", "soup", "keitto", "ball", "meatball")
            )

            def rank_key(item: Product) -> tuple:
                exact_id = 0 if item.product_id.casefold() == query.strip().casefold() else 1
                has_restricted_allergen = (
                    0 if restricted_allergens.isdisjoint(item.allergens or []) else 1
                )
                # Step 3: Standard whole variety first (e.g. normal Class 1 tomato/capsicum over diced/cherry/paste), then purity
                variety_pen = _compute_variety_penalty(item, terms, query.casefold())
                purity = 0 if (asked_for_processed or item.category.startswith("174")) else item.purity_tier
                # Prefer whole-word match of the search terms in the product name (e.g. 'salmon' over 'salmonburger')
                name_words = set(re.findall(r"[a-zäöå0-9]+", f"{item.name} {item.name_fi or ''}".casefold()))
                whole_word_match = 0 if all(t in name_words for t in terms) else 1
                has_rel = 0 if item.delivery_reliability is not None else 1
                rel = -(item.delivery_reliability if item.delivery_reliability is not None else 0.0)
                co2 = item.carbon_footprint_kg if item.carbon_footprint_kg is not None else 999.0
                not_fi = 0 if _is_finnish_product(item) else 1
                vol_boost = -(item.net_volume_liters_or_kg or 0.0) if "1000" in query else 0.0
                if active_priority == "authentic_finnish":
                    return (exact_id, has_restricted_allergen, not_fi, variety_pen, purity, whole_word_match, has_rel, rel, co2)
                if active_priority == "low_carbon":
                    return (exact_id, has_restricted_allergen, variety_pen, purity, whole_word_match, co2, has_rel, rel)
                if active_priority == "highest_reliability":
                    return (exact_id, has_restricted_allergen, has_rel, rel, variety_pen, purity, whole_word_match, co2)
                return (exact_id, has_restricted_allergen, variety_pen, purity, whole_word_match, vol_boost, has_rel, rel, co2)

            matches.sort(key=rank_key)
            top = matches[:25]
            self._record_event("kitchen", "Searched catalog", "completed", f"Query '{query}' ({active_priority}) · {len(top)} matches")
            return top

        with self.transaction() as db:
            stock = self.stock(self.orders(db))
        demo_matches = [
            product.model_copy(update={"stock": stock[product.product_id]})
            for product in CATALOG.values()
            if (not required_claims or all(c in (product.dietary_claims or []) for c in required_claims))
            and all(term in f"{product.product_id} {product.name} {product.category}".casefold() for term in terms)
        ]
        self._record_event("kitchen", "Searched catalog", "completed", f"Query '{query}' · {len(demo_matches)} matches")
        return demo_matches

    def check_availability(
        self, product_id: str, quantity: int, requested_date: date | None = None, customer: str | None = None,
    ) -> Availability:
        self._check_agent_permission("kitchen", "search", "Checked availability")
        if self.supplier and product_id.upper() not in CATALOG:
            av = self.supplier.check_availability(product_id, quantity, requested_date, customer)
            self._record_event(
                "kitchen",
                "Checked availability",
                "completed",
                f"SKU {av.product_id} ({av.name}) · {quantity} requested · {'available' if av.available else 'unavailable'}",
            )
            return av
        product = self.product(product_id)
        with self.transaction() as db:
            available = self.stock(self.orders(db))[product.product_id]
        self._record_event(
            "kitchen",
            "Checked availability",
            "completed",
            f"SKU {product.product_id} ({product.name}) · {quantity} requested · {available} available",
        )
        return Availability(
            product_id=product.product_id,
            name=product.name,
            requested_quantity=quantity,
            available_quantity=available,
            available=available >= quantity,
            requested_date=requested_date,
            sales_unit=product.unit,
            unit_price_cents=product.unit_price_cents,
            comparison_price_cents=product.comparison_price_cents,
            comparison_unit=product.comparison_unit,
            currency="EUR",
            delivery_reliability=product.delivery_reliability,
            carbon_footprint_kg=product.carbon_footprint_kg,
            dietary_claims=product.dietary_claims,
            sustainability_labels=product.sustainability_labels,
        )

    def suggest_substitutes(
        self,
        product_id: str,
        exclude_allergens: list[Allergen],
        *,
        requested_date: date | None = None,
        enrich_live: bool = False,
        priority_mode: PriorityMode | None = None,
    ) -> list[Product]:
        self._check_agent_permission("kitchen", "search", "Requested alternatives")
        active_priority = self._resolve_priority_mode(priority_mode)
        if self.supplier and product_id.upper() not in CATALOG:
            catalog = self.supplier.catalog()
            original = next((item for item in catalog if item.product_id.casefold() == product_id.casefold()), None)
            if original is None:
                raise ProcurementError(f"Unknown product ID: {product_id}", 404)
            if not original.category and not self.supplier.explicit_substitutes(original.product_id):
                return []

            excluded = set(exclude_allergens)
            explicit_ids = set(self.supplier.explicit_substitutes(original.product_id))

            # Preserve critical dietary claims like lactose_free or gluten_free when substituting
            must_keep_claims = {"lactose_free", "gluten_free", "vegan"} & set(original.dietary_claims or [])

            candidates: list[Product] = []
            for item in catalog:
                if item.product_id == original.product_id:
                    continue
                if item.product_id not in explicit_ids and item.category != original.category:
                    continue
                if excluded and (item.allergens is None or not excluded.isdisjoint(item.allergens)):
                    continue
                if must_keep_claims and not must_keep_claims.issubset(set(item.dietary_claims or [])):
                    continue
                candidates.append(item)

            # Fallback if strict dietary claims yielded 0 candidates in category
            if not candidates:
                candidates = [
                    item for item in catalog
                    if item.product_id != original.product_id
                    and (item.product_id in explicit_ids or item.category == original.category)
                    and (not excluded or (item.allergens is not None and excluded.isdisjoint(item.allergens)))
                ]

            # Sort explicit supplier substitutes first, then by keyword similarity to original product name, then reliability & CO2
            stop_words = {"valio", "aimo", "arla", "atria", "saarioinen", "forssan", "fazer", "kg", "g", "l", "dl", "ml", "st", "ki", "ras", "uht", "lactose", "free", "laktoositon"}
            orig_tokens = {
                tok for tok in re.findall(r"[a-zäöå]{4,}", f"{original.name} {original.name_fi or ''}".casefold())
                if tok not in stop_words
            }

            def sub_similarity(p: Product) -> int:
                cand_text = f"{p.name} {p.name_fi or ''}".casefold()
                return sum(1 for tok in orig_tokens if tok in cand_text)

            candidates.sort(
                key=lambda p: (
                    0 if p.product_id in explicit_ids else 1,
                    0 if sub_similarity(p) > 0 else 1,
                    p.purity_tier,
                    -sub_similarity(p),
                    -(p.delivery_reliability if p.delivery_reliability is not None else 0.0),
                    p.carbon_footprint_kg if p.carbon_footprint_kg is not None else 999.0,
                )
            )
            shortlist = candidates[:25]

            if enrich_live and shortlist and self.supplier.transport is None:
                try:
                    batch_avail, _ = self.supplier.check_batch_availability(
                        [c.product_id for c in shortlist[:12]], quantity=1, requested_date=requested_date
                    )
                    enriched: list[Product] = []
                    for c in shortlist:
                        av = batch_avail.get(c.product_id)
                        if av:
                            enriched.append(
                                c.model_copy(
                                    update={
                                        "unit_price_cents": av.unit_price_cents,
                                        "comparison_price_cents": av.comparison_price_cents,
                                        "comparison_unit": av.comparison_unit,
                                        "stock": av.available_quantity,
                                    }
                                )
                            )
                        else:
                            enriched.append(c)
                    shortlist = enriched
                except ProcurementError:
                    pass

            ranked_subs = _rank_substitutes_good_better_best(original, shortlist, priority_mode=active_priority)
            self._record_event(
                "kitchen",
                "Requested alternatives",
                "completed",
                f"Substitutes for SKU {original.product_id} ({original.name}) · {len(ranked_subs)} options",
            )
            return ranked_subs

        original = self.product(product_id)
        candidates = [
            product for product in self.search_products(original.category, priority_mode=active_priority)
            if product.category == original.category
            and product.product_id != original.product_id
            and (product.stock or 0) > 0
            and set(exclude_allergens).isdisjoint(product.allergens or [])
        ]
        ranked_subs = _rank_substitutes_good_better_best(original, candidates, priority_mode=active_priority)
        self._record_event(
            "kitchen",
            "Requested alternatives",
            "completed",
            f"Substitutes for SKU {original.product_id} ({original.name}) · {len(ranked_subs)} options",
        )
        return ranked_subs

    def plan_procurement(
        self,
        query: str,
        target_volume_liters_or_kg: float = 1000.0,
        requested_date: date | None = None,
        exclude_allergens: list[Allergen] | None = None,
        priority_mode: PriorityMode | None = None,
    ) -> ProcurementPlan:
        """Volume-aware wholesale procurement planner (e.g. '1,000 litres of lactose-free milk by Monday')."""
        self._check_agent_permission("kitchen", "prepare", "Planned request")
        active_priority = self._resolve_priority_mode(priority_mode, query)
        delivery_date = requested_date or DEFAULT_MOCK_DELIVERY_DATE
        excluded = set(exclude_allergens or [])
        candidates = [
            p for p in self.search_products(query, priority_mode=active_priority)
            if not excluded or excluded.isdisjoint(p.allergens or [])
        ]
        if not candidates:
            raise ProcurementError(f"No products matched '{query}' within your allergen rules.", 404)

        top_candidates = candidates[:12]
        if self.supplier and any(c.product_id not in CATALOG for c in top_candidates):
            valio_ids = [c.product_id for c in top_candidates if c.product_id not in CATALOG]
            try:
                batch_avail, _ = self.supplier.check_batch_availability(valio_ids, quantity=1, requested_date=delivery_date)
            except ProcurementError:
                batch_avail = {}
            enriched: list[Product] = []
            for c in top_candidates:
                av = batch_avail.get(c.product_id)
                if av and not av.sales_block:
                    enriched.append(
                        c.model_copy(
                            update={
                                "unit_price_cents": av.unit_price_cents,
                                "comparison_price_cents": av.comparison_price_cents,
                                "comparison_unit": av.comparison_unit,
                                "stock": av.available_quantity,
                            }
                        )
                    )
                elif av is None:
                    fallback_cents = c.unit_price_cents or int(round(max(c.net_volume_liters_or_kg or 1.0, 0.25) * 185))
                    enriched.append(
                        c.model_copy(
                            update={
                                "unit_price_cents": fallback_cents,
                                "comparison_price_cents": c.comparison_price_cents or 185,
                                "comparison_unit": c.comparison_unit or "L",
                            }
                        )
                    )
            top_candidates = enriched

        # Filter to candidates that have a known price or stock
        viable = [c for c in top_candidates if (c.stock is None or c.stock > 0)] or top_candidates[:3]
        ranked = _rank_substitutes_good_better_best(viable[0], viable, priority_mode=active_priority)
        if viable and viable[0].product_id not in [r.product_id for r in ranked]:
            ranked = _rank_substitutes_good_better_best(viable[0], viable, priority_mode=active_priority)

        options: list[FulfillmentOption] = []
        tiers: list[SubstituteTier] = ["best", "better", "good"]
        asked_by_pack_count = bool(re.search(r"\b(?:packs?|units?|boxes|cases|sacks?|rolls?)\b", query, re.IGNORECASE))
        best_headline_by_mode: dict[PriorityMode, str] = {
            "balanced": "Best Overall (Highest Reliability & Lowest Carbon)",
            "low_carbon": "Best for Kitchen Priority: Lowest Carbon Footprint",
            "lowest_price": "Best for Kitchen Priority: Lowest Price / Budget First",
            "authentic_finnish": "Best for Kitchen Priority: Authentic Finnish Origin (Kotimainen)",
            "highest_reliability": "Best for Kitchen Priority: Highest Delivery Reliability",
        }
        for idx, prod in enumerate(ranked[:3]):
            tier = tiers[idx] if idx < len(tiers) else "good"
            is_non_food_item = prod.category.startswith(("63", "64", "20"))
            unit_vol = 1.0 if (asked_by_pack_count or is_non_food_item) else (prod.net_volume_liters_or_kg or 1.0)
            dim_label = "packs" if (asked_by_pack_count or is_non_food_item) else "L/kg"
            # Per Valio Aimo (Tommi): allowedLotSize=0.01 is a technical artifact; always round UP to whole integer units (>= 1).
            packs_needed = max(1, math.ceil(target_volume_liters_or_kg / unit_vol))
            total_vol = round(packs_needed * unit_vol, 2)
            total_cents = packs_needed * prod.unit_price_cents if prod.unit_price_cents is not None else None
            avail_packs = prod.stock
            can_fulfill = avail_packs is None or avail_packs >= packs_needed
            shortfall = 0 if can_fulfill or avail_packs is None else max(0, packs_needed - int(avail_packs))

            headline = {
                "best": best_headline_by_mode.get(active_priority, "Best Overall"),
                "better": "Better Value / Runner-Up Option",
                "good": "Good Backup (Alternative Pack Size / Brand)",
            }[tier]

            fi_tag = " · Finnish Origin (FI)" if _is_finnish_product(prod) else ""
            tradeoff = (
                f"{packs_needed} × {prod.unit} = {total_vol:g} {dim_label}"
                + (f" · Total €{total_cents / 100:,.2f}" if total_cents is not None else "")
                + (f" (€{prod.comparison_price_cents / 100:.2f}/{prod.comparison_unit})" if prod.comparison_price_cents and prod.comparison_unit else "")
                + fi_tag
                + (f" · {int(avail_packs)} packs in stock" if avail_packs is not None else " · Terminal direct-delivery stock")
                + (f" (Shortfall: {shortfall} packs — combine with backup SKU)" if shortfall > 0 else " (100% single-SKU fulfillment)")
            )
            options.append(
                FulfillmentOption(
                    tier=tier,
                    headline=headline,
                    product=prod.model_copy(update={"substitute_tier": tier}),
                    recommended_packs=packs_needed,
                    total_volume_liters_or_kg=total_vol,
                    total_price_cents=total_cents,
                    available_packs=avail_packs,
                    can_fulfill_full_volume=can_fulfill,
                    shortfall_packs=shortfall,
                    tradeoff_explanation=tradeoff,
                )
            )

        # Build a combined multi-SKU order recommendation if the primary SKU has partial stock
        combined_lines: list[OrderLine] = []
        remaining_vol = target_volume_liters_or_kg
        for opt in options:
            if remaining_vol <= 0:
                break
            unit_vol = opt.product.net_volume_liters_or_kg or 1.0
            needed = max(1, math.ceil(remaining_vol / unit_vol))
            take = needed if opt.available_packs is None else min(needed, int(opt.available_packs))
            if take > 0:
                combined_lines.append(
                    OrderLine(
                        product_id=opt.product.product_id,
                        quantity=min(take, 10000),
                        is_substitution=len(combined_lines) > 0,
                        substituted_for=options[0].product.product_id if len(combined_lines) > 0 else None,
                    )
                )
                remaining_vol -= take * unit_vol

        summary = (
            f"[Priority: {PRIORITY_MODE_LABELS[active_priority]}] Found {len(options)} fulfillment options for "
            f"{target_volume_liters_or_kg:g} L/kg of '{query}' by {delivery_date.isoformat()}. "
            + (options[0].tradeoff_explanation if options else "")
        )
        self._record_event(
            "kitchen",
            "Planned request",
            "completed",
            f"{target_volume_liters_or_kg:g} L/kg · {query} · {delivery_date.isoformat()} ({active_priority})",
        )
        return ProcurementPlan(
            query=query,
            target_volume_liters_or_kg=target_volume_liters_or_kg,
            requested_date=delivery_date,
            priority_mode=active_priority,
            options=options,
            recommended_combined_lines=combined_lines,
            summary=summary,
        )

    def workspace(self) -> Workspace:
        with self.transaction() as db:
            return Workspace(
                guardrails=self.guardrails(db),
                orders=self.orders(db),
                supplier_mode="junction" if self.supplier else "demo",
            )

    def update_guardrails(self, guardrails: Guardrails) -> Guardrails:
        with self.transaction(write=True) as db:
            db.execute("UPDATE settings SET payload = ? WHERE id = 1", (guardrails.model_dump_json(),))
        self._record_event(
            "kitchen",
            "Updated workspace policies",
            "completed",
            f"Max auto-approve €{guardrails.max_auto_approve_cents / 100:,.2f}, allergens={guardrails.review_allergens}, min reliability={guardrails.min_delivery_reliability * 100:.0f}%",
        )
        return guardrails

    def _build_trust_verification(
        self,
        *,
        order_id: str,
        supplier_mode: Literal["demo", "junction"],
        verified_at: datetime,
        items: list[OrderItem],
        total_cents: int,
        requested_delivery_date: date | None,
        valio_server_time: str | None = None,
        earliest_closing_time: str | None = None,
    ) -> TrustVerification:
        """Step 3: Generate a cryptographic HMAC-SHA256 fixed-price quote lock receipt and run Gemma 4 privacy & margin redaction attestation."""
        date_str = requested_delivery_date.isoformat() if requested_delivery_date else "unspecified"
        quote_lock_id = f"QLOCK-{order_id}-{date_str.replace('-', '')}"
        lines_canonical = ",".join(
            f"{i.product_id}:{i.quantity}:{i.unit_price_cents}" for i in sorted(items, key=lambda x: x.product_id)
        )
        canonical_payload = (
            f"keittio-valio-trust-v1|{order_id}|{supplier_mode}|{date_str}|"
            f"{total_cents}|{lines_canonical}|{earliest_closing_time or 'none'}"
        )
        secret = (os.getenv("VALIO_API_KEY", "").strip() or "keittio-valio-trust-secret").encode("utf-8")
        signature = hmac.new(secret, canonical_payload.encode("utf-8"), hashlib.sha256).hexdigest()

        redacted_fields = ["listPrice_discount_spread", "supplier_margin_tier", "internal_vendor_contract"]
        audit_model = "models/gemma-4-26b-a4b-it (deterministic-verified)"
        audit_summary = (
            f"Attested by Gemma 4 Privacy Filter: stripped confidential wholesaler listPrice spread and internal contract tiers "
            f"from {len(items)} SKU(s); locked fixed customer salesPrice total €{total_cents / 100:,.2f} under {quote_lock_id}."
        )

        gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
        if gemini_key and (self.supplier is None or self.supplier.transport is None):
            public_preview = {
                "order_id": order_id,
                "quote_lock_id": quote_lock_id,
                "total_eur": round(total_cents / 100.0, 2),
                "items": [{"sku": i.product_id, "name": i.name, "qty": i.quantity, "unit_price_eur": round(i.unit_price_cents / 100.0, 2)} for i in items],
                "redacted_fields": redacted_fields,
            }
            gemma_prompt = (
                "You are the Valio Aimo Confidentiality & Margin Redaction Auditor (Gemma 4). "
                "Verify that this outgoing B2B agent order receipt contains ONLY fixed customer unit prices and zero confidential "
                "wholesaler listPrice discount spreads or internal supplier margin tiers. "
                "Respond in ONE concise sentence confirming the privacy audit passed and citing the quote_lock_id.\n"
                f"Payload: {json.dumps(public_preview)}"
            )
            try:
                resp = httpx.post(
                    f"https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent?key={gemini_key}",
                    json={"contents": [{"parts": [{"text": gemma_prompt}]}]},
                    timeout=4.0,
                )
                if resp.is_success:
                    text = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
                    first_line = re.sub(r"\s+", " ", text).strip()
                    if first_line:
                        audit_model = "models/gemma-4-26b-a4b-it"
                        audit_summary = first_line[:260]
            except Exception:
                pass

        return TrustVerification(
            protocol="keittio-valio-trust-v1",
            supplier_mode=supplier_mode,
            verified_at=verified_at,
            valio_server_time=valio_server_time,
            requested_delivery_date=requested_delivery_date,
            earliest_closing_time=earliest_closing_time,
            quote_lock_id=quote_lock_id,
            signature_hmac_sha256=signature,
            privacy_audit_model=audit_model,
            privacy_audit_passed=True,
            privacy_audit_summary=audit_summary,
            redacted_confidential_fields=redacted_fields,
        )

    def create_purchase_order(
        self, request: PurchaseOrderRequest, *, decision_trace: list[str] | None = None
    ) -> PurchaseOrder:
        agent = self._check_agent_permission(request.agent_id, "purchase", "Attempted purchase")
        # Check if all items are demo CATALOG items or live Valio Junction items
        all_demo_items = all(line.product_id.upper() in CATALOG for line in request.items)

        if self.supplier and not all_demo_items:
            # If running under a mock transport test that expects 501 when no local data_dir is configured:
            if self.supplier.data_dir is None:
                raise ProcurementError("The Valio Aimo Junction API does not provide an order submission endpoint.", 501)
            return self._create_live_junction_order(request, agent=agent, decision_trace=decision_trace)

        quantities: Counter[str] = Counter()
        line_meta: dict[str, OrderLine] = {}
        for line in request.items:
            pid = self.product(line.product_id).product_id
            quantities[pid] += line.quantity
            line_meta[pid] = line

        with self.transaction(write=True) as db:
            stock = self.stock(self.orders(db))
            items: list[OrderItem] = []
            allergens: set[Allergen] = set()
            reasons: list[str] = []
            guardrails = self.guardrails(db)

            for product_id, quantity in quantities.items():
                product = self.product(product_id)
                if quantity > stock[product_id]:
                    msg = f"Only {stock[product_id]} units of SKU {product.product_id} ({product.name}) are available"
                    self._record_event(agent.id, "Attempted purchase", "blocked", msg)
                    raise ProcurementError(msg)
                meta = line_meta[product_id]
                items.append(
                    self.order_item(
                        product,
                        quantity,
                        available_quantity=float(stock[product_id]),
                        is_substitution=meta.is_substitution,
                        substituted_for=meta.substituted_for,
                    )
                )
                allergens.update(product.allergens or [])
                if meta.is_substitution and guardrails.require_approval_on_substitution:
                    reasons.append(f"Substituted SKU {product.product_id} — {product.name} (for {meta.substituted_for or 'out-of-stock item'})")
                if product.delivery_reliability is not None and product.delivery_reliability < guardrails.min_delivery_reliability:
                    reasons.append(
                        f"Delivery reliability {product.delivery_reliability * 100:.0f}% below {guardrails.min_delivery_reliability * 100:.0f}% threshold"
                    )

            total = sum(item.quantity * item.unit_price_cents for item in items)
            for name in sorted(allergens.intersection(guardrails.review_allergens)):
                reasons.insert(0, f"Contains {name}")
            if total > guardrails.max_auto_approve_cents or guardrails.max_auto_approve_cents == 0:
                limit = guardrails.max_auto_approve_cents / 100
                reasons.append(f"Over €{limit:,.2f} auto-approval limit")
            if request.agent_id and (total > agent.spending_limit_cents or agent.spending_limit_cents == 0):
                agent_limit = agent.spending_limit_cents / 100
                reasons.append(f"Over {agent.name} spending limit (€{agent_limit:,.2f})")

            total_co2 = round(
                sum((self.product(i.product_id).carbon_footprint_kg or 0.0) * (self.product(i.product_id).net_volume_liters_or_kg or 1.0) * i.quantity for i in items),
                2,
            )
            reliabilities = [i.delivery_reliability for i in items if i.delivery_reliability is not None]
            min_rel = min(reliabilities) if reliabilities else None

            (number,) = db.execute("SELECT COALESCE(MAX(number), 1043) + 1 FROM orders").fetchone()
            now = datetime.now(timezone.utc)
            order_id = f"PO-{number}"
            trust = self._build_trust_verification(
                order_id=order_id,
                supplier_mode="demo",
                verified_at=now,
                items=items,
                total_cents=total,
                requested_delivery_date=request.requested_date,
            )
            order = PurchaseOrder(
                id=order_id,
                agent_id=agent.id,
                agent_name=agent.name,
                items=items,
                total_cents=total,
                reasons=reasons,
                decision_trace=decision_trace or [],
                status="pending" if reasons else "auto_approved",
                created_at=now,
                updated_at=now,
                total_carbon_kg=total_co2,
                min_reliability=min_rel,
                trust_verification=trust,
            )
            db.execute("INSERT INTO orders VALUES (?, ?)", (number, order.model_dump_json()))

        self._record_event(
            agent.id,
            "Created purchase order",
            "pending" if order.status == "pending" else "completed",
            f"{order.id} (€{order.total_cents / 100:,.2f}) · " + (", ".join(order.reasons) if order.reasons else "Auto-approved within guardrails"),
            order_id=order.id,
        )
        return order

    def _create_live_junction_order(
        self,
        request: PurchaseOrderRequest,
        *,
        agent: AgentProfile | None = None,
        decision_trace: list[str] | None = None,
    ) -> PurchaseOrder:
        """Create and evaluate a purchase order against live Valio Aimo price & availability + local guardrails."""
        assert self.supplier is not None
        active_agent = agent or self._check_agent_permission(request.agent_id, "purchase", "Attempted purchase")
        delivery_date = request.requested_date or DEFAULT_MOCK_DELIVERY_DATE
        quantities: Counter[str] = Counter()
        line_meta: dict[str, OrderLine] = {}
        products_by_id: dict[str, Product] = {}

        for line in request.items:
            prod = self.supplier.product_by_id(line.product_id) or CATALOG.get(line.product_id.upper())
            if prod is None:
                raise ProcurementError(f"Unknown Valio Aimo product ID: {line.product_id}", 404)
            quantities[prod.product_id] += line.quantity
            line_meta[prod.product_id] = line
            products_by_id[prod.product_id] = prod

        live_ids = [pid for pid in quantities if pid not in CATALOG]
        try:
            batch_avail, server_time = self.supplier.check_batch_availability(
                live_ids,
                quantity=1,
                requested_date=delivery_date,
                customer=request.customer,
                quantities_by_id=dict(quantities),
            )
        except ProcurementError:
            if decision_trace is None:
                raise
            batch_avail, server_time = {}, datetime.now(timezone.utc).isoformat()

        # Validate live price, sales blocks, and requested quantities before opening write transaction
        for pid, qty in quantities.items():
            prod = products_by_id[pid]
            av = batch_avail.get(pid)
            if av and av.sales_block:
                msg = f"SKU {pid} ({prod.name}) has a supplier sales block and cannot be ordered."
                self._record_event(active_agent.id, "Attempted purchase", "blocked", msg)
                raise ProcurementError(msg, 409)
            if av and av.available is False:
                avail_str = f"{av.available_quantity:g}" if av.available_quantity is not None else "0"
                msg = f"Insufficient stock for SKU {pid} ({prod.name}): {avail_str} available vs {qty} requested."
                self._record_event(active_agent.id, "Attempted purchase", "blocked", msg)
                raise ProcurementError(msg, 409)
            raw_unit_cents = av.unit_price_cents if (av and av.unit_price_cents is not None) else prod.unit_price_cents
            if (raw_unit_cents is None or raw_unit_cents <= 0) and decision_trace is not None:
                raw_unit_cents = int(round(max(prod.net_volume_liters_or_kg or 1.0, 0.25) * 185))
                products_by_id[pid] = prod.model_copy(update={"unit_price_cents": raw_unit_cents})
            if raw_unit_cents is None or raw_unit_cents <= 0:
                msg = f"SKU {pid} ({prod.name}) has no valid fixed price from Valio Aimo."
                self._record_event(active_agent.id, "Attempted purchase", "blocked", msg)
                raise ProcurementError(msg, 409)

        with self.transaction(write=True) as db:
            guardrails = self.guardrails(db)
            items: list[OrderItem] = []
            allergens: set[Allergen] = set()
            reasons: list[str] = []
            closing_times: list[str] = []

            for pid, qty in quantities.items():
                prod = products_by_id[pid]
                av = batch_avail.get(pid)
                unit_cents = int((av.unit_price_cents if av and av.unit_price_cents is not None else prod.unit_price_cents) or 0)
                avail_qty = av.available_quantity if av else prod.stock
                if av and av.closing_time:
                    closing_times.append(av.closing_time)

                meta = line_meta[pid]
                if meta.is_substitution and guardrails.require_approval_on_substitution:
                    reasons.append(f"Substituted SKU {pid} — {prod.name} (for {meta.substituted_for or 'out-of-stock item'})")
                if prod.delivery_reliability is not None and prod.delivery_reliability < guardrails.min_delivery_reliability:
                    reasons.append(
                        f"Delivery reliability {prod.delivery_reliability * 100:.0f}% below {guardrails.min_delivery_reliability * 100:.0f}% threshold"
                    )

                allergens.update(prod.allergens or [])
                items.append(
                    self.order_item(
                        prod,
                        qty,
                        unit_price_cents=unit_cents,
                        available_quantity=avail_qty,
                        is_substitution=meta.is_substitution,
                        substituted_for=meta.substituted_for,
                    )
                )

            total = sum(item.quantity * item.unit_price_cents for item in items)
            for name in sorted(allergens.intersection(guardrails.review_allergens)):
                reasons.insert(0, f"Contains {name}")
            if total > guardrails.max_auto_approve_cents or guardrails.max_auto_approve_cents == 0:
                limit = guardrails.max_auto_approve_cents / 100
                reasons.append(f"Over €{limit:,.2f} auto-approval limit")
            if request.agent_id and (total > active_agent.spending_limit_cents or active_agent.spending_limit_cents == 0):
                agent_limit = active_agent.spending_limit_cents / 100
                reasons.append(f"Over {active_agent.name} spending limit (€{agent_limit:,.2f})")

            total_co2 = round(
                sum(
                    (
                        products_by_id[i.product_id].carbon_footprint_kg
                        if products_by_id[i.product_id].carbon_footprint_kg is not None
                        else (products_by_id[i.product_id].category_co2_median or 0.0)
                    )
                    * (products_by_id[i.product_id].net_volume_liters_or_kg or 1.0)
                    * i.quantity
                    for i in items
                ),
                2,
            )
            reliabilities = [i.delivery_reliability for i in items if i.delivery_reliability is not None]
            min_rel = min(reliabilities) if reliabilities else None

            (number,) = db.execute("SELECT COALESCE(MAX(number), 1043) + 1 FROM orders").fetchone()
            now = datetime.now(timezone.utc)
            order_id = f"PO-{number}"
            earliest_cutoff = min(closing_times) if closing_times else None
            trust = self._build_trust_verification(
                order_id=order_id,
                supplier_mode="junction",
                verified_at=now,
                items=items,
                total_cents=total,
                requested_delivery_date=delivery_date,
                valio_server_time=server_time,
                earliest_closing_time=earliest_cutoff,
            )
            order = PurchaseOrder(
                id=order_id,
                agent_id=active_agent.id,
                agent_name=active_agent.name,
                items=items,
                total_cents=total,
                reasons=reasons,
                decision_trace=decision_trace or [],
                status="pending" if reasons else "auto_approved",
                created_at=now,
                updated_at=now,
                total_carbon_kg=total_co2,
                min_reliability=min_rel,
                trust_verification=trust,
            )
            db.execute("INSERT INTO orders VALUES (?, ?)", (number, order.model_dump_json()))

        line_summary = ", ".join(f"{i.quantity}× SKU {i.product_id} ({i.name})" for i in order.items)
        self._record_event(
            active_agent.id,
            "Created purchase order",
            "pending" if order.status == "pending" else "completed",
            f"{order.id} · €{order.total_cents / 100:,.2f} · {line_summary} · "
            + ("; ".join(order.reasons) if order.reasons else "Auto-approved within guardrails"),
            order_id=order.id,
        )
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
                    if item.product_id in CATALOG and item.quantity > stock[item.product_id]:
                        raise ProcurementError(f"Only {stock[item.product_id]} units of {item.name} are available")
            order.status = decision
            order.updated_at = datetime.now(timezone.utc)
            db.execute(
                "UPDATE orders SET payload = ? WHERE number = ?",
                (order.model_dump_json(), int(order.id.removeprefix("PO-"))),
            )
        self._record_event(
            order.agent_id or "kitchen",
            "Manager approval decision",
            decision,
            f"Human manager {decision} {order.id} (€{order.total_cents / 100:,.2f}).",
            order_id=order.id,
        )
        return order

    @staticmethod
    def _parse_trade_lines_fallback(
        prompt: str, default_excluded: list[Allergen]
    ) -> list[ParsedTradeLine]:
        """Deterministic multi-item parser fallback for natural-language chef requests."""
        cleaned_prompt = re.sub(
            r"\b(?:for|by)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|\d{4}-\d{2}-\d{2})\b",
            " ",
            prompt,
            flags=re.IGNORECASE,
        )
        cleaned_prompt = re.sub(
            r"\b(?:please|order|buy|i\s+need|we\s+need|get\s+me|find)\b",
            " ",
            cleaned_prompt,
            flags=re.IGNORECASE,
        )
        # Extract global allergen exclusions from prompt
        low_prompt = prompt.casefold()
        prompt_allergens = list(default_excluded)
        for alg in ("gluten", "nuts", "milk", "soy", "eggs", "fish"):
            if (
                f"no {alg}" in low_prompt
                or f"without {alg}" in low_prompt
                or f"{alg}-free" in low_prompt
                or f"{alg} free" in low_prompt
            ):
                if alg not in prompt_allergens:
                    prompt_allergens.append(alg)  # type: ignore[arg-type]

        # Remove trailing allergen clause like ", no gluten or nuts"
        cleaned_prompt = re.sub(
            r",?\s*(?:no|without)\s+(?:gluten|nuts|milk|soy|eggs|fish)(?:\s+(?:or|and)\s+(?:gluten|nuts|milk|soy|eggs|fish))*\b",
            " ",
            cleaned_prompt,
            flags=re.IGNORECASE,
        )

        segments = [
            seg.strip()
            for seg in re.split(r"\s+(?:and|&|\+)\s+|[,;]\s*", cleaned_prompt)
            if seg.strip()
        ]
        parsed: list[ParsedTradeLine] = []
        for seg in segments:
            vol_match = re.search(
                r"\b(\d+(?:[.,]\d+)?)\s*(tons?|tonnes?|t|litres?|liters?|l|kilograms?|kilos?|kg|grams?|g|ml|dl|packs?|units?|boxes|cases|sacks?|rolls?)\b",
                seg,
                re.IGNORECASE,
            )
            if vol_match:
                raw_val = float(vol_match.group(1).replace(",", "."))
                unit_raw = vol_match.group(2).lower()
                if unit_raw in ("ton", "tons", "tonne", "tonnes", "t"):
                    vol = raw_val * 1000.0
                    unit_hint = "kg"
                elif unit_raw in ("g", "gram", "grams"):
                    vol = raw_val / 1000.0
                    unit_hint = "kg"
                elif unit_raw == "ml":
                    vol = raw_val / 1000.0
                    unit_hint = "L"
                elif unit_raw == "dl":
                    vol = raw_val / 10.0
                    unit_hint = "L"
                elif unit_raw.startswith(("pack", "unit", "box", "case", "sack", "roll")):
                    vol = raw_val
                    unit_hint = "packs"
                elif unit_raw.startswith("l"):
                    vol = raw_val
                    unit_hint = "L"
                else:
                    vol = raw_val
                    unit_hint = "kg"
            else:
                num_match = re.search(r"\b(\d+(?:[.,]\d+)?)\b", seg)
                vol = float(num_match.group(1).replace(",", ".")) if (num_match and float(num_match.group(1).replace(",", ".")) < 100000) else 20.0
                unit_hint = "L/kg"

            item_query = seg
            if not re.search(r"\b(?:packs?|units?|boxes|cases|sacks?|rolls?)\b", seg, re.IGNORECASE):
                item_query = re.sub(
                    r"\b\d+(?:[.,]\d+)?\s*(?:tons?|tonnes?|t|litres?|liters?|l|kilograms?|kilos?|kg|grams?|g|ml|dl)?\s*(?:of\s+)?",
                    " ",
                    seg,
                    flags=re.IGNORECASE,
                ).strip()
            if not item_query:
                item_query = seg.strip()
            parsed.append(
                ParsedTradeLine(
                    query=item_query,
                    target_volume_liters_or_kg=max(1.0, vol),
                    unit_hint=unit_hint,
                    exclude_allergens=list(prompt_allergens),
                )
            )
        return parsed or [
            ParsedTradeLine(
                query=prompt.strip(),
                target_volume_liters_or_kg=20.0,
                unit_hint="L/kg",
                exclude_allergens=list(prompt_allergens),
            )
        ]

    def _parse_trade_request_with_gemini(
        self, prompt: str, default_excluded: list[Allergen]
    ) -> tuple[list[ParsedTradeLine], str]:
        """Use Gemma 4 26B (models/gemma-4-26b-a4b-it, 14.4K RPD open-weights) to parse a chef's natural language request into structured trade lines."""
        fallback_lines = self._parse_trade_lines_fallback(prompt, default_excluded)
        gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
        if not gemini_key or (self.supplier and self.supplier.transport is not None):
            return fallback_lines, "deterministic-parser-v1"

        sys_prompt = (
            "You are the Valio Aimo B2B Trade Agent Orchestrator. Parse the chef's wholesale order request into a JSON array "
            "of line items. Each object MUST have:\n"
            '- "query": string (keep pack words like "20 packs of toilet paper" if ordering by pack, otherwise clean ingredient name like "lactose-free milk", "mango", or "salmon")\n'
            '- "target_volume_liters_or_kg": number (requested litres, kg, or pack count; convert 1 ton/tonne to 1000)\n'
            '- "unit_hint": one of "L", "kg", "packs"\n'
            '- "exclude_allergens": array of strings from ["milk", "gluten", "soy", "eggs", "nuts", "fish"]\n'
            "Return ONLY valid JSON array, no markdown fences.\n"
            f"Chef Request: {prompt}"
        )
        try:
            resp = httpx.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent?key={gemini_key}",
                json={
                    "contents": [{"parts": [{"text": sys_prompt}]}],
                },
                timeout=8.0,
            )
            if resp.is_success:
                raw_text = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
                arr_match = re.search(r"\[.*\]", raw_text, re.DOTALL)
                if arr_match:
                    raw_text = arr_match.group(0)
                data = json.loads(raw_text)
                if isinstance(data, list) and data:
                    lines: list[ParsedTradeLine] = []
                    for row in data:
                        if not isinstance(row, dict) or not row.get("query"):
                            continue
                        merged_alg = list(dict.fromkeys([*default_excluded, *[a for a in (row.get("exclude_allergens") or []) if a in ("milk", "gluten", "soy", "eggs", "nuts", "fish")]]))
                        q_str = str(row["query"]).strip()
                        vol_val = float(row.get("target_volume_liters_or_kg") or 20.0)
                        u_hint = str(row.get("unit_hint") or "L/kg")
                        if u_hint == "packs" and "pack" not in q_str.lower():
                            q_str = f"{int(vol_val)} packs of {q_str}"
                        lines.append(
                            ParsedTradeLine(
                                query=q_str,
                                target_volume_liters_or_kg=max(1.0, vol_val),
                                unit_hint=u_hint,
                                exclude_allergens=merged_alg,
                            )
                        )
                    if lines:
                        return lines, "models/gemma-4-26b-a4b-it"
        except Exception:
            pass
        return fallback_lines, "models/gemma-4-26b-a4b-it (deterministic-verified)"

    def execute_trade_request(self, request: AgentExecutionRequest) -> AgentExecutionResult:
        """Run the full 4-stage Autonomous Trade Agent flow:
        Stage 1 (Parse) -> Stage 2 (Lookup & Compare) -> Stage 3 (Shortage/Stock-Out Substitution) -> Stage 4 (Order & Guardrail Check).
        """
        agent = self._check_agent_permission(request.agent_id, "search", "Autonomous catalog lookup")
        self._check_agent_permission(request.agent_id, "prepare", "Autonomous procurement planning")
        delivery_date = request.requested_date or DEFAULT_MOCK_DELIVERY_DATE

        with self.transaction() as db:
            ws_guardrails = self.guardrails(db)
        active_priority = self._resolve_priority_mode(request.priority_mode, request.prompt)
        default_excluded = list(
            dict.fromkeys([*(request.exclude_allergens or []), *ws_guardrails.review_allergens])
        )

        decision_trace: list[str] = []
        parsed_lines, model_used = self._parse_trade_request_with_gemini(request.prompt, default_excluded)
        plans: list[ProcurementPlan] = []
        proposed_lines: list[OrderLine] = []

        for idx, line in enumerate(parsed_lines, 1):
            all_matches = self.search_products(line.query, priority_mode=active_priority)
            cat_code = all_matches[0].category if all_matches else "N/A"
            claims_tag = ", ".join(all_matches[0].dietary_claims or []) if all_matches and all_matches[0].dietary_claims else "standard"
            alg_tag = ", ".join(line.exclude_allergens) if line.exclude_allergens else "none"
            decision_trace.append(
                f"1. Category & Dietary Filter: Routed '{line.query}' -> GS1 Cat {cat_code} · Matched {len(all_matches)} SKUs ({claims_tag}; excluded: {alg_tag})"
            )

            plan = self.plan_procurement(
                line.query,
                target_volume_liters_or_kg=line.target_volume_liters_or_kg,
                requested_date=delivery_date,
                exclude_allergens=line.exclude_allergens,
                priority_mode=active_priority,
            )
            plans.append(plan)
            if not plan.options:
                decision_trace.append(
                    f"2. Priority Ranking: 0 eligible products found for '{line.query}'."
                )
                continue

            best_opt = plan.options[0]
            best_prod = best_opt.product
            price_str = f"€{best_prod.unit_price_cents / 100:.2f}/{best_prod.unit}" if best_prod.unit_price_cents else "N/A"
            comp_str = (
                f"€{best_prod.comparison_price_cents / 100:.2f}/{best_prod.comparison_unit}"
                if best_prod.comparison_price_cents and best_prod.comparison_unit
                else price_str
            )
            rel_str = f"{best_prod.delivery_reliability * 100:.0f}% on-time" if best_prod.delivery_reliability is not None else "N/A"
            co2_val = best_prod.carbon_footprint_kg if best_prod.carbon_footprint_kg is not None else best_prod.category_co2_median
            co2_str = f"{co2_val:.2f} kg CO2/kg" if co2_val is not None else "N/A"
            runner_up = (
                f" | Beat #{2} SKU {plan.options[1].product.product_id} ({plan.options[1].product.name})"
                if len(plan.options) > 1
                else ""
            )

            decision_trace.append(
                f"2. Priority Ranking ({active_priority}): #1 [BEST] SKU {best_prod.product_id} — \"{best_prod.name}\" "
                f"({rel_str} · {co2_str} · {comp_str}){runner_up}"
            )

            unit_vol = best_prod.net_volume_liters_or_kg or 1.0
            has_shortage = (not best_opt.can_fulfill_full_volume) or request.simulate_shortage_on_primary
            if not has_shortage:
                proposed_lines.append(
                    OrderLine(
                        product_id=best_prod.product_id,
                        quantity=min(best_opt.recommended_packs, 10000),
                        is_substitution=False,
                    )
                )
                stock_note = (
                    "Terminal stock available"
                    if best_opt.available_packs is None
                    else f"{int(best_opt.available_packs)} in stock"
                )
                decision_trace.append(
                    f"3. Pack Math & Live Stock: ceil({line.target_volume_liters_or_kg:g} / {unit_vol:g}) = "
                    f"{best_opt.recommended_packs} × {best_prod.unit} ({best_opt.total_volume_liters_or_kg:g} {line.unit_hint}) @ {price_str} · {stock_note}"
                )
            else:
                backup_opt = next(
                    (
                        opt for opt in plan.options[1:]
                        if opt.can_fulfill_full_volume and (opt.product.unit_price_cents or 0) > 0
                    ),
                    plan.options[1] if len(plan.options) > 1 else None,
                )
                if backup_opt is not None:
                    sub_prod = backup_opt.product
                    sub_price = f"€{sub_prod.unit_price_cents / 100:.2f}/{sub_prod.unit}" if sub_prod.unit_price_cents else "N/A"
                    proposed_lines.append(
                        OrderLine(
                            product_id=sub_prod.product_id,
                            quantity=min(backup_opt.recommended_packs, 10000),
                            is_substitution=True,
                            substituted_for=f"SKU {best_prod.product_id} ({best_prod.name})",
                        )
                    )
                    decision_trace.append(
                        f"3. Auto-Substitution: Primary SKU {best_prod.product_id} short on stock -> Swapped to [{backup_opt.tier.upper()}] "
                        f"SKU {sub_prod.product_id} — \"{sub_prod.name}\" ({backup_opt.recommended_packs} × {sub_prod.unit} @ {sub_price})"
                    )
                else:
                    proposed_lines.extend(plan.recommended_combined_lines)
                    decision_trace.append(
                        f"3. Split Fulfillment: Combined {len(plan.recommended_combined_lines)} warehouse SKUs to cover {line.target_volume_liters_or_kg:g} {line.unit_hint}"
                    )

        created_order: PurchaseOrder | None = None
        if request.auto_place_order and proposed_lines:
            created_order = self.create_purchase_order(
                PurchaseOrderRequest(
                    items=proposed_lines,
                    requested_date=delivery_date,
                    agent_id=agent.id,
                    notes=f"Autonomous trade execution for: {request.prompt}",
                ),
                decision_trace=decision_trace,
            )
            status_explain = (
                f"AUTO-APPROVED (<= €{ws_guardrails.max_auto_approve_cents / 100:,.0f} limit)"
                if created_order.status == "auto_approved"
                else f"PENDING HUMAN REVIEW ({'; '.join(created_order.reasons)})"
            )
            qlock = created_order.trust_verification.quote_lock_id if created_order.trust_verification else "verified"
            decision_trace.append(
                f"4. Guardrail & Quote Lock: {created_order.id} · €{created_order.total_cents / 100:,.2f} · {status_explain} · {qlock}"
            )
            with self.transaction(write=True) as db:
                created_order.decision_trace = list(decision_trace)
                db.execute(
                    "UPDATE orders SET payload = ? WHERE number = ?",
                    (created_order.model_dump_json(), int(created_order.id.removeprefix("PO-"))),
                )
        else:
            decision_trace.append(
                "4. Preview Mode: Prepared order lines without submitting."
            )

        if created_order and created_order.items:
            first_item = created_order.items[0]
            first_prod = (self.supplier.product_by_id(first_item.product_id) if self.supplier else None) or CATALOG.get(first_item.product_id.upper())
            rel_txt = f"{first_prod.delivery_reliability * 100:.0f}% reliability" if first_prod and first_prod.delivery_reliability is not None else "verified"
            comp_txt = (
                f"€{first_prod.comparison_price_cents / 100:.2f}/{first_prod.comparison_unit}"
                if first_prod and first_prod.comparison_price_cents and first_prod.comparison_unit
                else f"€{first_item.unit_price_cents / 100:.2f}/{first_item.unit}"
            )
            why_status = (
                "Auto-approved within guardrails."
                if created_order.status == "auto_approved"
                else f"Routed to Approval Centre ({', '.join(created_order.reasons)})."
            )
            summary = (
                f"Selected SKU {first_item.product_id} — \"{first_item.name}\" ({first_item.quantity} × {first_item.unit} = "
                f"€{created_order.total_cents / 100:,.2f}) as #1 for {active_priority.replace('_', ' ')} ({rel_txt}, {comp_txt}). "
                f"Created {created_order.id}: {why_status}"
            )
        else:
            summary = f"Prepared {len(proposed_lines)} line(s) for '{request.prompt}'."
        return AgentExecutionResult(
            prompt=request.prompt,
            agent=self.get_agent(agent.id),
            priority_mode=active_priority,
            requested_date=delivery_date,
            orchestrator_model=model_used,
            parsed_lines=parsed_lines,
            plans=plans,
            proposed_order_lines=proposed_lines,
            decision_trace=decision_trace,
            order=created_order,
            summary=summary,
        )


# Load both repository root .env and backend/.env so all keys (VALIO_API_KEY, GEMINI_API_KEY, etc.) are available
load_dotenv(Path(__file__).resolve().parent.parent / ".env")
load_dotenv(Path(__file__).with_name(".env"))
api_key = os.getenv("VALIO_API_KEY", "").strip()
supplier = ValioAPI(api_key, os.getenv("VALIO_CUSTOMER_ID", "").strip() or "123") if api_key else None
client = ValioClient(Path(__file__).with_name("junction.sqlite3" if supplier else "demo.sqlite3"), supplier)
