# MOTaxIntelligence

Flawless, citable Missouri tax-code retrieval for the Elle/Atlas stack.

Pulls Missouri statutes (income tax + entity law), stores each **section verbatim**
as the citable unit, embeds it with the **same `bge-large-en-v1.5` model Atlas uses**,
and serves **small-to-big retrieval** where a hit anywhere inside a section always
returns the **whole section, cited to the letter, with zero drift**.

It separates the entity classes you asked for:

| Class | Default MO treatment | Return | Who uses it |
|---|---|---|---|
| `llc_single_member` | Disregarded → owner's return | MO-1040 | — |
| `llc_multi_member` | Partnership | MO-1065 | **Atlas** |
| `s_corp` | S corporation | MO-1120S | multi-unit |
| `general` | Applies across classes | — | all |

## Why this isn't just Elle's retrieval pointed at statutes

Elle's corpus retrieval is tuned for fuzzy recall over prose and **cannot** promise
no-drift, cite-to-the-letter recall (see [`docs/RETRIEVAL_CONTRACT.md`](docs/RETRIEVAL_CONTRACT.md)):
its chunker rebuilds text with `words.join(' ')` and relocates chunks with
`fullText.indexOf(chunkText)` (fails on any whitespace change → falls back to the top
of the doc), `start_char/end_char` are placeholders, and the contextual step embeds an
**LLM paraphrase** — a hallucination surface you can't cite.

MOTaxIntelligence fixes all three:

- **Parent = whole section, verbatim, in D1** — the only thing ever cited.
- **Children = embedding windows** carrying `parent_id` + **real** `start_char/end_char`.
  Invariant, checked on 100% of the corpus: `parent.body.slice(start,end) === child.text`.
- **Read path resolves child → parent by foreign key**, never by text search. A
  mid-section hit returns the exact, whole section. Drift is structurally impossible.
- **Deterministic breadcrumb** (`RSMo Chapter 143 § 143.436 (2)`) enriches the embedding
  input — never an LLM sentence between a query and a statute.

## Pipeline

```
fetch.mjs        raw HTML → data/raw/**            (Playwright for bot-protected revisor.mo.gov)
build-corpus.mjs raw → parents.jsonl + children.jsonl  (parse verbatim · classify · chunk · VERIFY)
verify.mjs       the flawlessness gate             (invariant · coverage · provenance · checksums)
ingest.mjs       → Worker /admin/ingest            (embeds in-Worker with bge-large, writes D1+Vectorize)
```

Each stage refuses to proceed on any defect: `build` fails on an untagged section or a
broken invariant; `verify` exits non-zero on any drift, gap, missing provenance, or
checksum mismatch. A corpus only ships if it's perfect.

## Quickstart

```bash
npm install

# one-time Cloudflare resources
wrangler d1 create mo-tax                       # paste id into wrangler.toml
wrangler vectorize create mo-tax-vectors --dimensions=1024 --metric=cosine
# metadata indexes (see wrangler.toml for the full list): parent_id, ent_llc_multi, ...
npm run db:schema:remote
wrangler secret put TAX_SERVICE_KEY

# pull → build → verify → ingest (repeat per source: default is statutes/revisor)
npm run pull:fetch                              # slow + polite; resumable
npm run pull:fetch -- --source justia           # statute mirror
npm run pull:fetch -- --source supplemental     # DOR guidance FAQ pages
npm run pull:fetch -- --source regulations      # 12 CSR 10 (PDF) -- see docs/SOURCES.md
npm run pull:build                              # processes ALL fetched sources in one pass
npm run pull:verify
INGEST_URL=https://mo-tax.<subdomain>.workers.dev SERVICE_KEY=... npm run pull:ingest

npm run deploy
```

## Database management

`POST /admin/verify` and `GET /admin/stats` (both `TAX_SERVICE_KEY`-gated, like
`/admin/ingest`) run/read the same maintenance passes as the weekly Cron Trigger
(`wrangler.toml`) — a DB-level integrity re-check plus a source-drift check against the
plain-fetchable sources. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#database-management-cron--on-demand).

```bash
curl -sX POST https://mo-tax.<subdomain>.workers.dev/admin/verify -H "authorization: Bearer $TAX_SERVICE_KEY"
curl -s https://mo-tax.<subdomain>.workers.dev/admin/stats -H "authorization: Bearer $TAX_SERVICE_KEY"
```

## Query

```bash
curl -sX POST https://mo-tax.<subdomain>.workers.dev/query \
  -H 'content-type: application/json' \
  -d '{"q":"Can an S corp elect the pass-through entity tax?","entity":"s_corp","top_k":3}'
```

Returns each matching **whole section** verbatim, plus `citation`, `source_url`,
`retrieved_at`, `checksum`, `entity_tags`, and the `matched_spans` (offsets that scored)
— everything needed to cite to the letter and verify against source.

`entity` ∈ `llc_single | llc_multi | s_corp | general | any`.

## Atlas integration

`mo-tax-vectors` uses the identical model/dims as `elle-corpus-vectors`, so Atlas can
query this Worker via service binding (recommended) or share the index directly. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Sources

Authoritative + clean, ranked in [`docs/SOURCES.md`](docs/SOURCES.md). Primary:
Missouri Revisor of Statutes (Ch. 143 income tax, 347 LLC Act, 351 corporations);
DOR SALT-Parity/PTE guidance for §143.436; Justia as a clean mirror/fallback.
