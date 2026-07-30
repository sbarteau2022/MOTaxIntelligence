-- ============================================================
-- D1 schema for MOTaxIntelligence.
--
-- parents  = the verbatim, citable statute sections (the unit Atlas cites).
-- children = embedding windows; each carries EXACT offsets into its parent so a
--            vector hit resolves to the parent by foreign key, never by text
--            search. Vectors themselves live in Vectorize (mo-tax-vectors),
--            keyed by children.id.
-- parents_fts = optional lexical leg (exact term / citation lookup).
--
-- Apply:  wrangler d1 execute mo-tax --file src/schema.sql   (add --remote to deploy)
-- ============================================================

CREATE TABLE IF NOT EXISTS parents (
  id             TEXT PRIMARY KEY,       -- mo:143:143.436 | mo:guidance:dor-pte-faq | mo:regulation:12csr10-2
  citation       TEXT NOT NULL,          -- "Mo. Rev. Stat. § 143.436"
  chapter        TEXT NOT NULL,          -- statute chapter, or 'guidance' / 'regulations'
  section        TEXT NOT NULL,
  catchline      TEXT,
  effective_date TEXT,
  statute_year   TEXT,
  authority      TEXT,                   -- primary | fallback | guidance | regulation
  entity_tags    TEXT NOT NULL,          -- JSON array
  ent_llc_single INTEGER NOT NULL DEFAULT 0,
  ent_llc_multi  INTEGER NOT NULL DEFAULT 0,
  ent_s_corp     INTEGER NOT NULL DEFAULT 0,
  ent_general    INTEGER NOT NULL DEFAULT 0,
  source         TEXT,
  source_url     TEXT NOT NULL,
  retrieved_at   TEXT NOT NULL,
  checksum       TEXT NOT NULL,          -- sha256 of the PARSED verbatim body -- the citable-drift signal
  -- sha256 of the RAW bytes as served (HTML or PDF), computed at fetch time
  -- (scripts/fetch.mjs). Lets the deployed Worker's cron re-fetch a
  -- plain-fetchable source_url and detect "the page changed" without
  -- duplicating the HTML/PDF extraction pipeline inside the Worker -- see
  -- src/db-management.ts's checkSourceDrift. NULL for rows ingested before
  -- this column existed.
  raw_checksum   TEXT,
  char_len       INTEGER NOT NULL,
  body           TEXT NOT NULL           -- VERBATIM section text (the citable letter)
);

CREATE INDEX IF NOT EXISTS idx_parents_section ON parents(section);
CREATE INDEX IF NOT EXISTS idx_parents_chapter ON parents(chapter);
CREATE INDEX IF NOT EXISTS idx_parents_source_url ON parents(source, source_url);

CREATE TABLE IF NOT EXISTS children (
  id             TEXT PRIMARY KEY,       -- mo:143:143.436#3
  parent_id      TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  start_char     INTEGER NOT NULL,       -- exact offset into parents.body
  end_char       INTEGER NOT NULL,       -- body.slice(start_char,end_char) === text
  text           TEXT NOT NULL,          -- verbatim window
  breadcrumb     TEXT,                   -- deterministic path (embedded, not cited)
  ent_llc_single INTEGER NOT NULL DEFAULT 0,
  ent_llc_multi  INTEGER NOT NULL DEFAULT 0,
  ent_s_corp     INTEGER NOT NULL DEFAULT 0,
  ent_general    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_children_parent ON children(parent_id);

-- Lexical leg. Content-linked FTS5 over the verbatim parent body.
CREATE VIRTUAL TABLE IF NOT EXISTS parents_fts USING fts5(
  body,
  citation UNINDEXED,
  content='parents',
  content_rowid='rowid'
);

-- Append-only audit log: cron drift-checks, on-demand /admin/verify runs, and
-- /admin/ingest calls. "Database management" needs a record that a
-- maintenance pass actually ran (and what it found) even when it found
-- nothing -- a silent cron is indistinguishable from a broken one.
CREATE TABLE IF NOT EXISTS ingestion_event (
  id           TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,   -- ingest_completed | drift_check_completed | source_drift_detected | verify_completed | verify_failed
  detail_json  TEXT NOT NULL,
  occurred_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ingestion_event_time ON ingestion_event(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingestion_event_type ON ingestion_event(event_type, occurred_at DESC);
