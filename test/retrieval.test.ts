import { describe, it, expect, vi } from 'vitest';
import { retrieve } from '../src/retrieval';
import type { Env } from '../src/types';

const FULL_BODY =
  '(1) definitions ...\n(2) an affected business entity may elect ...\n(3) each member shall be allowed a credit ...';

// A hit lands on the child covering subsection (2) — mid-section. The read path
// must still return the WHOLE verbatim body, resolved by parent_id, not the
// child fragment.
function makeEnv(capturedFilter: { value?: unknown }): Env {
  return {
    AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
    VECTORIZE: {
      query: vi.fn(async (_v: number[], opts: any) => {
        capturedFilter.value = opts.filter;
        return {
          matches: [
            { id: 'mo:143:143.436#1', score: 0.91, metadata: { parent_id: 'mo:143:143.436', start_char: 20, end_char: 60 } },
            { id: 'mo:143:143.436#2', score: 0.78, metadata: { parent_id: 'mo:143:143.436', start_char: 60, end_char: 95 } },
            { id: 'mo:347:347.037#0', score: 0.55, metadata: { parent_id: 'mo:347:347.037', start_char: 0, end_char: 30 } },
          ],
        };
      }),
    },
    DB: {
      prepare: (_sql: string) => ({
        bind: (...ids: string[]) => ({
          all: async () => ({
            results: [
              {
                id: 'mo:143:143.436', citation: 'Mo. Rev. Stat. § 143.436', chapter: '143', section: '143.436',
                catchline: 'Pass-through entity tax', effective_date: 'Aug 28, 2022', statute_year: '2025',
                authority: 'primary', entity_tags: JSON.stringify(['s_corp', 'llc_multi_member']),
                source_url: 'https://revisor.mo.gov/main/OneSection.aspx?section=143.436',
                retrieved_at: '2026-07-30T00:00:00Z', checksum: 'abc', body: FULL_BODY,
              },
              {
                id: 'mo:347:347.037', citation: 'Mo. Rev. Stat. § 347.037', chapter: '347', section: '347.037',
                catchline: 'Members', effective_date: null, statute_year: '2025', authority: 'primary',
                entity_tags: JSON.stringify(['llc_single_member', 'llc_multi_member']),
                source_url: 'https://revisor.mo.gov/main/OneSection.aspx?section=347.037',
                retrieved_at: '2026-07-30T00:00:00Z', checksum: 'def', body: 'LLC members ...',
              },
            ].filter((r) => ids.includes(r.id)),
          }),
        }),
      }),
    } as unknown as D1Database,
  } as unknown as Env;
}

describe('retrieve — small-to-big, zero drift', () => {
  it('a mid-section child hit returns the WHOLE verbatim parent body', async () => {
    const cap: { value?: unknown } = {};
    const results = await retrieve(makeEnv(cap), 'can an S corp elect the pass-through entity tax?', { topK: 5 });
    const top = results[0];
    expect(top.section).toBe('143.436');
    expect(top.body).toBe(FULL_BODY); // full section, not the matched window
  });

  it('groups multiple child hits of one parent, keeps best score + all spans', async () => {
    const results = await retrieve(makeEnv({}), 'pass-through entity tax election', { topK: 5 });
    const top = results.find((r) => r.section === '143.436')!;
    expect(top.score).toBeCloseTo(0.91);
    expect(top.matched_spans.length).toBe(2);
    expect(top.matched_spans[0].score).toBeGreaterThanOrEqual(top.matched_spans[1].score); // sorted
  });

  it('ranks parents by best child score', async () => {
    const results = await retrieve(makeEnv({}), 'q', { topK: 5 });
    expect(results[0].section).toBe('143.436'); // 0.91 > 0.55
  });

  it('applies the entity filter to the Vectorize query', async () => {
    const cap: { value?: unknown } = {};
    await retrieve(makeEnv(cap), 'q', { entity: 'llc_multi' });
    expect(cap.value).toEqual({ ent_llc_multi: true });
  });

  it('no entity filter when entity is any', async () => {
    const cap: { value?: unknown } = {};
    await retrieve(makeEnv(cap), 'q', { entity: 'any' });
    expect(cap.value).toBeUndefined();
  });
});
