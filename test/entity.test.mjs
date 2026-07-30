import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classify, suggestTags, entityFlags, sectionOrdinal } from '../pipeline/lib/entity.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const entityMap = JSON.parse(readFileSync(path.join(ROOT, 'sources', 'entity-map.json'), 'utf8'));

describe('classify', () => {
  it('exact section rule wins (143.436 → s_corp + multi-member LLC)', () => {
    const r = classify({ chapter: '143', section: '143.436' }, entityMap);
    expect(r.rule).toBe('exact:143.436');
    expect(r.tags.sort()).toEqual(['llc_multi_member', 's_corp']);
  });

  it('143.471 → s_corp', () => {
    expect(classify({ chapter: '143', section: '143.471' }, entityMap).tags).toEqual(['s_corp']);
  });

  it('falls through to chapter range (143.021 → general)', () => {
    const r = classify({ chapter: '143', section: '143.021' }, entityMap);
    expect(r.rule).toContain('range:143');
    expect(r.tags).toEqual(['general']);
  });

  it('chapter 347 → both LLC classes', () => {
    expect(classify({ chapter: '347', section: '347.037' }, entityMap).tags.sort())
      .toEqual(['llc_multi_member', 'llc_single_member']);
  });

  it('returns null (UNTAGGED) for an out-of-range section', () => {
    expect(classify({ chapter: '999', section: '999.001' }, entityMap)).toBeNull();
  });
});

describe('entityFlags', () => {
  it('general sets every entity flag true', () => {
    expect(entityFlags(['general'])).toEqual({
      ent_llc_single: true, ent_llc_multi: true, ent_s_corp: true, ent_general: true,
    });
  });
  it('multi-member LLC does not set single or s_corp', () => {
    const f = entityFlags(['llc_multi_member']);
    expect(f.ent_llc_multi).toBe(true);
    expect(f.ent_llc_single).toBe(false);
    expect(f.ent_s_corp).toBe(false);
  });
});

describe('suggestTags (advisory only)', () => {
  it('flags S-corp language', () => {
    expect(suggestTags('An S corporation shall file Form MO-1120S.')).toContain('s_corp');
  });
  it('flags disregarded single-member language', () => {
    expect(suggestTags('a single member limited liability company treated as a disregarded entity'))
      .toEqual(expect.arrayContaining(['llc_single_member', 'llc_multi_member']));
  });
});

describe('sectionOrdinal', () => {
  it('orders decimal subsections correctly', () => {
    expect(sectionOrdinal('143.436')).toBeLessThan(sectionOrdinal('143.471'));
    expect(sectionOrdinal('143.005')).toBeLessThan(sectionOrdinal('143.1005'));
  });
});
