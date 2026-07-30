// ============================================================
// PARENT–CHILD CHUNKER — the no-drift guarantee lives here.
//
// The whole point of this file is the invariant that Elle's own retrieval
// does NOT hold (see docs/RETRIEVAL_CONTRACT.md): for every child chunk,
//
//     parent.body.slice(child.start_char, child.end_char) === child.text
//
// EXACTLY, byte for byte. Elle's chunker rebuilds chunk text with
// `words.join(' ')`, collapsing whitespace, and then tries to relocate the
// chunk in the source with `fullText.indexOf(chunkText)` — which silently
// fails on any whitespace difference and falls back to the top of the
// document. That is drift. We never rebuild text; we only ever carry
// character offsets into the verbatim parent body and slice by them. A hit
// on any child therefore recalls the exact parent span with zero drift.
//
// The parent (the whole statute section) is the citable unit. Children exist
// ONLY to be embedded (bge-large sees ~512 tokens / ~2000 chars, so a long
// section must be embedded as several overlapping windows). At query time a
// child hit is resolved to its parent by foreign key — never by text search.
// ============================================================

// bge-large-en-v1.5 truncates its input at ~512 tokens. We keep windows
// comfortably under that in characters (Workers AI itself slices input to
// 2000 chars in Elle). 1400 chars target leaves headroom for the deterministic
// breadcrumb prefix that gets prepended at embed time.
export const DEFAULT_MAX_CHARS = 1400;
export const DEFAULT_OVERLAP_CHARS = 200;

/**
 * Split a verbatim section body into ordered "atoms" — the smallest units we
 * are willing to break between — while tracking each atom's exact character
 * span in the original body. Preference order for a boundary:
 *   1. subsection markers at line start:  (1) (2) (a) (b) 1. 2.
 *   2. blank-line paragraph breaks
 * We DO NOT normalize, trim, or rejoin — every atom is `body.slice(s, e)` and
 * the atoms tile the body with no gaps and no overlaps.
 *
 * @param {string} body verbatim section text
 * @returns {{start:number,end:number}[]}
 */
export function atomize(body) {
  if (typeof body !== 'string') throw new TypeError('atomize: body must be a string');
  if (body.length === 0) return [];

  // Boundary = start of a line that begins a new subsection, OR the position
  // right after a blank line. We collect candidate cut points, then build
  // atoms as [cut_i, cut_{i+1}). Offsets are into the ORIGINAL body.
  const cuts = new Set([0, body.length]);

  // Blank-line paragraph breaks: a run of \n\s*\n. Cut at the index where the
  // following paragraph starts.
  const paraRe = /\n[ \t]*\n[ \t]*/g;
  for (let m; (m = paraRe.exec(body)); ) {
    cuts.add(m.index + m[0].length);
  }

  // Subsection markers at the start of a line: optional leading spaces, then
  // (1) / (a) / (iv) / 1. / A. — the shapes RSMo uses. Cut at the marker's
  // line start so the marker stays with its clause.
  const subRe = /(^|\n)[ \t]*(\([0-9]+\)|\([a-z]+\)|\([ivxl]+\)|[0-9]+\.)/gim;
  for (let m; (m = subRe.exec(body)); ) {
    // m.index points at the '\n' (or -1+1 for start); the clause begins after
    // the newline. For start-of-string (m[1] === ''), cut at m.index.
    const cut = m[1] === '' ? m.index : m.index + 1;
    cuts.add(cut);
  }

  const sorted = [...cuts].sort((a, b) => a - b);
  const atoms = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (end > start) atoms.push({ start, end });
  }
  return atoms;
}

/**
 * Pack atoms into overlapping windows no larger than maxChars. Windows are
 * emitted as {start_char, end_char} spans into the verbatim body. Overlap is
 * achieved by re-including trailing atoms of the previous window whose combined
 * length fits within overlapChars. A single atom larger than maxChars is hard
 * split by character with overlap (still exact offsets).
 *
 * @param {string} body verbatim section text
 * @param {{maxChars?:number, overlapChars?:number}} [opts]
 * @returns {{start_char:number, end_char:number, text:string}[]}
 */
