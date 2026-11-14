# KeittiöMCP — Trusted Trade Agents for Valio Aimo®

> **Junction 2026 · Valio Aimo "Trusted Trade Agents" Challenge**  
> An open, verifiable **Model Context Protocol (MCP)** gateway, policy guardrail engine, and autonomous purchasing workspace that lets external AI trade agents search **17,546 Valio Aimo products**, compare live fixed prices & stock, optimize for kitchen priorities (carbon footprint, Finnish origin, budget, or delivery reliability), handle stock-out substitutions, and place cryptographically attested B2B orders — **without exposing confidential wholesale margins or internal systems**.

---

## Why KeittiöMCP? (Solving the Valio Aimo Challenge)

As professional kitchens shift from manual webshop browsing to autonomous purchasing agents, wholesalers face an existential question: **how do you let external AI agents discover, compare, and order products in seconds while preserving data ownership, margin confidentiality, and human trust?**

KeittiöMCP prototypes the open operating model between **20,000+ professional kitchens** and **Valio Aimo's backend systems**:

1. **Product, Price & Availability Lookup (`17,546` Live SKUs)**
   - Deterministic **GS1 Category-First Routing** + culinary synonym & plural normalization (`"15 kg bell pepper"` → fresh Class 1 `paprika` in Category `17406`; `"1 ton of mango"` → `1,000 kg` of fresh/frozen mango in `17415`/`41741`, never mango yogurt).
   - Enriches all **17,546 Valio Aimo products** (`products.json`) with historical on-time delivery rates (`delivery_reliability.csv`), product & **349 GS1 category-level CO₂e ranges** (`carbon_footprint.csv`), Synkka allergens, dietary claims (`lactose_free`, `gluten_free`, `vegan`), and Finnish origin / sustainability certificates (`Avainlippu`, `Hyvää Suomesta`, `EU Organic`, `MSC`).
   - Queries Valio Aimo's live Junction API (`POST /api/v1/product-delivery-availability` & `POST /api/v1/product-Price`) in a single batch call for real-time stock, order cut-off timestamps (`closingTime`), and tax-inclusive fixed unit prices.

2. **Kitchen Purchasing Priority Selector (Valio Booth Mode)**
   - Kitchens choose what their trade agent optimizes for across search, substitution, and wholesale volume planning:
     - `balanced` — **Best Overall** (Reliability + Carbon + Price)
     - `low_carbon` — **Lowest Carbon Footprint** (Sustainability First, using SKU & Category CO₂e quartile benchmarks)
     - `lowest_price` — **Lowest Price / Cheapness** (Budget First, ranked by live EUR/kg or EUR/L comparison price)
     - `authentic_finnish` — **Authentic Finnish Origin** (`Kotimainen` / `FI` / `Hyvää Suomesta` Blue Swan / `Avainlippu` Key Flag First)
     - `highest_reliability` — **Highest Delivery Reliability** (100% On-Time First)

3. **Autonomous 4-Stage Trade Agent & Wholesale Volume Planner**
   - Given a natural-language chef request (e.g. `"50 kg salmon and 15 kg tomatoes for Monday, no gluten or nuts"`), the orchestrator (`POST /api/agent_execute` / MCP tool `execute_trade_request`):
     1. **Parses** multi-item volumes (`L`, `kg`, `tons`, `packs`), delivery dates, allergens, and priority hints using open-weights **Gemma 4 26B (`models/gemma-4-26b-a4b-it`)** with a deterministic zero-latency fallback parser.
     2. **Looks up & compares** live Valio Aimo availability and fixed prices, computing exact wholesale pack math (`Carton/PRK`, `Case/KI`, `Tub/RAS`, `Pallet/PAL`) and **Multi-SKU Split Fulfillment** when a single warehouse SKU cannot cover a bulk order.
     3. **Handles exceptions automatically** with a **Good-Better-Best Substitution Engine** if a primary SKU is out of stock or short on quantity.
     4. **Commits or escalates** the purchase order through the Guardrail & Permission Engine.

4. **Per-Agent Permissions & Human-in-the-Loop Guardrails**
   - Role-based permissions (`can_search`, `can_prepare_order`, `can_Auto_purchase`, `spending_limit_cents`) for `Kitchen Agent`, `Inventory Agent`, and `Purchasing Agent`.
   - Orders automatically execute as `auto_approved` when within policy, or route to `pending` human manager approval (`approved` / `rejected`) with explicit audit reasons whenever:
     - Total exceeds the workspace auto-approve limit (e.g. `€250.00`) or the specific agent's spending limit,
     - Any item contains a restricted allergen (`gluten`, `nuts`, `milk`, `soy`, `eggs`, `fish`),
     - Any item's historical delivery reliability falls below the minimum threshold (e.g. `90%`), or
     - An out-of-stock substitution was applied (`require_approval_on_substitution`).

5. **Open Verifiable Trust Protocol (`keittio-valio-trust-v1`) & Confidentiality Filter**
   - Every purchase order generates a tamper-evident **`TrustVerification` receipt** (`quote_lock_id` + **`HMAC-SHA256` signature**) locking the exact SKU quantities, fixed customer unit prices, Valio server timestamp, and order cut-off time.
   - Audited by open-weights **Gemma 4 26B (`models/gemma-4-26b-a4b-it`)** to attest that internal wholesaler `listPrice` discount spreads, supplier margin tiers, and internal vendor contracts are stripped before leaving Valio Aimo's boundary.

---

## Architecture Overview

