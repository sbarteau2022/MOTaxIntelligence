# Sources

Ranked for a "flawless, citable to the letter" corpus.

## Statute (the letter of the law)

1. **Missouri Revisor of Statutes** — official, section-addressable. `OneSection.aspx?section=NNN.NNN`.
   - Authority of record. **Bot-protected** (403 to plain fetch / cloud IPs) → fetched
     with Playwright. Enumerate a chapter via `OneChapter.aspx?chapter=NNN`.
2. **Justia — US Codes / Missouri** — clean HTML mirror, whole-chapter pages. Fallback when
   revisor blocks or for fast bulk text. It's the **2025 codification**; treat revisor as
   the freshness authority and record `statute_year`.

### Chapters ingested

| Chapter | Title | Why |
|---|---|---|
| **143** | Income Tax | Individual/fiduciary/corporate income tax; **§143.471** S-corp treatment; **§143.436** SALT-Parity / pass-through entity election |
| **347** | Missouri Limited Liability Company Act | Formation/governance for single- and multi-member LLCs |
| **351** | General and Business Corporation Law | Corporate law underlying S-corp entities |

## Administrative guidance (how it's administered — never outranks statute)

Ingested as `authority = "guidance"` parents so a citation never mistakes guidance for
the statute. **Wired**: `npm run pull:fetch --source supplemental` → `pull:build` →
`pull:verify` → `pull:ingest` (same four-stage pipeline as the statute chapters).

- **DOR — SALT Parity Act FAQs** — `dor.mo.gov/faq/taxation/business/salt-parity-act.html`
- **DOR — Pass-Through Entity Tax FAQs** — `dor.mo.gov/faq/taxation/business/entity-tax.html`
- **DOR — MO-PTE instructions** (PDF) — not yet in the manifest; add as a `supplemental.pages`
  entry with `engine: 'pdf'` (a `regulations`-style entry, not `fetch`) once prioritized.

## Regulations (binding, but not the statute itself)

**12 CSR 10** — Missouri Code of State Regulations, Title 12 (Department of Revenue),
promulgated under statutory authority. Carries binding administrative detail the statute
underspecifies. Ingested as `authority = "regulation"` — ranks below statute, above
informal FAQ guidance. **Partially wired**:

- Confirmed real, PDF-served at `sos.mo.gov` (`sources/manifest.json`'s `regulations`
  block has the actual index URL and PDF URL pattern, plus a starting division list:
  2, 10, 26, 41, 110).
- `scripts/fetch.mjs --source regulations` downloads the PDFs; `pipeline/lib/parse.mjs`'s
  `parsePdfSection` extracts text via `pdf-parse` (tested against a real PDF fixture,
  `test/parse-pdf.test.mjs`).
- **Not yet done**: the division list is a starting set, not verified-complete (index-page
  auto-discovery isn't wired — the index page's link markup hasn't been inspected against
  a live fetch); and no `entity-map.json` rule exists yet for `chapter: 'regulations'`, so
  every fetched division is reported UNTAGGED and blocked from the corpus until a human
  reviews the real text and adds a rule (`sources/entity-map.json`'s `_regulations_note`)
  — same discipline as an unreviewed statute section, deliberately not defaulted.

## Entity-class logic (Missouri conforms to federal default classification)

- **Single-member LLC** → disregarded; income on the owner's **MO-1040** (Chapter 143
  individual provisions). Entity law: Chapter 347.
- **Multi-member LLC** → partnership; **MO-1065**. *(Atlas targets this.)*
- **S corp** (incl. LLC electing S) → **MO-1120S**; §143.471. Multi-unit structure.
- **§143.436** — only partnerships and S corporations may make the pass-through entity
  (SALT Parity) election; the tax rate equals the highest individual rate; members get a
  pro-rata credit; MO-PTE does **not** replace the MO-1065/MO-1120S filing.

Tagging is curated in `sources/entity-map.json`, not inferred — see
`docs/ARCHITECTURE.md`.

## Freshness

Statute text changes slowly but is versioned by year and amended. Every parent records
`source_url` + `retrieved_at` + `statute_year` + `checksum`. Re-run `fetch → build →
verify`; a changed body yields a new checksum, which `verify.mjs` surfaces.
