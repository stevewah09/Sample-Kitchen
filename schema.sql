CREATE TABLE IF NOT EXISTS reference_data (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  source_filename TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('stock', 'hr_staff', 'hr_leave', 'hr_availability', 'crm')),
  identity_key TEXT NOT NULL UNIQUE,
  source_system TEXT,
  export_id TEXT,
  source_filename TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS import_records (
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  record_key TEXT NOT NULL,
  record JSONB NOT NULL,
  PRIMARY KEY (batch_id, record_key)
);

CREATE TABLE IF NOT EXISTS planning_agent_runs (
  id TEXT PRIMARY KEY,
  import_version TEXT NOT NULL,
  model TEXT NOT NULL,
  recommendations JSONB NOT NULL,
  handoff_trace JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS import_batches_kind_imported_at_idx
  ON import_batches (kind, imported_at DESC);

CREATE INDEX IF NOT EXISTS planning_agent_runs_import_version_idx
  ON planning_agent_runs (import_version, created_at DESC);
