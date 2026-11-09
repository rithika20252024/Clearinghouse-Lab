import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { cpus, platform, arch } from 'node:os';
import { openDatabase } from './store.js';
import { makeServer } from './server.js';
import { sign } from './provider.js';

const count = Number(process.env.BENCH_PAYMENTS ?? 3000);
if (!Number.isSafeInteger(count) || count < 100 || count > 100000) throw new Error('BENCH_PAYMENTS must be 100–100000');
const directory = mkdtempSync(join(tmpdir(), 'clearinghouse-bench-'));
const db = openDatabase(join(directory, 'bench.sqlite'));
const demoSecret = randomUUID();
const server = makeServer(db, { demoSecret });

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = 'http://127.0.0.1:' + server.address().port;

  async function post(path, body, headers = {}) {
    const start = performance.now();
    const response = await fetch(root + path, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...headers }
    });
    const data = await response.json();
    return { ms: performance.now() - start, ok: response.ok, data };
  }

  async function scenario(payments, concurrency) {
    const samples = { create: [], capture: [], replay: [], lifecycle: [] };
    let next = 0;
    let errors = 0;
    const started = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next++ < payments) {
        const start = performance.now();
        try {
          const create = await post('/api/payments', { provider: 'demo', amount: 2500 },
            { 'Idempotency-Key': randomUUID() });
          samples.create.push(create.ms);
          if (!create.ok) throw new Error('Create failed');
          const id = create.data.payment.id;
          const event = { eventId: 'evt_' + id, paymentId: id, ref: 'demo_' + id, amount: 2500, currency: 'usd' };
          const headers = { 'Demo-Signature': sign(JSON.stringify(event), demoSecret) };
          const capture = await post('/webhooks/demo', event, headers);
          samples.capture.push(capture.ms);
          if (!capture.ok || capture.data.duplicate !== false) throw new Error('Capture failed');
          const replay = await post('/webhooks/demo', event, headers);
          samples.replay.push(replay.ms);
          if (!replay.ok || replay.data.duplicate !== true) throw new Error('Replay failed');
          samples.lifecycle.push(performance.now() - start);
        } catch (error) {
          errors++;
          if (errors === 1) console.error(error.message);
        }
      }
    }));
    const seconds = (performance.now() - started) / 1000;
    const percentile = (values, p) => +(values[Math.ceil(values.length * p) - 1] ?? 0).toFixed(2);
    return {
      concurrency, payments, errors,
      requestsPerSecond: +((samples.create.length + samples.capture.length + samples.replay.length) / seconds).toFixed(1),
      latencyMs: Object.fromEntries(Object.entries(samples).map(([name, values]) => {
        values.sort((a, b) => a - b);
        return [name, { samples: values.length, p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99) }];
      }))
    };
  }

  const warmup = await scenario(100, 8);
  const results = [];
  for (const concurrency of [1, 16, 64]) results.push(await scenario(count, concurrency));
  const accounting = db.prepare(`SELECT
    count(*) AS ledger_legs,
    sum(CASE side WHEN 'debit' THEN amount ELSE -amount END) AS net_cents
    FROM ledger_entries`).get();
  const captured = db.prepare('SELECT count(*) AS n FROM journal').get().n;
  const events = db.prepare('SELECT count(*) AS n FROM provider_events').get().n;
  console.log(JSON.stringify({ environment: { node: process.version, platform: platform(), arch: arch(),
    cpu: cpus()[0]?.model, storage: 'SQLite WAL on local disk', transport: 'loopback HTTP, simulated provider' },
    warmupPayments: 100, results, accounting: { captured, events, ...accounting } }, null, 2));
  if (warmup.errors || results.some(row => row.errors) || captured !== 100 + 3 * count ||
      events !== captured || accounting.ledger_legs !== captured * 2 || accounting.net_cents !== 0) process.exitCode = 1;
} finally {
  await new Promise(resolve => server.close(resolve));
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
