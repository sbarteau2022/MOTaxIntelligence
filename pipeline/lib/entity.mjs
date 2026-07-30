// ============================================================
// ENTITY CLASSIFICATION — single-member LLC vs multi-member LLC vs S-corp.
//
// This is a LEGAL determination, so it is NOT done by keyword guessing.
// Authoritative tags come from sources/entity-map.json (curated section →
// entity-class rules). Keyword heuristics here only produce *suggestions* that
// scripts/verify.mjs surfaces for human confirmation; they never silently
// assign a class. A section that no rule covers is reported as UNTAGGED, not
// quietly dropped — that is what "flawless" requires for tax law.
//
// The three classes and why the split matters (Missouri conforms to the
// federal default classification, see docs/SOURCES.md):
//   • llc_single_member — one owner. Disregarded entity by default; income is
//       reported on the owner's individual return (Chapter 143 individual
//       provisions, Form MO-1040). No separate entity-level MO return unless it
//       elects corporate treatment.
//   • llc_multi_member — two+ owners. Partnership by default; files MO-1065.
//       (Atlas targets THIS class.)
//   • s_corp — S corporation (incl. an LLC that elected S treatment). Files
//       MO-1120S. Used for the multi-unit structure.
// A section may apply to several classes (e.g. general Chapter 143 rate
// provisions apply to all three); tags are therefore a SET. "general" marks a
// section that applies regardless of class and should not be entity-filtered.
// ============================================================

export const ENTITY_CLASSES = /** @type {const} */ ([
  'llc_single_member',
  'llc_multi_member',
  's_corp',
  'general',
]);

/**
 * Resolve the authoritative entity tags for a section from the curated map.
 * The map supports exact section keys ("143.436") and inclusive numeric ranges
 * within a chapter ({ chapter, from, to, tags }). Exact keys win over ranges.
 *
 * @param {{chapter:string, section:string}} sec
 * @param {object} entityMap parsed sources/entity-map.json
 * @returns {{tags:string[], rule:string}|null} null === no rule (UNTAGGED)
 */
export function classify(sec, entityMap) {
  const exact = entityMap.sections?.[sec.section];
  if (exact) return { tags: dedupe(exact), rule: `exact:${sec.section}` };

  const num = sectionOrdinal(sec.section);
  for (const r of entityMap.ranges ?? []) {
    if (String(r.chapter) !== String(sec.chapter)) continue;
    if (num >= sectionOrdinal(String(r.from)) && num <= sectionOrdinal(String(r.to))) {
      return { tags: dedupe(r.tags), rule: `range:${r.chapter}:${r.from}-${r.to}` };
    }
  }
  return null;
}

/**
 * Advisory keyword heuristics. Output is SUGGESTION ONLY — never authoritative.
 * verify.mjs prints these next to UNTAGGED sections so a human can add a rule.
 * @returns {string[]} suggested classes (possibly empty)
 */
export function suggestTags(body) {
  const t = body.toLowerCase();
  const out = new Set();
  if (/\bs corporation\b|\bs corp\b|section 143\.471|mo-?1120s/.test(t)) out.add('s_corp');
  if (/\bpartnership\b|\btwo or more members\b|mo-?1065|multiple members/.test(t)) out.add('llc_multi_member');
  if (/\bsingle member\b|\bdisregarded entity\b|\bsole member\b/.test(t)) out.add('llc_single_member');
  if (/\blimited liability company\b|\bllc\b/.test(t)) {
    out.add('llc_single_member');
    out.add('llc_multi_member');
  }
  return [...out];
}

/**
 * Flatten a tag set into the boolean metadata fields Vectorize filters on.
 * Vectorize metadata is a flat scalar map; a doc with multiple classes gets a
 * true flag per class, and queries filter with equality on the flag they want.
 * @param {string[]} tags
 */
export function entityFlags(tags) {
  const s = new Set(tags);
  return {
    ent_llc_single: s.has('llc_single_member') || s.has('general'),
    ent_llc_multi: s.has('llc_multi_member') || s.has('general'),
    ent_s_corp: s.has('s_corp') || s.has('general'),
    ent_general: s.has('general'),
  };
}

// "143.436" → 143436000-style ordinal that sorts correctly and supports ranges
// including decimal sub-sections like "143.1005".
export function sectionOrdinal(section) {
  const [maj, min = '0'] = String(section).split('.');
  return Number(maj) * 1_000_000 + Number(min.padEnd(6, '0'));
}

function dedupe(a) {
  return [...new Set(a)];
}
