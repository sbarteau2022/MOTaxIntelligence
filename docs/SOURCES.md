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
the statute:

- **DOR — SALT Parity Act FAQs** — `dor.mo.gov/faq/taxation/business/salt-parity-act.html`
- **DOR — Pass-Through Entity Tax FAQs** — `dor.mo.gov/faq/taxation/business/entity-tax.html`
- **DOR — MO-PTE instructions** (PDF) — operational detail for §143.436 elections.

> Not yet wired: **12 CSR 10** (Dept. of Revenue regulations, on the Secretary of State's
> site) carries binding administrative detail the statute underspecifies. Add as a
> `guidance`-authority source when you extend the manifest.

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
