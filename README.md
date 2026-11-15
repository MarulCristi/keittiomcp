# KeittiöMCP — Trusted Trade Agents for Valio Aimo®

> **Junction 2026 · Valio Aimo "Trusted Trade Agents" Challenge**  
> An open, verifiable **Model Context Protocol (MCP)** gateway, multi-agent policy engine, and autonomous kitchen purchasing workspace connecting buyers to **17,546 Valio Aimo SKUs across 349 GS1 categories** — comparing live stock & fixed prices, executing allergen-safe substitutions, and issuing cryptographically attested B2B orders without exposing confidential wholesale margins or internal systems.

---

## Architecture & Core Components

```text
+-----------------------------------------------------------------------------+
|                    External AI Agents & Professional Kitchens                |
|      MCP Clients (Claude / Cursor / Agents)   |   Next.js Control UI (:3000)|
+-----------------------+-----------------------+--------------+--------------+
                        | Streamable HTTP / stdio (/mcp)       | REST (/api/*)
                        v                                      v
+-----------------------------------------------------------------------------+
|                    KeittiöMCP Gateway (FastAPI :8000 + FastMCP)             |
|                                                                             |
|  1. Request Parser      -> Gemma 4 26B + deterministic volume/date fallback |
|  2. Catalog & Ranking   -> Strict GS1 category routing + Top 3 G/B/B scorer |
|  3. Exception Engine    -> Live batch stock check + swap / split planner    |
|  4. 3-Agent RBAC        -> Kitchen Assistant · Inventory Agent · Purchasing |
|  5. Trust & Guardrails  -> Approval Centre + HMAC-SHA256 Quote Lock + Gemma |
+-----------------------+--------------------------------------+--------------+
                        | Local Enriched Dataset               | Live HTTPS Batch API
                        v                                      v
+---------------------------------------+  +----------------------------------+
|     Valio Aimo Static Datasets        |  |   Valio Aimo Junction Mock API   |
|  • backend/data/products.json (17,546)|  |  • POST /api/availability        |
|  • delivery_reliability.csv           |  |  • POST /api/price               |
|  • carbon_footprint.csv (349 GS1 cats)|  |  (listPrice & margins redacted)  |
+---------------------------------------+  +----------------------------------+
```

---

## Exact Algorithm: How KeittiöMCP Works Under the Hood

Every request (`POST /api/agent_execute` or MCP tool `execute_trade_request`) runs through a deterministic 6-stage pipeline stored and audited in SQLite (`backend/junction.sqlite3`, or `backend/demo.sqlite3` when no `VALIO_API_KEY` is set):

### Step 0 — Synkka Catalog Enrichment (`ValioAPI._load_or_download_catalog`)
1. Loads **17,546** products from `backend/data/products.json` (or downloads `/api/products/download` when local data is absent).
2. Joins `delivery_reliability.csv` and `carbon_footprint.csv`, then computes per-category (`min`, `max`, `median` across **349 GS1 categories**) and 3-digit category-family carbon benchmarks. Each SKU receives a quartile standing badge (`Low-carbon top quartile`, `At/below category median`, or `Above category median`).
3. Extracts exact **net volume/weight per sales unit** (`_extract_volume_and_unit`):
   - Priority 1: `salesUnit` is literally `KG` or `L`/`LTR` (`1.0`).
   - Priority 2: `synkkaData.unitConversions[].netWeight` or `volume` (scaled by `sizeInBaseUnits` when `salesUnit != baseUnit` and packaging is not `CASE`).
   - Priority 3: Product title unit regex fallback.
4. Normalizes **allergens & dietary claims** from GS1 Synkka codes (`GS1_ALLERGEN_MAP`: milk, gluten, eggs, soy, nuts, fish) **plus** Finnish/English ingredient-list text scanning (`_detect_ingredient_allergens`) so unlisted allergens in `ingredients_text` are never missed.
5. Extracts certificates (`Hyvää Suomesta`, `Avainlippu`, `EU Organic`, `MSC`, etc.), explicit supplier substitutions (`substitutions[]`), and full ingredient descriptions.

