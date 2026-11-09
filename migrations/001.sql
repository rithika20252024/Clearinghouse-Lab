CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL CHECK (amount BETWEEN 100 AND 100000),
  currency TEXT NOT NULL CHECK (currency = 'usd'),
  provider TEXT NOT NULL CHECK (provider IN ('demo', 'stripe')),
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid'))
) STRICT;
