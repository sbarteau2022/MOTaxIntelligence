# Marketing site

`index.html` is a self-contained, dependency-free landing page for
MOTaxIntelligence — hero, problem/solution comparison, pipeline walkthrough,
entity-coverage table, a sample `/query` request, the integrity/drift-audit
story, a three-tier pricing section (Developer / Team / Enterprise), FAQ, and
footer.

Visual design is carried over from RAPIDAi's `ui/` redesign (the "Atlas
Command Center" system: Titanium + Gold palette, Barlow / Barlow Condensed
type, frosted-glass cards, gold pill buttons, monospace eyebrow labels) so
this reads as part of the same product family rather than a one-off skin.
Barlow/Barlow Condensed load from Google Fonts (the one external request);
everything else is inlined with no build step and no other script/font
dependency.

No build step: open `marketing/index.html` directly, or serve the
`marketing/` directory as static assets (e.g. Cloudflare Pages, or a
`[site]`/Workers Assets binding in `wrangler.toml` if this Worker ever wants
to serve it itself).

Pricing figures are placeholders reflecting a plausible usage-based structure
— adjust before this goes live anywhere public.
