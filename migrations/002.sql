CREATE TABLE provider_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  provider_ref TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
) STRICT;

-- A single immutable row represents the two legs of a posting.
CREATE TABLE journal (
  payment_id TEXT PRIMARY KEY REFERENCES payments(id),
  provider TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency = 'usd'),
  posted_at INTEGER NOT NULL,
  UNIQUE (provider, provider_ref)
) STRICT;

CREATE VIEW ledger_entries AS
  SELECT payment_id, 'processor_clearing' AS account, 'debit' AS side, amount, currency FROM journal
  UNION ALL
  SELECT payment_id, 'merchant_payable', 'credit', amount, currency FROM journal;

CREATE TRIGGER journal_no_update BEFORE UPDATE ON journal
BEGIN SELECT RAISE(ABORT, 'journal is immutable'); END;
CREATE TRIGGER journal_no_delete BEFORE DELETE ON journal
BEGIN SELECT RAISE(ABORT, 'journal is immutable'); END;
