# Marketing site

`index.html` is a self-contained, dependency-free landing page for
MOTaxIntelligence — hero, problem/solution comparison, pipeline walkthrough,
entity-coverage table, a sample `/query` request, the integrity/drift-audit
story, a three-tier pricing section (Developer / Team / Enterprise), FAQ, and
footer.

No build step: open `marketing/index.html` directly, or serve the
`marketing/` directory as static assets (e.g. Cloudflare Pages, or a
`[site]`/Workers Assets binding in `wrangler.toml` if this Worker ever wants
to serve it itself). All CSS is inlined; there are no external font or script
requests.

Pricing figures are placeholders reflecting a plausible usage-based structure
— adjust before this goes live anywhere public.
