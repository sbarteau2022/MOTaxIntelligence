import { describe, it, expect } from 'vitest';
import { atomize, windowize, chunkParent, verifyChildren, DEFAULT_MAX_CHARS } from '../pipeline/lib/chunk.mjs';

// A realistic long statute body with subsection markers and blank lines.
const BODY = [
  '143.436. Pass-through entity tax, election, computation.',
  '',
  '(1) As used in this section, the following terms mean:',
  '(a) "Affected business entity", any partnership or S corporation that elects to become subject to the tax;',
  '(b) "Member", a shareholder of an S corporation or a partner in a partnership.',
  '',
  '(2) For tax years ending on or after December 31, 2022, an affected business entity may elect to pay the pass-through entity tax at a rate equal to the highest rate of tax under section 143.011.',
  '',
  '(3) Each electing entity shall report and remit the tax as provided by the director of revenue, and each member shall be allowed a credit against the member\'s Missouri income tax equal to the member\'s direct and indirect pro rata share of the tax paid.',
].join('\n');

describe('atomize', () => {
  it('produces atoms that tile the body exactly with no gaps or overlaps', () => {
    const atoms = atomize(BODY);
    expect(atoms.length).toBeGreaterThan(1);
    expect(atoms[0].start).toBe(0);
    expect(atoms[atoms.length - 1].end).toBe(BODY.length);
    for (let i = 1; i < atoms.length; i++) {
      expect(atoms[i].start).toBe(atoms[i - 1].end); // contiguous
    }
  });

  it('every atom slice comes verbatim from the body', () => {
    for (const a of atomize(BODY)) {
      expect(typeof BODY.slice(a.start, a.end)).toBe('string');
      expect(a.end).toBeGreaterThan(a.start);
    }
  });
});

describe('windowize — the no-drift invariant', () => {
  it('every window text === body.slice(start,end) EXACTLY', () => {
    const wins = windowize(BODY, { maxChars: 200, overlapChars: 40 });
    expect(wins.length).toBeGreaterThan(1);
    for (const w of wins) {
      expect(w.text).toBe(BODY.slice(w.start_char, w.end_char));
    }
  });

  it('windows cover the whole body (union has no gaps)', () => {
    const wins = windowize(BODY, { maxChars: 200, overlapChars: 40 }).sort((a, b) => a.start_char - b.start_char);
    let reach = 0;
    for (const w of wins) {
      expect(w.start_char).toBeLessThanOrEqual(reach);
      reach = Math.max(reach, w.end_char);
    }
    expect(reach).toBe(BODY.length);
  });

  it('respects maxChars for normal atoms', () => {
    for (const w of windowize(BODY, { maxChars: 300, overlapChars: 50 })) {
      // an oversized single atom can exceed maxChars only via hard-split, which
      // itself caps at maxChars — so no window should exceed maxChars.
      expect(w.end_char - w.start_char).toBeLessThanOrEqual(300);
    }
  });

  it('hard-splits a single oversized atom while staying verbatim', () => {
    const big = 'X'.repeat(5000); // one atom, no boundaries
    const wins = windowize(big, { maxChars: 1000, overlapChars: 100 });
    expect(wins.length).toBeGreaterThan(4);
    for (const w of wins) {
      expect(w.text).toBe(big.slice(w.start_char, w.end_char));
      expect(w.end_char - w.start_char).toBeLessThanOrEqual(1000);
    }
    // full coverage
    const sorted = wins.sort((a, b) => a.start_char - b.start_char);
    let reach = 0;
    for (const w of sorted) { expect(w.start_char).toBeLessThanOrEqual(reach); reach = Math.max(reach, w.end_char); }
    expect(reach).toBe(big.length);
  });

  it('short body → single window spanning the whole thing', () => {
    const wins = windowize('short section text', {});
    expect(wins).toHaveLength(1);
    expect(wins[0]).toMatchObject({ start_char: 0, end_char: 'short section text'.length });
  });
});

describe('chunkParent + verifyChildren', () => {
  const parent = { id: 'mo:143:143.436', chapter: '143', section: '143.436', catchline: 'Pass-through entity tax', body: BODY };

  it('emits children that pass the invariant on a small window size', () => {
    const kids = chunkParent(parent, { maxChars: 180, overlapChars: 40 });
    expect(kids.length).toBeGreaterThan(1);
    expect(verifyChildren(parent, kids)).toEqual([]);
    // ids and FK
    for (const k of kids) {
      expect(k.parent_id).toBe(parent.id);
      expect(k.id.startsWith(parent.id + '#')).toBe(true);
      expect(BODY.slice(k.start_char, k.end_char)).toBe(k.text);
    }
  });

  it('breadcrumb reflects the nearest preceding subsection marker', () => {
    const kids = chunkParent(parent, { maxChars: 120, overlapChars: 20 });
    const withSub = kids.find((k) => /\(\d+\)|\([a-z]+\)/.test(k.breadcrumb.replace('§ 143.436', '')));
    expect(withSub).toBeTruthy();
    expect(withSub.breadcrumb).toContain('143.436');
  });

  it('verifyChildren catches a tampered offset', () => {
    const kids = chunkParent(parent, { maxChars: 180, overlapChars: 40 });
    kids[0].end_char += 3; // simulate drift
    expect(verifyChildren(parent, kids).length).toBeGreaterThan(0);
  });

  it('default max chars keeps windows within bge-large range', () => {
    const long = { ...parent, body: BODY.repeat(20) };
    const kids = chunkParent(long, {});
    for (const k of kids) expect(k.text.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
  });
});
