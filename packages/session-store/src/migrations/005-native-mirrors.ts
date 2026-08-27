export const MIGRATION_005 = `
ALTER TABLE transactions RENAME TO transactions_v4;
ALTER TABLE transaction_steps RENAME TO transaction_steps_v4;
ALTER TABLE backup_manifests RENAME TO backup_manifests_v4;
ALTER TABLE checkpoint_transactions RENAME TO checkpoint_transactions_v4;

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES sync_plans(id),
  plan_hash TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('codex', 'dsh')),
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

CREATE TABLE checkpoint_transactions (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  PRIMARY KEY (checkpoint_id, transaction_id)
) STRICT;

INSERT INTO transactions SELECT * FROM transactions_v4;
INSERT INTO transaction_steps SELECT * FROM transaction_steps_v4;
INSERT INTO backup_manifests SELECT * FROM backup_manifests_v4;
INSERT INTO checkpoint_transactions SELECT * FROM checkpoint_transactions_v4;

DROP TABLE checkpoint_transactions_v4;
DROP TABLE backup_manifests_v4;
DROP TABLE transaction_steps_v4;
DROP TABLE transactions_v4;

CREATE INDEX transactions_state_idx ON transactions(status, updated_at);
CREATE INDEX transactions_instance_idx ON transactions(instance_id, created_at);
CREATE INDEX transaction_steps_created_idx ON transaction_steps(transaction_id, created_at);
CREATE INDEX checkpoint_transactions_transaction_idx ON checkpoint_transactions(transaction_id);

CREATE TABLE native_mirrors (
  logical_session_id TEXT PRIMARY KEY REFERENCES logical_sessions(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN (
    'disabled', 'initializing', 'active', 'paused', 'busy',
    'incompatible', 'conflicted', 'recovering'
  )),
  codex_binding_id TEXT REFERENCES platform_bindings(id) ON DELETE SET NULL,
  dsh_binding_id TEXT REFERENCES platform_bindings(id) ON DELETE SET NULL,
  common_version_id TEXT REFERENCES session_versions(id) ON DELETE SET NULL,
  codex_version_id TEXT REFERENCES session_versions(id) ON DELETE SET NULL,
  dsh_version_id TEXT REFERENCES session_versions(id) ON DELETE SET NULL,
  last_transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  pause_reason TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX native_mirrors_state_idx ON native_mirrors(state, updated_at);
`;
