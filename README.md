# Keittiö Purchasing

Keittiö is a local kitchen purchasing workspace. The Next.js dashboard uses the FastAPI backend for catalog queries, purchase orders, approvals, and guardrail settings. FastMCP exposes the same four purchasing operations to MCP clients.

## Run locally

Use Python 3.11 or newer and Node.js 22.12 or newer.

### Backend

From the repository root in PowerShell:

```powershell
cd backend
python -m venv .venv
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn main:app --reload
```

On macOS or Linux, use `cp .env.example .env` and `.venv/bin/python` in place of the Windows commands. The API listens at [localhost:8000](http://127.0.0.1:8000/docs).

### Frontend

Check `node --version` before starting the frontend. If Node 22.11.0 reports `ERR_REQUIRE_ESM` while compiling CSS, switch to Node 22.12 or newer. On Windows with Node 24.11.0 installed through NVM, run `nvm use 24.11.0` and check the version again.

From the repository root in a second terminal:

```sh
cd frontend
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). Next.js proxies dashboard requests to `http://127.0.0.1:8000`. To use a different backend address, set `BACKEND_URL` in `frontend/.env.local` and restart Next.js.

## Try the demo

- Enter `chef@valio.fi` or another work email to preview domain-based branding. This is a branding preview with a shared local workspace.
- In chat, try `Find cooking cream`, `Check AIMO-201 12`, `Substitutes for AIMO-301`, or `Order 12 AIMO-201`. The demo chat interprets these commands directly.
- Save a spend limit and allergen settings, then create an order. Orders above the limit or containing a selected allergen go to human review. Pending orders can be approved or rejected from the dashboard.

The backend runs in demo mode with an empty `VALIO_API_KEY`. It uses a sample catalog and records demo orders and settings in `backend/demo.sqlite3`.

## Connect Valio Aimo Junction

Set `VALIO_API_KEY` in `backend/.env` and restart the backend. Both REST and MCP use the Junction API. The client downloads the product catalog once per process and searches it locally. Catalog results leave stock and unit price empty until you look up a particular product.

Use `check_availability` with a Valio product ID to retrieve delivery availability and the tax-inclusive price per sales unit. Optionally pass `requested_date` as `YYYY-MM-DD` and `customer` as a customer number. The defaults are today's date in Helsinki and `VALIO_CUSTOMER_ID` (defaults to the challenge example `123`). For example, enter `Check 460013 12 2026-11-16` in the dashboard. Terminal products can have an unknown available quantity.

The Junction specification in [backend/openapi.json](backend/openapi.json) provides catalog downloads, pricing, and availability. Live `create_purchase_order` returns HTTP 501 through REST and a tool error through MCP. Supplier order submission requires an order API contract.

## REST and MCP

| Operation | REST endpoint | MCP tool |
| --- | --- | --- |
| Search catalog | `GET /api/search_products?query=cream` | `search_products` |
| Check price and availability | `GET /api/check_availability?product_id=AIMO-201&quantity=12` | `check_availability` |
| Suggest substitutes | `GET /api/suggest_substitutes?product_id=AIMO-301&exclude_allergens=gluten` | `suggest_substitutes` |
| Create an order | `POST /api/create_purchase_order` | `create_purchase_order` |

For demo order creation, pass `{"items":[{"product_id":"AIMO-201","quantity":12}]}`. The dashboard also uses `GET /api/workspace`, `PUT /api/guardrails`, and `PATCH /api/orders/{order_id}`.

Connect a Streamable HTTP MCP client to `http://127.0.0.1:8000/mcp`. To use stdio, run `python mcp_server.py` from `backend` with the virtual environment's Python interpreter.
