# Clearinghouse Lab

A local fintech portfolio project that follows a payment from creation to capture, accounting, and reconciliation. It includes a browser console, a simulated provider, and an optional Stripe test-mode adapter. It requires Node.js 24+ and uses the built-in HTTP and SQLite modules. There are no npm packages to install.

## Run and demo

```sh
npm start
```

Open http://127.0.0.1:3000. Create a demo payment, then submit it again with the same key. The payment ID stays the same. Change the amount and try the same key to see a conflict. Restore the amount, deliver a capture, and deliver it again to see one pair of ledger entries. The ledger shows both the debit to processor clearing and the credit to merchant payable.

For reconciliation, copy the provider reference from the tooltip on a paid row. Submit a provider report with that reference and the original amount in integer USD cents. The default sample also includes an unmatched external capture. Change the amount of a matched capture to see a mismatch. Use a complete report for the chosen provider and this lab database. Partial-period reports will flag captures outside the report.

```json
[{"ref":"demo_REPLACE_WITH_PAYMENT_ID","amount":2500,"currency":"usd"}]
```

## Design and failure cases

- **Request retries.** A unique client idempotency key maps to one payment. Reusing it with a different amount or provider returns HTTP 409. Stripe receives a second, stable key derived from the local payment ID. The local payment commits before calling Stripe, so a timeout can be retried using the same key. The adapter caps retries at 23 hours to stay inside Stripe's documented retention window. Investigate expired attempts before issuing a new key.
- **Webhook retries.** The handler checks the signature against the raw body and applies a five-minute timestamp tolerance. It accepts paid, test-mode card Checkout completions. The payment, provider, currency, and amount must match. Unique event IDs deduplicate deliveries, and the provider reference constraint prevents two different events from posting the same capture twice.
- **Accounting.** A SQLite transaction inserts the event and journal row and marks the payment paid. Any failure rolls back all three. One immutable journal row generates two equal ledger legs, so a half-posted capture cannot exist. This is gross capture accounting. Fees, refunds, disputes, payouts, and bank settlement are outside the lab's accounting model.
- **Reconciliation.** Submit a normalized, independently sourced list of provider captures to `POST /api/reconciliation`. The API reports missing provider rows, missing ledger rows, and amount mismatches. For Stripe use the PaymentIntent ID and captured gross amount, filtered to this lab's test payments. The app does not download a report or reconcile bank deposits.
- **Schema evolution.** Migration 001 creates payment requests. Migration 002 adds event deduplication, the immutable journal, and the ledger view while preserving existing request IDs and idempotency keys. The test creates a pending request on schema 001, migrates the database, and captures the same request on schema 002. Migrations and the version update commit together. For rollback after a successful upgrade, restore a consistent database backup taken before migration. Pause writes and preserve post-upgrade activity separately before restoring.
- **Capacity.** SQLite WAL supports concurrent reads, but writes serialize and synchronous queries share the Node event loop. The load results show latency rising as concurrency increases. A multi-instance deployment would require a shared transactional database, merchant-scoped access, persisted checkout session state, asynchronous reconciliation, and independent load generation. This console binds to loopback and assumes a single trusted operator.

## Optional Stripe test-mode walkthrough

1. Use a Stripe test secret key from your own Stripe workspace. Run the official Stripe CLI locally and forward only the event the lab consumes.

   ```sh
   stripe listen --events checkout.session.completed --forward-to http://127.0.0.1:3000/webhooks/stripe
   ```

2. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in your local shell or an ignored `.env` file. The signing secret is the one printed by the listener. With an env file, start using `node --env-file=.env server.js`. Keep both values local.
3. Choose **Stripe test mode** in the console, create a payment, and complete hosted Checkout using Stripe test card `4242 4242 4242 4242`, a future expiry, and any three-digit CVC. On return, refresh the payment until its signed event arrives. Check that the ledger has one debit and one credit.
4. Open Stripe's test dashboard and compare that PaymentIntent's gross captured amount against the journal through the reconciliation form.

The automated suite uses signed Stripe-shaped fixtures and a stubbed outbound call. It requires no Stripe account. An end-to-end session against Stripe's hosted test environment still needs to be run.

References: [Stripe Checkout sessions](https://docs.stripe.com/api/checkout/sessions/create), [Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment), [Idempotent requests](https://docs.stripe.com/api/idempotent_requests), [Webhook signatures](https://docs.stripe.com/webhooks/signature), [Testing](https://docs.stripe.com/testing).

## Verification and performance

```sh
npm test
npm run bench
```

The HTTP tests cover a populated schema upgrade, invalid signatures, amount mismatches, 20 concurrent deliveries of one event, conflicting provider references, immutable journal rows, and reconciliation discrepancies. The adapter test checks the stable outbound idempotency key and retry cutoff.

The benchmark creates each payment, sends a signed capture, then replays the same capture. Each concurrency level runs 3,000 simulated lifecycles (9,000 HTTP requests). The load driver and server share the same Node process. Results are one local run on an Apple M4 using SQLite WAL and loopback HTTP.

| Concurrent clients | HTTP requests/sec | Capture p95 | Three-request lifecycle p95 | Failed lifecycles |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 3,949 | 0.45 ms | 1.20 ms | 0 |
| 16 | 4,385 | 6.01 ms | 17.19 ms | 0 |
| 64 | 4,473 | 20.84 ms | 56.23 ms | 0 |

Including warm-up, the benchmark verified 9,100 captures, 18,200 ledger legs, zero duplicate postings, and zero net cents across debit and credit legs. These measurements characterize the simulated local workload. Stripe network latency and production traffic are outside the measurement. See [benchmark-results.json](benchmark-results.json) for full p50/p95/p99 data.