export function windowize(body, opts = {}) {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = opts.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  if (maxChars <= 0) throw new RangeError('maxChars must be > 0');
  if (overlapChars < 0 || overlapChars >= maxChars) {
    throw new RangeError('overlapChars must be in [0, maxChars)');
  }
  if (body.length === 0) return [];
  if (body.length <= maxChars) {
    return [{ start_char: 0, end_char: body.length, text: body }];
  }

  const atoms = atomize(body);
  const windows = [];
  let cur = []; // atoms in the current window

  const flush = () => {
    if (!cur.length) return;
    const start = cur[0].start;
    const end = cur[cur.length - 1].end;
    windows.push({ start_char: start, end_char: end, text: body.slice(start, end) });
  };

  for (const atom of atoms) {
    const atomLen = atom.end - atom.start;

    // Oversized atom: flush what we have, then hard-split the atom by char.
    if (atomLen > maxChars) {
      flush();
      cur = [];
      let s = atom.start;
      while (s < atom.end) {
        const e = Math.min(s + maxChars, atom.end);
        windows.push({ start_char: s, end_char: e, text: body.slice(s, e) });
        if (e >= atom.end) break;
        s = e - overlapChars; // exact-offset overlap
      }
      continue;
    }

    const curStart = cur.length ? cur[0].start : atom.start;
    const prospectiveLen = atom.end - curStart;
    if (cur.length && prospectiveLen > maxChars) {
      flush();
      // Seed the next window with trailing atoms of the previous one for
      // overlap, bounded by overlapChars.
      const carried = [];
      let carriedLen = 0;
      for (let i = cur.length - 1; i >= 0; i--) {
        const l = cur[i].end - cur[i].start;
        if (carriedLen + l > overlapChars) break;
        carried.unshift(cur[i]);
        carriedLen += l;
      }
      cur = carried;
    }
    cur.push(atom);
  }
  flush();
  return windows;
}

/**
 * Build child records for a parent section. Each child is verbatim-sliceable
 * from the parent body and carries a deterministic breadcrumb (Chapter › § ›
 * subsection path) used only to enrich the EMBEDDING input — never the stored
 * or cited text.
 *
 * @param {object} parent  { id, chapter, section, catchline, body }
 * @param {{maxChars?:number, overlapChars?:number}} [opts]
 * @returns {object[]} children
 */
export function chunkParent(parent, opts = {}) {
  const { id, chapter, section, catchline, body } = parent;
  if (!id) throw new Error('chunkParent: parent.id required');
  if (typeof body !== 'string' || body.length === 0) {
    throw new Error(`chunkParent: parent ${id} has empty body`);
  }
  const windows = windowize(body, opts);
  return windows.map((w, seq) => {
    const breadcrumb = buildBreadcrumb({ chapter, section, catchline, body, at: w.start_char });
    return {
      id: `${id}#${seq}`,
      parent_id: id,
      seq,
      start_char: w.start_char,
      end_char: w.end_char,
      text: w.text, // verbatim: body.slice(start_char, end_char)
      breadcrumb,
    };
  });
}

/**
 * Deterministic, verbatim breadcrumb — NOT an LLM paraphrase. Reconstructs the
 * subsection path by reading the marker at (or immediately before) the window
 * start. Safe to embed and to show; carries no invented text.
 */
export function buildBreadcrumb({ chapter, section, catchline, body, at }) {
  const head = `RSMo Chapter ${chapter} § ${section}${catchline ? ` — ${catchline}` : ''}`;
  const upto = body.slice(0, at + 1);
  // Nearest preceding subsection marker on its own line.
  const markers = [...upto.matchAll(/(?:^|\n)[ \t]*(\([0-9]+\)|\([a-z]+\)|\([ivxl]+\))/gim)];
  const last = markers.length ? markers[markers.length - 1][1] : '';
  return last ? `${head} ${last}` : head;
}

/**
 * Verify the load-bearing invariant across a parent+children set. Returns a
 * list of violations (empty === flawless). Used by scripts/verify.mjs and the
 * unit tests — the no-drift promise is only real if this passes on 100% of the
 * corpus.
 */
export function verifyChildren(parent, children) {
  const problems = [];
  const covered = [];
  for (const c of children) {
    const slice = parent.body.slice(c.start_char, c.end_char);
    if (slice !== c.text) {
      problems.push(`child ${c.id}: slice !== text (offsets ${c.start_char}..${c.end_char})`);
    }
    if (c.parent_id !== parent.id) {
      problems.push(`child ${c.id}: parent_id ${c.parent_id} !== ${parent.id}`);
    }
    covered.push([c.start_char, c.end_char]);
  }
  // Coverage: the union of child ranges must span the whole body (overlaps ok).
  covered.sort((a, b) => a[0] - b[0]);
  let reach = 0;
  for (const [s, e] of covered) {
    if (s > reach) { problems.push(`gap in coverage at ${reach}..${s}`); break; }
    reach = Math.max(reach, e);
  }
  if (children.length && reach < parent.body.length) {
    problems.push(`coverage ends at ${reach}, body length ${parent.body.length}`);
  }
  return problems;
}