### Step 1 — Quantity Normalization & Intent Parsing (`_parse_trade_request_with_gemini`)
1. `_normalize_quantity_numbers` normalizes grouped thousands (`4,000` → `4000`, `4.000,5` → `4000.5`) and decimal commas (`4,5` → `4.5`) before comma line-splitting while preserving dates and numeric SKUs.
2. Uses **Gemma 4 26B (`models/gemma-4-26b-a4b-it`, 2.5s timeout)** to extract structured order lines (`query`, `target_volume_liters_or_kg`, `unit_hint`, `exclude_allergens`), falling back immediately to `_parse_trade_lines_fallback` (supporting `tons`/`tonnes × 1000`, `g`/`ml`/`dl`, `packs`/`cases`, and multi-item prompts separated by `and`, `&`, `+`, `,`, `;`).

### Step 2 — Strict GS1 Category Routing & Priority Scoring (`_run_catalog_search` + `_rank_substitutes_good_better_best`)
1. `_normalize_query_terms` strips interchangeable hyphens, maps culinary synonyms (`CULINARY_PHRASE_SYNONYMS`, e.g., `"bell pepper"` → `"paprika"`), and stems English plurals (`"tomatoes"` → `"tomato"`). If 0 hits occur, `_translate_query_with_gemini` optionally translates uncommon culinary phrases into Finnish/EU keywords.
2. `_resolve_target_categories` enforces a **strict GS1 Category Lock** (`DISH_CATEGORY_ROUTES` checked first, then `INGREDIENT_CATEGORY_ROUTES`). Asking for `"milk"` or `"tomato"` locks to dairy/fresh-produce categories so processed dishes, soups, or desserts never pollute results.
3. Enforces **hard allergen & dietary exclusions**: removes any item matching workspace `review_allergens` or prompt allergens (`lactose_free`, `vegan`, `gluten_free`, `milk_free`). If every catalog match was blocked by allergen rules, `blocked_allergen_matches` returns the exact rejected SKUs and triggering allergens.
4. Ranks safe candidates using an identical foundational base tuple across **every** priority mode before applying the kitchen's selected optimization weights:
   - **Uniform Base Tuple (`rank_key`):**
     1. Exact SKU ID match
     2. In stock (`stock is None or stock > 0`)
     3. Variety penalty (`_compute_variety_penalty`: Class-1 fresh whole items `0` ahead of ungraded `1`, pre-cut `2`, canned/specialty `3`)
     4. Purity tier (`_compute_purity_tier`: pure single ingredient `0`, standard `1`, processed patty/pie/soup `2`)
     5. Whole-word token match
     6. Required dietary claim count
   - **Priority Modes (`priority_mode` / multi-select `priority_modes`):**
     - `balanced`: normalized `0.40 × reliability + 0.35 × carbon + 0.25 × price`
     - `low_carbon`: lowest `carbon_footprint_kg` + sustainability certificates
     - `lowest_price`: lowest live `comparison_price_cents` (€/L or €/kg)
     - `authentic_finnish`: Finnish origin (`FI`) + `Hyvää Suomesta` / `Avainlippu` certificates first
     - `highest_reliability`: highest historical on-time delivery rate
     - When multiple priorities are active simultaneously, normalized mode scores are blended with weights `1.0 - 0.05 × rank_index`.
5. Assigns Top 3 **Good–Better–Best** tiers (`best`, `better`, `good`) to the top options.

