// The 2026-08-07 pull built a flawless corpus (558 parents / 576 children,
// verify green) and then failed at the last step with:
//
//   TypeError: Failed to parse URL from ***/admin/ingest
//
// INGEST_URL is a secret, so CI masks it — the log could not say what was
// wrong with the value, and the script burned four retries before giving up.
// These pin the up-front validation that replaced that.

import { describe, it, expect } from 'vitest';
import { resolveIngestBase, isRetryable } from '../scripts/ingest.mjs';

describe('resolveIngestBase', () => {
  it('accepts a normal Worker origin', () => {
    expect(resolveIngestBase('https://motaxintelligence.example.workers.dev'))
      .toBe('https://motaxintelligence.example.workers.dev');
  });

  it('strips a trailing slash so the path never becomes //admin/ingest', () => {
    expect(resolveIngestBase('https://motaxintelligence.example.workers.dev/'))
      .toBe('https://motaxintelligence.example.workers.dev');
  });

  it('accepts a wrangler dev URL with a port', () => {
    expect(resolveIngestBase('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
  });

  // The actual production failure.
  it('names the missing scheme when given a bare hostname', () => {
    expect(() => resolveIngestBase('motaxintelligence.example.workers.dev'))
      .toThrow(/missing the "https:\/\/" scheme/);
  });

  it('never echoes the secret value in the error — only its shape', () => {
    const secret = 'motaxintelligence.example.workers.dev';
    try {
      resolveIngestBase(secret);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.message).not.toContain(secret);
      expect(e.message).toContain(`${secret.length} characters`);
    }
  });

  it('rejects an empty or whitespace value with a usable message', () => {
    expect(() => resolveIngestBase('')).toThrow(/INGEST_URL is empty/);
    expect(() => resolveIngestBase('   ')).toThrow(/INGEST_URL is empty/);
    expect(() => resolveIngestBase(undefined)).toThrow(/INGEST_URL is empty/);
  });

  it('rejects a non-http protocol', () => {
    expect(() => resolveIngestBase('ftp://example.com')).toThrow(/must be an http\(s\) URL/);
  });

  it('rejects an origin that already carries a path, since /admin/ingest is appended', () => {
    expect(() => resolveIngestBase('https://example.workers.dev/admin/ingest'))
      .toThrow(/ORIGIN only, with no path/);
  });
});

describe('isRetryable', () => {
  it('does not retry a 4xx — a bad service key will never succeed on retry', () => {
    expect(isRetryable(new Error('HTTP 401: unauthorized'))).toBe(false);
    expect(isRetryable(new Error('HTTP 404: not found'))).toBe(false);
  });
  it('retries 5xx and transport errors', () => {
    expect(isRetryable(new Error('HTTP 502: bad gateway'))).toBe(true);
    expect(isRetryable(new Error('fetch failed'))).toBe(true);
  });
});
