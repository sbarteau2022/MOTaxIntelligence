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

## What is deliberately NOT here

- No LLM in the retrieval path (no contextualizer). Statutes are cited verbatim.
- No silent classification. Untagged sections block the build until a human adds a rule.
- No committed vectors/raw HTML — reproducible from `sources/` + code.
