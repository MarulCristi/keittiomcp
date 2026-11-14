# Frontend scope and working agreement

- This project is a two-person Junction hackathon entry for the Valio Aimo autonomous purchasing challenge. The user's partner owns the backend; this assistant owns only the frontend.
- Do not edit, configure, or run the backend. Keep authored changes inside `frontend/`.
- Before starting each new task, inspect Git status and pull the latest GitHub changes with `git pull --ff-only`. Preserve local changes; do not reset or discard work to make a pull succeed. Repository synchronization can bring in the partner's backend changes.
- The user is a first-time developer. Explain changes in plain language, provide concrete preview/testing steps, and clearly distinguish implemented behavior from proposals and sample-data previews from integrated behavior.
- The deadline stated on 14 November 2026 is tomorrow morning. Favor a small, reliable demonstration over additional features. Reconfirm timing if working after that deadline.

# Challenge requirements

The objective is an open interface and operating model through which an external purchasing agent can interact with a wholesaler. A chatbot or attractive catalog alone does not satisfy the challenge.

Use synthetic data and mocked systems. Do not build against production or confidential systems. Do not put API keys or resource-portal credentials in frontend code, browser bundles, or documentation.

Judging weights:

| Criterion | Weight | Frontend contribution |
| --- | --- | --- |
| Working end-to-end demo | 30% | Show request, lookup, order or approval, and confirmed outcome in one flow. |
| Matching buyer needs | 20% | Make quantity, units, dietary requirements, delivery deadline, and budget visible when supported by returned data. |
| Autonomy and controls | 20% | Explain what the agent may decide, why human approval is needed, and the resulting audit record. |
| Exception handling | 15% | Clearly show partial availability, substitute trade-offs, and delivery constraints. |
| Openness and production path | 15% | Explain actual open interfaces, assumptions, limitations, and realistic next steps. |

# Priorities and honesty

1. Build KeittiöMCP as the manager's control centre for external purchasing agents. Start with the overview and Approval Centre.
2. Keep the purchasing chatbot on the Overview, with recent orders beside it. Demo tools retains structured planning. Show requester identity and order-linked activity within order history; do not show a separate agent activity panel or purchasing scenario buttons.
3. Show supported workspace policies and recorded order history. Add agent management and tool-level activity when the backend provides their contracts.
4. Rehearse automatic approval, human approval and a blocked purchase when those scenarios are supported by the connected mock backend.

Never imply that a frontend warning enforces backend policy. Never silently relax buyer constraints. Lactose-free and milk-allergen-free are different requirements. Unknown availability, delivery, certification, or price must remain unknown; do not invent claims or use unknown values as proof of a match.

Do not imply that an approval is a submitted supplier order. Reflect the actual backend state and clearly label mock behavior. Do not fabricate an audit trail, autonomous reasoning, or successful actions in an integrated demo.

The reviewed frontend uses fixed command parsing for chat. Do not promise unrestricted natural-language purchasing unless the integrated implementation supports it. Coordinate required API capabilities with the backend owner through the user; do not implement backend changes yourself.

Defer recipe planning, predictive purchasing, payments, full marketplace functionality, a new authentication system, carbon estimates, and broad analytics until the core demo is complete. Display sustainability labels only when present in supplied data.

The challenge text and judging criteria provided by the user are the source of these priorities. There is no basis for guaranteeing competition results.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