### Step 3 — Live Valio Batch Lookup, Pack Math & Auto-Substitution (`plan_procurement`)
1. Calls `ValioAPI.check_batch_availability` (`POST /api/availability` & `POST /api/price`, 8s timeout, short rate-limit guard) in a single batch for the top 12 candidates to fetch live customer tax-inclusive prices, `closingTime`, `salesBlock`, and live warehouse stock.
2. Values where `availableAmount >= 999999` represent terminal/direct-delivery supply (`In stock (999,999+ terminal)`). Warehouse SKUs report exact integer counts (`In stock (N packs)` / `Out of stock (0)`).
3. Computes whole-pack math per Valio rules (never ordering fractional `0.01` lot artifacts):
   $$\text{packs\_needed} = \max\left(1, \left\lceil \frac{\text{target\_volume}}{\text{net\_volume\_liters\_or\_kg}} \right\rceil\right)$$
4. **Exception & Substitution Handling:**
   - If the #1 **Best** SKU cannot cover the full volume (`not can_fulfill_full_volume` or simulated stockout), `execute_trade_request` automatically promotes the highest-ranked compliant backup option (`Better` or `Good`) that *can* fulfill the full request.
   - If no single SKU has enough warehouse stock, `recommended_combined_lines` splits the order across multiple compliant SKUs.

### Step 4 — Coordinated 3-Agent Execution & RBAC
Three distinct database-backed agents collaborate on every workflow (configurable live in the **Agents** tab with individual `search` / `prepare` / `purchase` checkboxes, `connected` / `paused` status, and spending limits):
1. **Kitchen Assistant (`kitchen`)** — `search`, `prepare`, `purchase` · default `€500` limit: parses requests, applies dietary/category filters, ranks Top 3 offers, and places standard kitchen orders within its limit.
2. **Inventory Agent (`inventory`)** — `search`, `prepare` · `€0` spend limit (audit-only, cannot spend): performs the **Stock & pack-math audit** on every prepared order, plus **Pre-schedule stock checks** and **Autonomous par-level stock checks** when simulated time advances.
3. **Purchasing Assistant (`purchasing`)** — `search`, `prepare`, `purchase` · default `€2,000` limit: automatically takes over **Delegated bulk orders** exceeding Kitchen Assistant's spending limit and runs recurring scheduled auto-buys.

### Step 5 — Guardrails, Approval Centre & `keittio-valio-trust-v1` Protocol
1. `_create_live_junction_order` evaluates workspace `Guardrails` (`max_auto_approve_cents`, `review_allergens`, `min_delivery_reliability`, `require_approval_on_substitution`) and the executing agent's `spending_limit_cents`.
2. Orders meeting all rules are marked **`auto_approved`**. Orders tripping any rule (over auto-approval limit, over agent limit, contains restricted allergen, low reliability, or auto-substituted SKU) pause in the **Approval Centre** (`pending`) with product photo, capacity breakdown, and explicit audit reasons for manager sign-off (`approved` / `rejected`).
3. `_build_trust_verification` seals every order with a **`keittio-valio-trust-v1`** verification receipt:
   - Deterministic `quote_lock_id` (`QLOCK-PO-XXXX-YYYYMMDD`)
   - **`HMAC-SHA256` signature** over order ID, supplier mode, delivery date, total cents, sorted `SKU:qty:unit_price_cents` lines, and earliest supplier closing time
   - **Gemma 4 26B** privacy redaction audit attesting that `listPrice_discount_spread`, `supplier_margin_tier`, and `internal_vendor_contract` were stripped before leaving Valio Aimo's boundary.

### Step 6 — Recurring Auto-Buys & Simulation Clock (`advance_clock`)
- Schedules created from chat or the Recurring Auto-Buys panel (e.g., `"Every day at 07:00 buy 20 L lactose-free milk"`) run on `Europe/Helsinki` time against a persistent `sim_clock` offset in SQLite.
- Fast-forwarding the **Simulation Clock** jumps through simulated days/hours, automatically slowing near scheduled triggers so `Inventory Agent` pre-checks stock and `Purchasing Assistant` fires real autonomous orders live.

---

## How to Run Locally

