export const MIGRATION_003 = `
CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES sync_plans(id),
  plan_hash TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform = 'dsh'),
  instance_id TEXT NOT NULL,
  root_identity TEXT NOT NULL,
  adapter_contract_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'prepared', 'backing-up', 'applying', 'verifying', 'completed',
    'restoring', 'restored', 'restore-failed', 'manual-review'
  )),
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (plan_id, plan_hash)
) STRICT;

CREATE TABLE transaction_steps (
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  status TEXT NOT NULL CHECK (status IN (
    'prepared', 'backing-up', 'applying', 'verifying', 'completed',
    'restoring', 'restored', 'restore-failed', 'manual-review'
  )),
  step TEXT NOT NULL,
  data_json TEXT NOT NULL,
  previous_hash TEXT,
  entry_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (transaction_id, sequence),
  UNIQUE (transaction_id, entry_hash)
) STRICT;

CREATE TABLE backup_manifests (
  transaction_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  manifest_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE confirmation_nonces (
  token_hash TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  operation_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;

CREATE TABLE checkpoint_transactions (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  PRIMARY KEY (checkpoint_id, transaction_id)
) STRICT;

CREATE INDEX transactions_state_idx ON transactions(status, updated_at);
CREATE INDEX transactions_instance_idx ON transactions(instance_id, created_at);
CREATE INDEX transaction_steps_created_idx ON transaction_steps(transaction_id, created_at);
CREATE INDEX confirmation_nonces_expiry_idx ON confirmation_nonces(expires_at, consumed_at);
CREATE INDEX checkpoint_transactions_transaction_idx ON checkpoint_transactions(transaction_id);
`;
