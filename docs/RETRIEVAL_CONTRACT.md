# Retrieval contract — the no-drift guarantee

This document is the promise the code keeps and the test suite enforces.

## The invariant

For every child chunk `c` with parent `p`:

```
p.body.slice(c.start_char, c.end_char) === c.text        // byte-for-byte
```

and the union of all children's `[start_char, end_char)` covers `[0, p.body.length)`
with no gaps. Enforced by `verifyChildren()` (pipeline/lib/chunk.mjs), asserted in
`test/chunk.test.mjs`, and re-checked over the whole corpus by `scripts/verify.mjs`
before anything is ingested. A build that violates it does not ship.

## The read path (small-to-big)

1. Embed the query with `@cf/baai/bge-large-en-v1.5` (same model as Elle/Atlas).
2. Vectorize returns nearest **child** windows (optionally entity-filtered).
3. Each match carries `parent_id`, `start_char`, `end_char` in its metadata.
4. Group by `parent_id`; load the **verbatim parent** from D1 **by primary key**.
5. Return the whole section + `matched_spans`. The child text is never returned.

Because step 4 is a key lookup, a hit on subsection (2) of a long section returns the
entire section — (1) through (n) — with the exact same bytes that were fetched and
checksummed. There is no `indexOf`, no whitespace re-matching, no window reconstruction,
and no model in the path. **Drift is not mitigated; it is impossible.**

## Why Elle's retrieval could not be reused as-is

Traced in `elle-worker` at time of writing:

| Elle behavior | Consequence for statutes |
|---|---|
| `chunker.ts` rebuilds chunk text as `words.join(' ')` | collapses whitespace → text no longer matches source |
| `contextualizer.ts` relocates via `fullText.indexOf(chunkText)` | fails on any whitespace diff → silent fallback to `slice(0, window)` (wrong section) |
| `corpus_chunks.start_char/end_char` are placeholders | no reliable offsets to reconstruct position |
| dense index embeds `contextual_text` = **LLM-generated** context + chunk | cites a paraphrase; hallucination surface |
| pipeline returns the matched chunk, no parent expansion | a mid-section hit returns a fragment, not the section |

MOTaxIntelligence keeps the good parts of that stack (bge-large, Vectorize, D1, hybrid
option) and replaces the lossy chunk/context/relocate machinery with verbatim
parent-child + FK resolution.

## Provenance (citable to the letter)

Every parent stores `source_url`, `retrieved_at`, `statute_year`, and a `checksum`
(sha256 of the verbatim body). `verify.mjs` re-hashes the body and fails on any
mismatch, so a citation always resolves to an exact, dated, verifiable span, and any
post-fetch mutation is caught before ingest.
