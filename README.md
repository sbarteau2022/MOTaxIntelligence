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

# pull → build → verify → ingest (repeat --source fetch per statute source)
npm run pull:fetch                              # slow + polite; resumable; default source is justia
npm run pull:fetch -- --source revisor          # official source (JS-rendered; harden later)
npm run pull:fetch -- --source supplemental     # DOR guidance FAQ pages
npm run pull:fetch -- --source regulations      # 12 CSR 10 (PDF) -- see docs/SOURCES.md
npm run pull:build                              # processes ALL fetched sources in one pass
npm run pull:verify
INGEST_URL=https://motaxintelligence.<subdomain>.workers.dev SERVICE_KEY=... npm run pull:ingest

npm run deploy
```

## Development

```bash
npm install
cp .dev.vars.example .dev.vars   # set TAX_SERVICE_KEY for local /admin/* auth
npm run dev                      # wrangler dev
npm test                         # vitest — chunk invariant, entity classifier, retrieval
                                  # grouping, db-management, PDF parsing, console (54 tests)
npm run typecheck                # tsc --noEmit
```

`.github/workflows/check.yml` runs `typecheck` + `test` on every pull request and on
push to `main` — the gate for the flawlessness invariants this repo relies on.

## Automated pull (CI)

The pull runs where the network is open. `.github/workflows/pull.yml` executes
`fetch → build → verify` on a GitHub-hosted runner (both statute sources resist
headless access — revisor renders its list via JS, Justia sits behind
Cloudflare — so fetching uses a real browser via Playwright), uploads the raw
HTML and built corpus as artifacts, and ingests to the Worker when `INGEST_URL`
+ `TAX_SERVICE_KEY` repo secrets are set. It runs monthly and on manual
dispatch:

- **Dispatch** (Actions → *pull-statutes* → Run workflow): `source`
  (`justia` | `revisor`), `chapter`, and `include_regulations` (12 CSR 10 PDFs,
  off by default until their division list is verified) inputs.
- The default run pulls statutes + DOR guidance. Artifacts upload even on
  failure, so the first run doubles as **selector validation** — download
  `raw-html`, confirm `sources/manifest.json` selectors against the real DOM,
  re-run. `build`/`verify` fail loudly on any drift/gap/untagged section, so a
  green run means a flawless corpus.

## Database management

`POST /admin/verify` and `GET /admin/stats` (both `TAX_SERVICE_KEY`-gated, like
`/admin/ingest`) run/read the same maintenance passes as the weekly Cron Trigger
(`wrangler.toml`) — a DB-level integrity re-check plus a source-drift check against the
plain-fetchable sources. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#database-management-cron--on-demand).

```bash
curl -sX POST https://motaxintelligence.<subdomain>.workers.dev/admin/verify -H "authorization: Bearer $TAX_SERVICE_KEY"
curl -s https://motaxintelligence.<subdomain>.workers.dev/admin/stats -H "authorization: Bearer $TAX_SERVICE_KEY"
```

## Console

`GET /` (and `/console`) serves a query console straight from the Worker — no
build step, no separate deploy. Ask a question, filter by entity class, and get
whole sections back with the matched embedding windows highlighted **inside**
the verbatim text, plus source URL, retrieval date, and checksum on every hit.

It is served by the Worker rather than hosted separately on purpose: no route
here sets CORS headers, so a console on any other origin would have its
`POST /query` blocked by the browser. Same-origin means it works the moment you
deploy, without widening the API's CORS surface just to serve a UI.

`/admin/*` is deliberately absent from the console — those routes are gated by
`TAX_SERVICE_KEY`, and a full-scope key has no business being typed into a
browser tab. `/health` (unauthenticated) is the only status surface exposed.

## Query

```bash
curl -sX POST https://motaxintelligence.<subdomain>.workers.dev/query \
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
