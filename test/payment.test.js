import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createPayment, openDatabase } from '../store.js';
import { sign, stripeCheckout } from '../provider.js';
import { makeServer } from '../server.js';

test('migration preserves an existing pending payment and signed Stripe retries post once', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'clearinghouse-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'test.sqlite');
  const old = openDatabase(path, 1);
  const payment = createPayment(old, 'legacy-key-1234', 2500, 'stripe');
  old.close();

  const db = openDatabase(path);
  const stripeSecret = 'whsec_fixture';
  const server = makeServer(db, {
    stripeKey: 'sk_test_fixture', stripeSecret, checkout: async () => 'https://checkout.stripe.com/test-fixture'
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  const root = 'http://127.0.0.1:' + server.address().port;
  const post = (path, input, headers = {}) => fetch(root + path, {
    method: 'POST', body: typeof input === 'string' ? input : JSON.stringify(input),
    headers: { 'Content-Type': 'application/json', ...headers }
  });

  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  const create = (amount, key = 'legacy-key-1234') =>
    post('/api/payments', { amount, provider: 'stripe' }, { 'Idempotency-Key': key });
  assert.equal((await (await create(2500)).json()).payment.id, payment.id);
  assert.equal((await create(2600)).status, 409);

  const event = {
    id: 'evt_test', livemode: false, type: 'checkout.session.completed',
    data: { object: { mode: 'payment', payment_status: 'paid', metadata: { payment_id: payment.id },
      amount_total: 2500, currency: 'usd', payment_intent: 'pi_test' } }
  };
  const deliver = (event, secret = stripeSecret) => {
    const raw = JSON.stringify(event);
    return post('/webhooks/stripe', raw, { 'Stripe-Signature': sign(raw, secret) });
  };

  assert.equal((await deliver(event, 'wrong')).status, 401);
  event.data.object.amount_total = 2400;
  assert.equal((await deliver(event)).status, 422);
  event.data.object.amount_total = 2500;
  assert.equal((await deliver({ ...event, livemode: true })).status, 200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM journal').get().n, 0);

  const responses = await Promise.all(Array.from({length: 20}, () => deliver(event)));
  assert.ok(responses.every(response => response.ok));
  const posted = await Promise.all(responses.map(response => response.json()));
  assert.equal(posted.filter(result => !result.duplicate).length, 1);
  assert.deepEqual(await (await deliver({ ...event, id: 'evt_second' })).json(), { duplicate: true });
  const other = await (await create(2500, 'another-key-1234')).json();
  const conflict = structuredClone(event);
  conflict.id = 'evt_conflict';
  conflict.data.object.metadata.payment_id = other.payment.id;
  assert.equal((await deliver(conflict)).status, 409);
  assert.equal(db.prepare('SELECT count(*) AS n FROM provider_events').get().n, 2);

  const detail = await (await fetch(root + '/api/payments/' + payment.id)).json();
  assert.equal(detail.payment.status, 'paid');
  assert.deepEqual(detail.entries.map(row => [row.side, row.amount]), [['debit', 2500], ['credit', 2500]]);
  assert.throws(() => db.exec('DELETE FROM journal'), /immutable/);
  const result = await (await post('/api/reconciliation', { provider: 'stripe', rows: [
    { ref: 'pi_test', amount: 2600, currency: 'usd' },
    { ref: 'pi_missing', amount: 2500, currency: 'usd' }
  ] })).json();
  assert.deepEqual(result.discrepancies.map(row => row.type), ['amount_mismatch', 'missing_in_ledger']);
  const empty = await (await post('/api/reconciliation', { provider: 'stripe', rows: [] })).json();
  assert.equal(empty.discrepancies[0].type, 'missing_in_provider_report');
});

test('Stripe adapter sends stable retry key and refuses to retry past the safety window', async () => {
  const payment = { id: 'test-payment', amount: 2500, currency: 'usd', created_at: Date.now() };
  const request = async (url, options) => {
    assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(options.headers['Idempotency-Key'], 'clearinghouse-test-payment');
    assert.equal(options.body.get('metadata[payment_id]'), payment.id);
    assert.equal(options.body.get('line_items[0][price_data][unit_amount]'), '2500');
    return new Response(JSON.stringify({ id: 'cs_test_fixture', livemode: false, url: 'https://checkout.stripe.com/fixture' }));
  };
  assert.equal(await stripeCheckout(payment, 'sk_test_fixture', 'http://127.0.0.1:3000', request),
    'https://checkout.stripe.com/fixture');
  await assert.rejects(stripeCheckout({ ...payment, created_at: 0 }, 'sk_test_fixture', '', request), /window expired/);
});
