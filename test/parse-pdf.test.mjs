import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parsePdfSection, normalizePdfText } from '../pipeline/lib/parse.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
// A real, valid PDF (bundled as pdf-parse's own test fixture) — proves the
// extraction code path against real PDF bytes, not a hand-rolled stub. Text
// content is a public academic paper, used here only as fixture content.
const SAMPLE_PDF = readFileSync(path.join(ROOT, 'test', 'fixtures', 'sample.pdf'));

describe('normalizePdfText', () => {
  it('collapses mid-paragraph line wraps to spaces', () => {
    expect(normalizePdfText('Hello\nWorld')).toBe('Hello World');
  });
  it('preserves a blank-line paragraph break', () => {
    expect(normalizePdfText('First paragraph.\n\nSecond paragraph.')).toBe('First paragraph.\n\nSecond paragraph.');
  });
  it('collapses 3+ newlines to exactly one paragraph break', () => {
    expect(normalizePdfText('A\n\n\n\nB')).toBe('A\n\nB');
  });
  it('trims trailing whitespace before a wrap', () => {
    expect(normalizePdfText('Hello   \nWorld')).toBe('Hello World');
  });
  it('drops empty paragraphs produced by irregular spacing', () => {
    expect(normalizePdfText('A\n\n \n\nB')).toBe('A\n\nB');
  });
});

describe('parsePdfSection', () => {
  it('extracts and normalizes text from a real PDF', async () => {
    const result = await parsePdfSection(SAMPLE_PDF, { minBodyChars: 40 });
    expect(result).not.toBeNull();
    // The raw extraction fragments the title across lines; normalization
    // should flow it back into one readable line.
    expect(result.body).toContain('Trace-based Just-in-Time Type Specialization for Dynamic Languages');
    expect(result.catchline).toContain('Trace-based');
  });

  it('returns null on unparseable bytes rather than throwing', async () => {
    const result = await parsePdfSection(Buffer.from('not a pdf'), { minBodyChars: 40 });
    expect(result).toBeNull();
  });

  it('returns null when extracted text is shorter than minBodyChars', async () => {
    const result = await parsePdfSection(SAMPLE_PDF, { minBodyChars: 10_000_000 });
    expect(result).toBeNull();
  });
});