```text
+-------------------------------------------------------------------------+
|                   External AI Agents & Kitchen Buyers                   |
|   Claude Desktop / Cursor (MCP)   |   Next.js Purchasing Workspace UI   |
+-----------------+-----------------+------------------+------------------+
                  | Streamable HTTP / stdio            | REST (/api/*)
                  v                                    v
+-------------------------------------------------------------------------+
|                    KeittiöMCP Gateway (FastAPI + FastMCP)               |
|  • Category-First Catalog Search & Kitchen Priority Optimizer           |
|  • Good-Better-Best Substitution & Wholesale Volume Split Planner       |
|  • Per-Agent RBAC, Spend/Allergen/Reliability Guardrails & Audit Log    |
|  • keittio-valio-trust-v1 HMAC-SHA256 Quote Lock & Gemma 4 Redaction    |
+-----------------+------------------------------------+------------------+
                  | Local Enrichment                   | Live HTTPS Batch API
                  v                                    v
+-----------------------------------+  +----------------------------------+
|     3 Valio Aimo Static Datasets  |  |   Valio Aimo Junction Live API   |
|  • products.json (17,546 SKUs)    |  |  • /v1/product-delivery-avail... |
|  • delivery_reliability.csv       |  |  • /v1/product-price             |
|  • carbon_footprint.csv (349 cats)|  |  (Confidential listPrice stripped|
+-----------------------------------+  +----------------------------------+
```

---

## Quick Start (Run Locally)

Requires **Python 3.11+** and **Node.js 22.12+**.

### 1. Start the Backend (`localhost:8000`)

From the repository root in PowerShell (Windows):

```powershell
cd backend
python -m venv .venv
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn main:app --reload
```

On macOS / Linux:

```bash
cd backend
python3 -m venv .venv
cp .env.example .env
./.venv/bin/pip install -r requirements.txt
./.venv/bin/uvicorn main:app --reload
```

The FastAPI server and interactive OpenAPI docs listen at **[http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)**.

### 2. Start the Frontend (`localhost:3000`)

In a second terminal from the repository root:

```bash
cd frontend
npm ci
npm run dev
```

Open **[http://localhost:3000](http://localhost:3000)**. Next.js automatically proxies `/api/*` requests to `http://127.0.0.1:8000`.

---

## Interactive CLI Demo (`backend/test_demo.py`)

You can test the entire Valio Aimo engine, Kitchen Priority Selector, Wholesale Volume Planner, and Autonomous Trade Agent directly from your terminal:

### Interactive Valio Booth Mode (Select Kitchen Priority + Live Search & Order)

```powershell
backend\.venv\Scripts\python.exe backend/test_demo.py
```

### One-Line CLI Examples

```powershell
# 1. Autonomous Trade Agent (end-to-end parse -> live Valio lookup -> PO + HMAC-SHA256 Quote Lock)
backend\.venv\Scripts\python.exe backend/test_demo.py --agent "30 L of lactose-free milk for Monday"

# 2. Autonomous Trade Agent with Authentic Finnish Priority (Kotimainen / Hyvää Suomesta first)
backend\.venv\Scripts\python.exe backend/test_demo.py --agent --priority authentic_finnish "15 kg tomatoes"

# 3. Multi-Item Order + Per-Agent Permission & Spending Limit Enforcement Test
backend\.venv\Scripts\python.exe backend/test_demo.py --agent "50 kg salmon and 15 kg tomatoes" --test-permissions

# 4. Bulk Wholesale Volume Planner & Category-First Routing (1 ton = 1,000 kg, 1000 L milk, 20 packs toilet paper)
backend\.venv\Scripts\python.exe backend/test_demo.py "1 ton of mango"
backend\.venv\Scripts\python.exe backend/test_demo.py "1000 litres of lactose-free milk"
backend\.venv\Scripts\python.exe backend/test_demo.py "20 packs of toilet paper"
```

---

## REST API & MCP Tools

KeittiöMCP exposes identical capabilities over **REST** (`http://127.0.0.1:8000/api/*`) and **Model Context Protocol (`MCP`)** (`http://127.0.0.1:8000/mcp` via Streamable HTTP, or `python backend/mcp_server.py` via stdio):

| Capability | REST Endpoint | MCP Tool |
| :--- | :--- | :--- |
| **Smart Catalog Search** | `GET /api/products` / `GET /api/search_products` | `search_products(query, priority_mode)` |
| **Live Price & Availability** | `GET /api/availability` / `GET /api/check_availability` | `check_availability(product_id, quantity, requested_date)` |
| **Good-Better-Best Substitutes** | `GET /api/substitutes` / `GET /api/suggest_substitutes` | `suggest_substitutes(product_id, exclude_allergens, priority_mode)` |
| **Wholesale Volume Planner** | `GET /api/plan_procurement` | `plan_procurement(query, target_volume_liters_or_kg, priority_mode)` |
| **Autonomous Trade Agent** | `POST /api/agent_execute` | `execute_trade_request(prompt, agent_id, priority_mode, auto_submit)` |
| **Create Purchase Order** | `POST /api/orders` / `POST /api/create_purchase_order` | `create_purchase_order(items, requested_date)` |
| **Human Approval Decision** | `PATCH /api/orders/{order_id}` | — *(Human Manager UI action)* |
| **Workspace & Guardrails** | `GET /api/workspace` · `PUT /api/guardrails` | — |
| **Agent RBAC & Audit Feed** | `GET /api/agents` · `PUT /api/agents/{id}` · `GET /api/events` | — |

---

## Environment Configuration (`backend/.env`)

```env
# Live Valio Aimo Junction API credentials
VALIO_API_KEY=junct_...
VALIO_BASE_URL=https://junction26.valioaimo.fi
VALIO_CUSTOMER_ID=123

# Local Valio static datasets directory (products.json, delivery_reliability.csv, carbon_footprint.csv)
VALIO_DATA_DIR=data

# Open-weights Gemma 4 26B API key (Google AI Studio) for natural-language orchestration & privacy attestation
GEMINI_API_KEY=AIza...
```
