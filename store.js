import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export class Problem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase(path, target = 2) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL');
    transaction(db, () => {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version > target) throw new Error('Database schema is newer than this application');
      for (let next = version + 1; next <= target; next++) {
        db.exec(readFileSync(new URL('./migrations/00' + next + '.sql', import.meta.url), 'utf8'));
        db.exec('PRAGMA user_version = ' + next);
      }
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function createPayment(db, key, amount, provider) {
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(key ?? '')) {
    throw new Problem(400, 'Supply a 12–100 character Idempotency-Key');
  }
  if (!Number.isInteger(amount) || amount < 100 || amount > 100000) {
    throw new Problem(400, 'amount must be an integer from 100 to 100000 USD cents');
  }
  return transaction(db, () => {
    const existing = db.prepare('SELECT * FROM payments WHERE request_key = ?').get(key);
    if (existing) {
      if (existing.amount !== amount || existing.provider !== provider) {
        throw new Problem(409, 'Idempotency key already used for different parameters');
      }
      return existing;
    }
    return db.prepare(`INSERT INTO payments (id, request_key, amount, currency, provider, created_at)
      VALUES (?, ?, ?, 'usd', ?, ?) RETURNING *`).get(randomUUID(), key, amount, provider, Date.now());
  });
}

export function postCapture(db, event) {
  const { provider, eventId, paymentId, ref, amount, currency } = event;
  if (![eventId, paymentId, ref].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200)) {
    throw new Problem(400, 'Capture must have event, payment, and provider references');
  }
  return transaction(db, () => {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment || payment.provider !== provider || payment.amount !== amount || payment.currency !== currency) {
      throw new Problem(422, 'Capture does not match an existing payment');
    }
    const seen = db.prepare('SELECT * FROM provider_events WHERE provider = ? AND event_id = ?').get(provider, eventId);
    if (seen && (seen.payment_id !== paymentId || seen.provider_ref !== ref)) {
      throw new Problem(409, 'Event identity conflicts with an earlier delivery');
    }
    if (seen) return { duplicate: true };

    const posted = db.prepare('SELECT * FROM journal WHERE payment_id = ? OR (provider = ? AND provider_ref = ?)')
      .all(paymentId, provider, ref);
    if (posted.some(row => row.payment_id !== paymentId || row.provider_ref !== ref)) {
      throw new Problem(409, 'Provider reference conflicts with an existing posting');
    }
    db.prepare('INSERT INTO provider_events VALUES (?, ?, ?, ?)').run(provider, eventId, paymentId, ref);
    if (posted.length) return { duplicate: true };

    db.prepare('INSERT INTO journal VALUES (?, ?, ?, ?, ?, ?)').run(paymentId, provider, ref, amount, currency, Date.now());
    db.prepare("UPDATE payments SET status = 'paid' WHERE id = ?").run(paymentId);
    return { duplicate: false };
  });
}

export function reconcile(db, provider, rows) {
  if (!['demo', 'stripe'].includes(provider) || !Array.isArray(rows) || rows.length > 5000) {
    throw new Problem(400, 'Supply a provider and at most 5000 capture rows');
  }
  const report = new Map();
  for (const row of rows) {
    if (!row || typeof row.ref !== 'string' || !row.ref || row.ref.length > 200 ||
        !Number.isInteger(row.amount) || row.amount <= 0 || row.currency !== 'usd' || report.has(row.ref)) {
      throw new Problem(400, 'Capture rows need unique references, positive integer amounts, and usd currency');
    }
    report.set(row.ref, row);
  }
  const discrepancies = [];
  let matched = 0;
  for (const entry of db.prepare('SELECT * FROM journal WHERE provider = ?').iterate(provider)) {
    const row = report.get(entry.provider_ref);
    report.delete(entry.provider_ref);
    if (!row) discrepancies.push({ type: 'missing_in_provider_report', ref: entry.provider_ref, ledger: entry.amount });
    else if (row.amount !== entry.amount) {
      discrepancies.push({ type: 'amount_mismatch', ref: entry.provider_ref, ledger: entry.amount, provider: row.amount });
    } else matched++;
  }
  for (const row of report.values()) {
    discrepancies.push({ type: 'missing_in_ledger', ref: row.ref, provider: row.amount });
  }
  return { matched, discrepancies };
}
