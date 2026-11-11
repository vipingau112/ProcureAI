# ProcureAI

**An AI buyer that finds the best price. You approve. PayPal pays.**

ProcureAI watches your inventory, or takes a request like "2 wireless keyboards under $30", then searches live product listings, compares merchants and puts a purchase proposal in your approval queue. Nothing is bought until a person approves it and pays through PayPal.

Built for the PayPal AI Hackathon.

- **Live demo:** `https://procureai-web-vlew.onrender.com` (click **Log in as demo**, no signup or OTP needed)
- **Demo video:** `https://youtu.be/rcE7c7ANya4`

## How it works

1. **Ask.** Type what you want to buy (with an optional quantity), or press **Restock low items** and the agent finds everything below its reorder level.
2. **The agent shops.** An AI model (Gemini, or Claude) calls tools: it searches the Channel3 catalog, compares offers across merchants, skips out-of-stock items, and asks for a bulk price when the quantity is large.
3. **You decide.** Each result appears in the approval queue with the product, merchant, price and a one-line reason. You can change the quantity (the price is recalculated), reject it, or approve it.
4. **PayPal pays.** Approve & pay creates a PayPal order, you pay in the PayPal sandbox, the server captures the payment, and you get a printable invoice.

## What is inside

- **Safety rails enforced in server code, not in the prompt.** A maximum unit price per item, a per-purchase cap, a total budget, no buying beyond target stock, and a quantity you typed cannot be overridden by the model.
- **Automatic fallback.** If the AI service is busy, rate-limited or over the daily cap, a built-in scripted agent finishes the job and the activity log says why.
- **Accounts.** Signup, login, forgot password and email OTP verification (Gmail or Resend). Every user has their own inventory, budget, proposals and invoices, stored in PostgreSQL (or JSON files when no database is configured).
- **Multi-currency.** The browser location (or a manual choice) picks your currency. Orders are charged in that currency when PayPal supports it, otherwise in USD, with a local-currency estimate shown.
- **Invoices.** A printable receipt for every paid order (print or save as PDF).
- **Activity log.** Every tool call the agent makes is shown live.

## Run it locally (about 3 minutes, no API keys needed)

Requires Node.js 18 or newer.

```bash
# terminal 1: the server
cd server
cp .env.example .env        # Windows: copy .env.example .env
npm install
npm run dev

# terminal 2: the dashboard
cd client
cp .env.example .env.local  # Windows: copy .env.example .env.local
npm install
npm run dev
```

Open http://localhost:3000 and press **Log in as demo**.

With no keys the app uses a mock product catalog, a mock PayPal checkout and a scripted agent, so the whole flow works. To use the real services, put keys in `server/.env`:

| Variable                                   | What it turns on                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GEMINI_API_KEY` (and `GEMINI_MODEL`)      | The Gemini agent. Model names change, so if you see a "model not found" error, copy a current name from Google AI Studio.                                                      |
| `ANTHROPIC_API_KEY`                        | The Claude agent, used when no Gemini key is set                                                                                                                               |
| `CHANNEL3_API_KEY`                         | Live product search and prices                                                                                                                                                 |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal **sandbox** checkout (use sandbox credentials, never live ones)                                                                                                         |
| `DATABASE_URL`                             | Stores accounts and data in PostgreSQL (for example a free Neon database). Empty = JSON files in `server/data/`.                                                               |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD`         | Sends OTP codes from your Gmail through SMTP. Use an [App Password](https://myaccount.google.com/apppasswords), not your normal password. Empty = the code is shown on screen. |
| `RESEND_API_KEY`                           | Alternative email sender over HTTPS (without a verified domain it only delivers to your own address)                                                                           |

After adding keys, run `npm run check` in `server/`. It tests each service and tells you what to fix. `npm run check -- --agent` also runs the whole agent (no payment is made).

To pay in the sandbox you need a sandbox **buyer** account from developer.paypal.com (Testing tools, Sandbox accounts). If PayPal says the seller does not accept your currency, make the sandbox buyer and seller accounts United States accounts.

## Insights tab (AG Studio)

The **Insights** tab is an [AG Studio](https://www.ag-grid.com/studio/) dashboard built from your proposals: spend by merchant, savings against list price, value by status and a table of everything. It shows sample data until the account has proposals, and **Customize dashboard** switches Studio into edit mode so you can add and rearrange widgets. It runs locally without a licence key. For a hosted site set `NEXT_PUBLIC_AG_STUDIO_LICENSE` (a free 45-day trial key) to remove the watermark.

## Deploy your own copy on Render

`render.yaml` describes two web services: the API (`server/`) and the dashboard (`client/`). In Render choose **New, Blueprint**, connect this repository and fill in the prompted values. The two services need each other's address, so after the first deploy:

1. On the API service set `SERVER_URL` (its own URL) and `CLIENT_URL` (the dashboard URL).
2. On the dashboard service set `NEXT_PUBLIC_API_URL` (the API URL), then redeploy it. This value is baked in at build time.

Use URLs without a trailing slash. On Render's free plan a service sleeps after about 15 minutes without traffic and its disk is temporary, so without a database accounts and payment history reset when the server sleeps.

- **Database:** set `DATABASE_URL` on the API service to a free [Neon](https://neon.com) Postgres. (Render's own free Postgres expires after 30 days, so it is a poor fit for a demo that is judged weeks later.)
- **Email:** Render's free web services block SMTP, so Gmail cannot send from there. Leave `OTP_DEMO_MODE=true` (the code is shown on screen) and use the **Log in as demo** button.

## Built with

- **AI:** Gemini or Claude (tool calling)
- **Payments:** PayPal Orders v2 REST API, sandbox
- **Catalog:** Channel3 search API
- **Dashboard:** Next.js, React, AG Grid (queue and inventory tables), AG Studio (the Insights tab)
- **Server:** Node.js, Express, TypeScript
- **Exchange rates:** [Exchange Rate API](https://www.exchangerate-api.com) (open access)

## Honest limitations

- **Negotiation is simulated.** Catalog APIs cannot negotiate, so the "merchant" answers with a volume-discount rule (3% at 10 units, 6% at 50, 10% at 100). The interface says so.
- **Nothing is really ordered.** The sandbox payment goes to the PayPal sandbox business account behind the app, not to the retailer. Real purchasing would need a checkout integration with each merchant.
- **PayPal charges only in its own currency list.** INR is not on it, so Indian buyers are charged in USD with an INR estimate. Paying in a currency the sandbox seller account does not hold can leave the payment pending.
- **OTP by email, or on screen in demo mode.** With Gmail or Resend configured the code is emailed (at most 5 per address per hour and 200 per day). Without one, the code is shown on screen so the demo works anywhere. SMS is not built. Codes and rate limits are kept in memory, so a restart cancels pending codes.
- **Storage fits one server instance.** Data is loaded into memory at startup and written back to PostgreSQL (one JSONB document per user) every few seconds and right after a payment, so a crash can lose the last few seconds of changes. It is not designed for several instances at once. Without `DATABASE_URL` it falls back to JSON files in `server/data/` (git-ignored).
- **The invoice is a receipt for a sandbox payment**, not a tax invoice.
- **Location** is sent from your browser to BigDataCloud, rounded to about 10 km, only to find your country. Nothing is stored.

## What is next

SMS OTP, merchant checkout integrations, PayPal webhooks for payment confirmation, and normalised database tables with multi-instance support.

## Project layout

```
server/   Express API: agent, tools, accounts, PayPal, currency, per-user storage
client/   Next.js dashboard: login, approval queue, inventory, invoice
```

## License

MIT. See [LICENSE](LICENSE).
