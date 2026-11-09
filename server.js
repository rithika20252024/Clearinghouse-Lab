import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPayment, openDatabase, postCapture, Problem, reconcile } from './store.js';
import { sign, stripeCapture, stripeCheckout, verify } from './provider.js';

const page = readFileSync(new URL('./public/index.html', import.meta.url));

async function body(req) {
  let size = 0;
  const parts = [];
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    size += part.length;
    if (size > 1024 * 1024) {
      req.resume();
      throw new Problem(413, 'Request body too large');
    }
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function parse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Problem(400, 'Expected JSON');
  }
}

function safePayment(payment) {
  const { request_key, ...result } = payment;
  return result;
}

export function makeServer(db, {
  demoSecret = randomUUID(), stripeKey, stripeSecret, origin = 'http://127.0.0.1:3000',
  checkout = stripeCheckout
} = {}) {
  if ((stripeKey || stripeSecret) &&
      (!/^(sk|rk)_test_/.test(stripeKey ?? '') || !/^whsec_/.test(stripeSecret ?? ''))) {
    throw new Error('Set both a Stripe test-mode key and a webhook signing secret');
  }

  return createServer(async (req, res) => {
    const start = performance.now();
    const path = new URL(req.url, 'http://localhost').pathname;
    const send = (status, payload, contentType = 'application/json') => {
      res.writeHead(status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Server-Timing': 'app;dur=' + (performance.now() - start).toFixed(2)
      });
      res.end(contentType === 'application/json' ? JSON.stringify(payload) : payload);
    };

    try {
      if (req.method === 'POST' && path.startsWith('/api/') &&
          (req.headers['sec-fetch-site'] === 'cross-site' ||
           (req.headers.origin && req.headers.origin !== origin))) {
        throw new Problem(403, 'Cross-origin requests are disabled');
      }
      if (req.method === 'GET' && path === '/') return send(200, page, 'text/html; charset=utf-8');
      if (req.method === 'GET' && path === '/api/config') return send(200, { stripe: Boolean(stripeKey) });
      if (req.method === 'GET' && path === '/api/payments') {
        const rows = db.prepare(`SELECT id, amount, currency, provider, status, created_at,
          (SELECT provider_ref FROM journal WHERE payment_id = payments.id) AS provider_ref
          FROM payments ORDER BY created_at DESC LIMIT 30`).all();
        return send(200, rows);
      }
      const detail = /^\/api\/payments\/([a-f0-9-]{36})$/.exec(path);
      if (req.method === 'GET' && detail) {
        const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(detail[1]);
        if (!payment) throw new Problem(404, 'Payment not found');
        const entries = db.prepare('SELECT * FROM ledger_entries WHERE payment_id = ?').all(payment.id);
        return send(200, { payment: safePayment(payment), entries });
      }

      if (req.method === 'POST' && path === '/api/payments') {
        const input = parse(await body(req));
        const provider = input?.provider;
        if (!['demo', 'stripe'].includes(provider)) throw new Problem(400, 'Unknown provider');
        if (provider === 'stripe' && !stripeKey) throw new Problem(503, 'Stripe test mode is not configured');
        const payment = createPayment(db, req.headers['idempotency-key'], input.amount, provider);
        const checkoutUrl = provider === 'stripe' && payment.status === 'pending'
          ? await checkout(payment, stripeKey, origin) : null;
        return send(200, { payment: safePayment(payment), checkoutUrl });
      }

      if (req.method === 'POST' && path === '/api/demo/capture') {
        const input = parse(await body(req));
        const payment = db.prepare("SELECT * FROM payments WHERE id = ? AND provider = 'demo'")
          .get(typeof input?.id === 'string' ? input.id : '');
        if (!payment) throw new Problem(404, 'Demo payment not found');
        const raw = Buffer.from(JSON.stringify({
          provider: 'demo', eventId: 'evt_' + payment.id, paymentId: payment.id,
          ref: 'demo_' + payment.id, amount: payment.amount, currency: payment.currency
        }));
        verify(raw, sign(raw, demoSecret), demoSecret);
        return send(200, postCapture(db, parse(raw)));
      }

      if (req.method === 'POST' && path === '/webhooks/demo') {
        const raw = await body(req);
        verify(raw, req.headers['demo-signature'], demoSecret);
        return send(200, postCapture(db, { ...parse(raw), provider: 'demo' }));
      }
      if (req.method === 'POST' && path === '/webhooks/stripe' && stripeSecret) {
        const raw = await body(req);
        verify(raw, req.headers['stripe-signature'], stripeSecret);
        const event = stripeCapture(parse(raw));
        return send(200, event ? postCapture(db, event) : { ignored: true });
      }
      if (req.method === 'POST' && path === '/api/reconciliation') {
        const input = parse(await body(req));
        return send(200, reconcile(db, input?.provider, input?.rows));
      }
      throw new Problem(404, 'Route not found');
    } catch (error) {
      if (!(error instanceof Problem)) console.error(error.message);
      send(error.status ?? 500, { error: error.status ? error.message : 'Internal server error' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const origin = 'http://127.0.0.1:' + port;
  const db = openDatabase(process.env.DB_PATH ?? 'lab.sqlite');
  makeServer(db, { origin, stripeKey: process.env.STRIPE_SECRET_KEY, stripeSecret: process.env.STRIPE_WEBHOOK_SECRET })
    .listen(port, '127.0.0.1', () => console.log('Clearinghouse Lab ' + origin));
}
