# Architecture

```
                    ┌─────────────────────────── build time (Node) ──────────────────────────┐
 revisor.mo.gov ──▶ fetch.mjs ──▶ data/raw/**.html ──▶ build-corpus.mjs ──▶ parents.jsonl
 justia (mirror)    (Playwright)     + .meta.json         │  parse (verbatim)   children.jsonl
 dor.mo.gov         (fetch)                               │  classify (entity-map)     │
                                                          │  chunk (parent-child)      │
                                                          └─ verify invariant ─────────┤
                                                                                       ▼
                    ┌──────────────────────── deploy / ingest ───────────────── ingest.mjs
                    │  POST /admin/ingest (TAX_SERVICE_KEY)                          │
                    ▼                                                               (batches)
            ┌───────────────── mo-tax Worker (Cloudflare) ─────────────────┐
            │  env.AI  bge-large-en-v1.5  ── embeds child (breadcrumb+text) │
            │  env.VECTORIZE  mo-tax-vectors (1024d cosine)  ◀── child vecs  │
            │        metadata: parent_id, start_char, end_char, ent_* flags  │
            │  env.DB  mo-tax (D1)                                           │
            │        parents(body VERBATIM, provenance, checksum) ◀── cite   │
            │        children(offsets), parents_fts                          │
            └───────────────────────────────────────────────────────────────┘
                    ▲  POST /query {q, entity, top_k}
                    │  embed → Vectorize (child) → group by parent_id → D1 parent (verbatim)
                 Atlas / callers
```

## Components

- **Fetcher** (`scripts/fetch.mjs`) — Playwright for bot-protected revisor.mo.gov, plain
  fetch for mirrors. Archives raw HTML + provenance. Resumable, rate-limited.
- **Parser** (`pipeline/lib/parse.mjs`) — HTML → verbatim body (entity-decode + newline
  normalize only). Selectors come from `sources/manifest.json`, tuned against a live sample.
- **Classifier** (`pipeline/lib/entity.mjs` + `sources/entity-map.json`) — curated,
  human-authored entity tagging. Keyword heuristics only *suggest*; nothing auto-classifies.
- **Chunker** (`pipeline/lib/chunk.mjs`) — parent-child with exact offsets; the no-drift
  invariant lives here.
- **Worker** (`src/`) — `/query` (small-to-big read), `/admin/ingest` (embed + write),
  `/health`. Embedding for both ingest and query happens in-Worker so vectors share
  Atlas's space.

## Atlas integration options

1. **Service binding (recommended).** Atlas binds the `mo-tax` Worker and calls `/query`.
   Clean isolation; the tax index and corpus index stay separate; entity filtering and
   citation formatting are owned here.
2. **Shared index read.** Atlas queries `mo-tax-vectors` directly (same model/dims). Only
   if you want one query to span corpus + statute; then Atlas must implement the parent-FK
   resolution this Worker already does — prefer option 1.

Atlas targets `entity: "llc_multi"` for multi-operator LLC questions and `entity: "s_corp"`
for the multi-unit structure; `general` sections surface under every filter.

## Database management (cron + on-demand)

The Worker owns two maintenance passes (`src/db-management.ts`), logged to the
`ingestion_event` table (append-only audit log — a maintenance pass that ran and found
nothing still leaves a record, so a silently broken cron is visible):

- **`runIntegrityCheck`** — re-checks the parent/child no-drift invariant
  (`parent.body.slice(start,end) === child.text`) against what's ACTUALLY in D1 right
  now, not just what `verify.mjs` checked locally before ingest. Catches a partial
  ingest or write bug the local build never saw.
- **`checkSourceDrift`** — re-fetches every plain-fetchable `source_url` already in D1
  (the Justia mirror + DOR guidance pages — **not** `revisor.mo.gov`, which is
  bot-protected and needs the local Playwright pull, and **not** PDF regulations, which
  need `pdf-parse`) and compares a fresh SHA-256 of the raw bytes against
  `parents.raw_checksum` (computed at fetch time, `scripts/fetch.mjs`). A mismatch means
  the source changed since the last local pull. This **detects** drift only — it never
  auto-reingests; the local `build → verify` pipeline is still the only path that writes
  a new body, preserving "a corpus only ships if it's perfect."

Both run on a weekly Cron Trigger (`wrangler.toml`'s `[triggers]`) and on demand via
`POST /admin/verify`. `GET /admin/stats` (row counts by authority/chapter, retrieval
date range, recent `ingestion_event` rows) is the read side of the same discipline —
both `TAX_SERVICE_KEY`-gated like `/admin/ingest`.

## What is deliberately NOT here

- No LLM in the retrieval path (no contextualizer). Statutes are cited verbatim.
- No silent classification. Untagged sections block the build until a human adds a rule.
- No committed vectors/raw HTML — reproducible from `sources/` + code.
- No auto-reingest on drift detection. The cron/`/admin/verify` only ever DETECTS and
  logs; writing a new body always goes through the local build → verify pipeline.
