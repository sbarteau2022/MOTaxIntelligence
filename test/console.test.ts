// Tests for the statute query console (src/console.ts) and the routes that
// serve it. The console is a single embedded HTML string, so the things worth
// pinning are: the routes actually return it, the template literal did not
// silently swallow part of the page as interpolation, and the page keeps the
// two guarantees the whole product rests on — verbatim statute text and no
// service key in the browser.

import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { CONSOLE_HTML } from '../src/console';
import type { Env } from '../src/types';

// The console routes return before touching any binding, so an empty env is
// sufficient — and proves the page renders even when D1/Vectorize are down.
const EMPTY_ENV = {} as Env;

async function get(path: string): Promise<Response> {
  return worker.fetch(new Request('https://mo-tax.example.com' + path), EMPTY_ENV);
}

describe('console routes', () => {
  it('serves the console at / as HTML', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('Statute query console');
  });

  it('serves the same page at /console', async () => {
    const [root, explicit] = await Promise.all([get('/'), get('/console')]);
    expect(await root.text()).toBe(await explicit.text());
  });

  it('renders without touching D1, Vectorize, or AI — an empty env still returns the page', async () => {
    // EMPTY_ENV has no bindings at all; reaching for one would throw and the
    // catch-all in fetch() would turn this into a 500.
    expect((await get('/')).status).toBe(200);
  });

  it('still 404s unknown paths', async () => {
    expect((await get('/not-a-route')).status).toBe(404);
  });

  it('does not answer POST on the console routes', async () => {
    const res = await worker.fetch(new Request('https://mo-tax.example.com/console', { method: 'POST' }), EMPTY_ENV);
    expect(res.status).toBe(404);
  });
});

describe('console page integrity', () => {
  it('is a complete HTML document — the template literal did not truncate it', () => {
    expect(CONSOLE_HTML.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(CONSOLE_HTML.trimEnd().endsWith('</html>')).toBe(true);
    expect(CONSOLE_HTML).toContain('</script>');
  });

  it('contains no unescaped ${ — that would have been eaten as interpolation', () => {
    // A literal "${" surviving into the output means the source had it escaped;
    // an UNescaped one would never reach the string at all, so the real check is
    // that the page still has the markers that follow every risky region.
    expect(CONSOLE_HTML).not.toContain('${');
    expect(CONSOLE_HTML).toContain('function run()');
    expect(CONSOLE_HTML).toContain('renderBody');
  });

  it('posts to /query with the documented request shape', () => {
    expect(CONSOLE_HTML).toContain("fetch(API + '/query'");
    expect(CONSOLE_HTML).toContain('q: q, entity: entity, top_k:');
  });

  it('offers exactly the entity filter values /query accepts', () => {
    for (const v of ['any', 'llc_single', 'llc_multi', 's_corp', 'general']) {
      expect(CONSOLE_HTML).toContain("v: '" + v + "'");
    }
  });

  it('renders statute bodies as text nodes, never innerHTML — verbatim text cannot be reinterpreted as markup', () => {
    expect(CONSOLE_HTML).toContain('document.createTextNode');
    expect(CONSOLE_HTML).not.toContain('innerHTML');
  });

  it('never asks for or sends the service key — no admin surface in the browser', () => {
    expect(CONSOLE_HTML).not.toContain('TAX_SERVICE_KEY');
    expect(CONSOLE_HTML).not.toContain('/admin/');
    expect(CONSOLE_HTML).not.toMatch(/authorization/i);
  });

  it('surfaces the provenance fields a citation needs', () => {
    expect(CONSOLE_HTML).toContain('source_url');
    expect(CONSOLE_HTML).toContain('retrieved_at');
    expect(CONSOLE_HTML).toContain('checksum');
    expect(CONSOLE_HTML).toContain('matched_spans');
  });

  it('is same-origin by default so no CORS header is required', () => {
    // API resolves to '' (relative) unless explicitly overridden — an absolute
    // default would break against a Worker that sets no CORS headers.
    expect(CONSOLE_HTML).toContain("return '';");
    expect(CONSOLE_HTML).toContain("get('api')");
  });
});
