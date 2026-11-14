# KeittiöMCP frontend quick start

The interface uses the supplied Keittiö wordmark and exact navy, sky blue, electric blue, turquoise, orange and slate palette in `app/palette.css`. Headings use Londrina Solid; other text uses Libre Franklin, both served locally. `app/brand.css` applies a navy navigation bar and shadowed cards across all six screens. The four dashboard SVG icons use the supplied Tabler paths. Original logo assets are in `public/branding/`. Technical package names and folder paths remain ASCII.

Open a new PowerShell window and run:

```powershell
cd C:\Users\annap\Desktop\keittioMCP\frontend
npm.cmd run dev
```

Open the URL printed by the terminal (normally http://localhost:3000). Keep the terminal open while using the preview. Press Ctrl+C to stop it. You only need `npm.cmd ci` after first cloning the project or when dependency inputs change.

## Try the screens without a backend

Click **Start browser preview** in the top bar. This loads a clearly labelled simulation that runs entirely in the browser:

1. **Overview:** use the purchasing assistant to find products and review an order. Recent orders beside the chat show products, requester identity and status. Expand an order for its reasons and related activity.
2. **Approvals:** approve or reject the pending example; it leaves the queue and appears in Activity.
3. **Agents:** change permissions or pause Kitchen Assistant, save, then try a lookup or purchase in Demo tools to see the effect.
4. **Policies:** change the automatic approval limit and save. New simulated orders use the saved rules.
5. **Activity:** inspect the combined order history, including who requested each order. Related creation and approval events appear inside the order rather than in a separate agent activity panel.
6. **Demo tools:** enter `milk` in the purchasing planner, choose a quantity, find options, review one, check availability, and create a simulated order.

**Reset preview** restores the starting examples. Reloading the page also clears these session-only changes. **Use service connection** returns to the separate backend connection mode. Browser preview never creates a supplier order or changes backend permissions; its illustrative prices, stock, delivery dates and decisions are not supplier confirmations.

The existing read-only samples are also available in disconnected service mode:

Open **Approvals** and expand **Preview an example approval** to see the brief’s €1,450 sample order and the rule that triggers review.

To try the product review, open **Overview** while the purchasing service is disconnected:

1. Click **Explore sample products**.
2. Choose **Review product** on the lactose-free cooking cream.
3. Change the quantity to **12**. The sample estimate should become **€41.40**.
4. Enter **0**. A validation message should appear.
5. Review the organic cooking cream. Its price and total should remain **Not confirmed**.

These read-only sample cards do not create orders. Switch to **Browser preview** for interactive simulations.

## Connect to the purchasing service

The frontend forwards `/api/` requests to `http://127.0.0.1:8000` by default. The backend owner supplies and runs that service. To use a different reachable service, set its base URL in the ignored `frontend/.env.local` file:

```text
BACKEND_URL=http://YOUR-BACKEND-HOST:8000
```

Restart the frontend after changing this file. `localhost` on this computer does not refer to another teammate's computer. Do not put supplier API credentials in frontend source or browser-exposed environment variables.

See [INTEGRATION.md](INTEGRATION.md) for the frontend connection points and proposed agent/activity contracts.

## Integrated smoke test (requires the backend)

1. Confirm the connection label and saved purchasing rules load.
2. Open **Overview**, search for a product in the assistant and choose **Review product**.
3. Set a quantity and click **Check price & availability**.
4. Verify unknown prices, unavailable quantities, sales blocks, and shortages do not enable the new order button.
5. In `demo` mode, a confirmed available quantity with a confirmed EUR price enables **Create demo order**. Changing quantity requires another lookup.
6. Create the demo order and confirm the returned status and reasons appear in the review panel and **Activity**. A pending order should also appear under **Approvals**.
7. Approve or reject a pending demo order from **Approvals** and confirm its displayed status updates in **Activity**.

Use **Refresh workspace** to retrieve orders created by an external client. The overview counts orders by their last update date and current status. Connected agent counts, per-agent settings and tool-level activity still require backend data.

Both `demo` and `junction` modes can create a recorded mock order after a successful availability check. The backend controls the final decision and submission capabilities. Review CHALLENGE-COVERAGE.md for remaining integration requirements.

The chatbot appears only on Overview. Demo tools contains the request planner for total litres/kg, delivery date and allergen exclusions, plus product review. Finding alternatives from a review opens their results in the Overview assistant. Product cards display supplier reliability and sustainability fields when supplied. Policies supports the backend's reliability threshold and substitution approval setting.

## Checks

Using the installed Node.js version:

```powershell
node --test tests/purchasing.test.mjs tests/browser-preview.test.mjs
npm.cmd run typecheck
npm.cmd run build
```

Stop the development server before running the production build. Tests cover quantity and price validation, stale availability checks, supported ordering modes, simulated approval decisions, permissions, paused agents, changed policies, shortages and session isolation.