Requires **Python 3.11+** and **Node.js 22.12+**.

### 1. Configure Environment (`.env` or `backend/.env`)

Create `.env` in the repository root or `backend/.env`:

```env
# Valio Aimo Junction Mock API credentials
VALIO_API_KEY=junct_...
VALIO_BASE_URL=https://junction26.valioaimo.fi
VALIO_CUSTOMER_ID=123

# Optional: Google AI Studio key for Gemma 4 26B query parsing & privacy attestation
# (If omitted or offline, KeittiöMCP automatically uses deterministic-verified mode)
GEMINI_API_KEY=AIza...
```

### 2. Start the Backend (`http://127.0.0.1:8000`)

Windows PowerShell (from repo root):

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn main:app --reload
```

macOS / Linux (from repo root):

```bash
cd backend
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/uvicorn main:app --reload
```

FastAPI OpenAPI docs run at **`http://127.0.0.1:8000/docs`** and Streamable HTTP MCP runs at **`http://127.0.0.1:8000/mcp`**.

### 3. Start the Frontend (`http://localhost:3000`)

In a second terminal from the repository root:

```powershell
cd frontend
npm ci
npm run dev
```

Open **`http://localhost:3000`**. [next.config.ts](file:///c:/Users/andre/Documents/ChatGPT/keittiomcp/frontend/next.config.ts) proxies all `/api/*` requests directly to `http://127.0.0.1:8000/api/*`.

### 4. CLI Demo & Targeted Verification

Run the interactive terminal demo (`backend/test_demo.py`):

```powershell
backend\.venv\Scripts\python.exe backend/test_demo.py --agent "50kg of dark chocolate"
backend\.venv\Scripts\python.exe backend/test_demo.py --agent "30 L of lactose-free milk for Monday"
backend\.venv\Scripts\python.exe backend/test_demo.py --agent --priority authentic_finnish "15 kg bell pepper"
```

Run fast request-parsing, substitution, and scheduling tests:

```powershell
cd backend
.\.venv\Scripts\python.exe -m unittest test_request_parsing.py -v
```

Typecheck frontend:

```powershell
cd frontend
npm run typecheck
```

---

## REST API & MCP Reference

KeittiöMCP exposes matching tools across **REST** (`/api/*`) and **Model Context Protocol** (`/mcp` Streamable HTTP or `python backend/mcp_server.py` stdio):

| Capability | REST Endpoint | MCP Tool |
| :--- | :--- | :--- |
| **Catalog Search & Priority Rank** | `GET /api/search_products` | `search_products(query, priority_mode)` |
| **Allergen Exclusion Explainability** | `GET /api/blocked_allergen_matches` | — |
| **Live Price & Stock Check** | `GET /api/check_availability` | `check_availability(product_id, quantity, requested_date)` |
| **Good–Better–Best Substitutes** | `GET /api/suggest_substitutes` | `suggest_substitutes(product_id, exclude_allergens, priority_mode)` |
| **Wholesale Volume Planner** | `GET /api/plan_procurement` | `plan_procurement(query, target_volume_liters_or_kg, priority_mode)` |
| **Autonomous 3-Agent Execution** | `POST /api/agent_execute` | `execute_trade_request(prompt, agent_id, priority_mode, auto_place_order)` |
| **Place Purchase Order** | `POST /api/create_purchase_order` | `create_purchase_order(items, requested_date, agent_id)` |
| **Human Manager Approval** | `PATCH /api/orders/{order_id}` | — *(Human Approval Centre action)* |
| **Workspace & Guardrails** | `GET /api/workspace` · `PUT /api/guardrails` | — |
| **3-Agent RBAC & Audit Feed** | `GET /api/agents` · `PUT /api/agents/{id}` · `GET /api/events` | — |
| **Recurring Auto-Buys & Clock** | `GET/POST /api/schedules` · `POST /api/clock/advance` | — |
