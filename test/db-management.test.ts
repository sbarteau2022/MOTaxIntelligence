import { describe, it, expect, vi, afterEach } from 'vitest';
import { runIntegrityCheck, checkSourceDrift, logIngestionEvent } from '../src/db-management';
import type { Env } from '../src/types';

// Minimal fake D1 — dispatches by a substring of the SQL text, since
// db-management.ts issues a handful of distinct, fixed-shape queries. Each
// entry returns whatever the test configured for that query.
function fakeEnv(handlers: {
  parentsPage?: Array<{ id: string; body: string }>;
  childrenByParent?: Record<string, Array<{ id: string; parent_id: string; start_char: number; end_char: number; text: string }>>;
  driftCandidates?: Array<{ id: string; source_url: string; raw_checksum: string }>;
  onInsert?: (sql: string, args: unknown[]) => void;
}): Env {
  const prepare = (sql: string) => {
    const bind = (...args: unknown[]) => ({
      all: async () => {
        if (sql.includes('FROM parents ORDER BY id')) {
          return { results: handlers.parentsPage ?? [] };
        }
        if (sql.includes('FROM children WHERE parent_id IN')) {
          const ids = args as string[];
          const rows = ids.flatMap((pid) => handlers.childrenByParent?.[pid] ?? []);
          return { results: rows };
        }
        if (sql.includes('raw_checksum IS NOT NULL')) {
          return { results: handlers.driftCandidates ?? [] };
        }
        return { results: [] };
      },
      first: async () => null,
      run: async () => {
        handlers.onInsert?.(sql, args);
        return { meta: { changes: 1 } };
      },
    });
    return { bind };
  };
  return { DB: { prepare } as unknown as D1Database } as unknown as Env;
}

describe('logIngestionEvent', () => {
  it('writes event_type, a JSON detail blob, and an ISO timestamp', async () => {
    let captured: unknown[] = [];
    const env = fakeEnv({ onInsert: (_sql, args) => { captured = args; } });
    await logIngestionEvent(env, 'verify_completed', { parentsChecked: 3 });
    expect(captured[1]).toBe('verify_completed');
    expect(JSON.parse(captured[2] as string)).toEqual({ parentsChecked: 3 });
    expect(() => new Date(captured[3] as string).toISOString()).not.toThrow();
  });
});

describe('runIntegrityCheck', () => {
  it('reports zero violations when every child slice matches its parent body', async () => {
    const env = fakeEnv({
      parentsPage: [{ id: 'mo:143:143.436', body: 'ABCDEFGHIJ' }],
      childrenByParent: {
        'mo:143:143.436': [{ id: 'mo:143:143.436#0', parent_id: 'mo:143:143.436', start_char: 0, end_char: 5, text: 'ABCDE' }],
      },
    });
    const result = await runIntegrityCheck(env);
    expect(result.parentsChecked).toBe(1);
    expect(result.childrenChecked).toBe(1);
    expect(result.violations).toHaveLength(0);
  });

  it('flags a child whose slice no longer matches its text', async () => {
    const env = fakeEnv({
      parentsPage: [{ id: 'mo:143:143.436', body: 'ABCDEFGHIJ' }],
      childrenByParent: {
        'mo:143:143.436': [{ id: 'mo:143:143.436#0', parent_id: 'mo:143:143.436', start_char: 0, end_char: 5, text: 'ZZZZZ' }],
      },
    });
    const result = await runIntegrityCheck(env);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ parent_id: 'mo:143:143.436', child_id: 'mo:143:143.436#0' });
    expect(result.violations[0].reason).toMatch(/slice !== text/);
  });

  it('checks every parent on the page, not just the first', async () => {
    const env = fakeEnv({
      parentsPage: [
        { id: 'mo:143:143.436', body: 'AAAAA' },
        { id: 'mo:347:347.037', body: 'BBBBB' },
      ],
      childrenByParent: {
        'mo:143:143.436': [{ id: 'mo:143:143.436#0', parent_id: 'mo:143:143.436', start_char: 0, end_char: 5, text: 'AAAAA' }],
        'mo:347:347.037': [{ id: 'mo:347:347.037#0', parent_id: 'mo:347:347.037', start_char: 0, end_char: 5, text: 'WRONG' }],
      },
    });
    const result = await runIntegrityCheck(env);
    expect(result.parentsChecked).toBe(2);
    expect(result.childrenChecked).toBe(2);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].parent_id).toBe('mo:347:347.037');
  });
});

describe('checkSourceDrift', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('detects a checksum mismatch against freshly fetched bytes', async () => {
    const env = fakeEnv({
      driftCandidates: [
        { id: 'mo:guidance:dor-pte-faq', source_url: 'https://dor.mo.gov/faq/x.html', raw_checksum: 'stale-checksum' },
      ],
    });
    global.fetch = vi.fn(async () => new Response('freshly changed content', { status: 200 })) as unknown as typeof fetch;

    const result = await checkSourceDrift(env);
    expect(result.checked).toBe(1);
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0].parent_id).toBe('mo:guidance:dor-pte-faq');
    expect(result.drifted[0].fresh_raw_checksum).not.toBe('stale-checksum');
  });

  it('reports no drift when the fresh checksum matches', async () => {
    const body = 'unchanged content';
    const expectedHex = await sha256Hex(body);
    const env = fakeEnv({
      driftCandidates: [{ id: 'mo:guidance:dor-pte-faq', source_url: 'https://dor.mo.gov/faq/x.html', raw_checksum: expectedHex }],
    });
    global.fetch = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

    const result = await checkSourceDrift(env);
    expect(result.drifted).toHaveLength(0);
  });

  it('records a fetch failure without throwing', async () => {
    const env = fakeEnv({
      driftCandidates: [{ id: 'mo:guidance:dor-pte-faq', source_url: 'https://dor.mo.gov/faq/x.html', raw_checksum: 'abc' }],
    });
    global.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;

    const result = await checkSourceDrift(env);
    expect(result.fetchErrors).toHaveLength(1);
    expect(result.fetchErrors[0].error).toMatch(/HTTP 500/);
  });
});

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
