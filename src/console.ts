// ============================================================
// QUERY CONSOLE — the operator-facing UI for /query.
//
// Served BY the Worker (GET / and GET /console) rather than shipped as a
// separate static site, for one concrete reason: no route in this Worker
// sets CORS headers, so a console served from any other origin would have
// its POST /query blocked by the browser. Same-origin means the console
// works the moment the Worker is deployed, with zero configuration and no
// CORS surface opened up just to serve a UI.
//
// Design system is the Atlas Command Center skin (Titanium + Gold, Barlow /
// Barlow Condensed) shared with RAPIDAi's ui/ and this repo's marketing
// page, so the console reads as part of the same product family.
//
// Deliberately absent: anything touching /admin/*. Those are gated by
// TAX_SERVICE_KEY, and a full-scope key has no business being typed into a
// browser tab. Health (unauthenticated) is the only status surface here.
//
// The page's own JavaScript uses string concatenation, never template
// literals — this whole file is one TS template literal, and a stray
// backtick or dollar-brace inside it would silently become interpolation.
// ============================================================

export const CONSOLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MOTaxIntelligence — Statute Query Console</title>
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@300;400;500;600;700&family=Barlow+Condensed:wght@400;500;600;700&display=swap">
<style>
:root {
  --bg: #f2f2f3; --bg-alt: #eceef2;
  --paper: color-mix(in srgb, #fff 80%, transparent);
  --paper-solid: color-mix(in srgb, #fff 92%, transparent);
  --ink: #1d1f20; --ink-soft: #40454a;
  --ink-dim: rgba(29,31,32,0.62); --ink-faint: rgba(29,31,32,0.40);
  --line: #ced3da; --line-hi: #a7aeb8;
  --gold: #b3902f; --gold-soft: #c9a83f; --gold-deep: #8a6f22;
  --gold-glow: rgba(179,144,47,0.16);
  --signal: #3f8f5f; --warn: #a8791f; --red: #b3453a;
  --shadow-lg: 0 30px 60px -28px rgba(20,26,38,0.35);
  --shadow-sm: 0 2px 6px -2px rgba(20,26,38,0.14);
  --sidebar: 268px;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: var(--bg); color: var(--ink);
  font-family: 'Barlow', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-weight: 350; line-height: 1.6; -webkit-font-smoothing: antialiased;
  display: flex; min-height: 100vh;
}
body::before {
  content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background-image:
    radial-gradient(700px circle at 16% 10%, var(--gold-glow), transparent 60%),
    radial-gradient(900px circle at 86% 26%, rgba(167,174,184,0.16), transparent 65%);
}
h1,h2,h3,h4 { font-family: 'Barlow Condensed', serif; font-weight: 500; line-height: 1.1; letter-spacing: -0.015em; }
a { color: var(--gold-deep); text-decoration: none; }
a:hover { text-decoration: underline; }
.mono { font-family: 'Barlow', monospace; }

/* ---------- sidebar ---------- */
aside {
  width: var(--sidebar); position: fixed; top: 0; left: 0; bottom: 0; overflow-y: auto;
  background: color-mix(in srgb, var(--bg) 70%, transparent);
  border-right: 1px solid var(--line);
  -webkit-backdrop-filter: blur(20px) saturate(140%); backdrop-filter: blur(20px) saturate(140%);
  display: flex; flex-direction: column;
}
.side-brand { padding: 20px 22px 18px; border-bottom: 1px solid var(--line); }
.brand { display: inline-flex; align-items: center; gap: 10px; }
.brand svg { width: 26px; height: 26px; }
.brand-text { font-family: 'Barlow Condensed', serif; font-weight: 600; font-size: 1.1rem; color: var(--ink); }
.brand-text .co { color: var(--gold); font-weight: 450; }
.brand-sub {
  font-family: 'Barlow', monospace; font-size: 0.56rem; letter-spacing: 0.2em;
  text-transform: uppercase; color: var(--ink-faint); margin-top: 6px;
}
.side-sec { padding: 18px 22px; border-bottom: 1px solid var(--line); }
.side-sec:last-of-type { border-bottom: none; }
.side-label {
  font-family: 'Barlow', monospace; font-size: 0.58rem; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--ink-faint); margin-bottom: 12px;
}
.ent-opt {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px; margin: 0 -10px;
  border-radius: 8px; cursor: pointer; font-size: 0.86rem; color: var(--ink-dim);
  border-left: 2px solid transparent; transition: all 0.15s;
}
.ent-opt:hover { color: var(--ink); background: rgba(255,255,255,0.5); }
.ent-opt.on { color: var(--gold-deep); background: linear-gradient(180deg, var(--gold-glow), rgba(179,144,47,0.06)); border-left-color: var(--gold); }
.ent-opt input { accent-color: var(--gold); cursor: pointer; }
.ent-opt .form { display: block; font-family: 'Barlow', monospace; font-size: 0.6rem; color: var(--ink-faint); letter-spacing: 0.08em; }
.samples { display: flex; flex-direction: column; gap: 8px; }
.sample {
  text-align: left; font-family: inherit; font-size: 0.8rem; line-height: 1.45; color: var(--ink-dim);
  background: var(--paper); border: 1px solid var(--line); border-radius: 10px;
  padding: 9px 12px; cursor: pointer; transition: all 0.15s;
}
.sample:hover { border-color: var(--gold-soft); color: var(--ink); }
.side-foot { margin-top: auto; padding: 18px 22px; border-top: 1px solid var(--line); }
.health-row { display: flex; justify-content: space-between; align-items: baseline; font-size: 0.78rem; color: var(--ink-dim); padding: 3px 0; }
.health-row .v { font-family: 'Barlow', monospace; color: var(--ink); font-size: 0.78rem; }
.side-note { font-size: 0.68rem; color: var(--ink-faint); line-height: 1.5; margin-top: 12px; }

/* ---------- main ---------- */
main { margin-left: var(--sidebar); flex: 1; display: flex; flex-direction: column; min-width: 0; }
header.bar {
  height: 62px; padding: 0 30px; display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 10;
  background: color-mix(in srgb, var(--bg) 78%, transparent);
  -webkit-backdrop-filter: blur(20px) saturate(140%); backdrop-filter: blur(20px) saturate(140%);
}
.bar-left { display: flex; align-items: center; gap: 14px; min-width: 0; }
.bar-title { font-size: 1.05rem; font-family: 'Barlow Condensed', serif; font-weight: 600; }
/* The sidebar carries the wordmark on desktop; this one only appears once
   the sidebar drops below the fold on narrow screens. */
.bar-brand { display: none; }
.pill {
  display: inline-flex; align-items: center; gap: 7px; padding: 5px 13px; border-radius: 100px;
  font-family: 'Barlow', monospace; font-size: 0.6rem; letter-spacing: 0.12em; text-transform: uppercase;
  border: 1px solid var(--line-hi); color: var(--ink-dim);
}
.pill .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--signal); }
.pill.gold { border-color: var(--gold-soft); color: var(--gold-deep); background: var(--gold-glow); }
.pill.gold .dot { background: var(--gold); }
.content { padding: 26px 30px 60px; flex: 1; }

/* ---------- query panel ---------- */
.qpanel {
  background: var(--paper); border: 1px solid var(--line); border-radius: 16px; padding: 20px;
  box-shadow: var(--shadow-sm); -webkit-backdrop-filter: blur(14px) saturate(150%); backdrop-filter: blur(14px) saturate(150%);
  margin-bottom: 24px;
}
.qrow { display: flex; gap: 12px; align-items: stretch; }
#q {
  flex: 1; min-width: 0; resize: none; font-family: inherit; font-size: 0.98rem; color: var(--ink);
  background: var(--paper-solid); border: 1px solid var(--line); border-radius: 12px;
  padding: 13px 16px; outline: none; line-height: 1.5; transition: border-color 0.15s;
}
#q:focus { border-color: var(--gold); }
#q::placeholder { color: var(--ink-faint); }
.qside { display: flex; flex-direction: column; gap: 10px; width: 150px; flex-shrink: 0; }
select {
  font-family: 'Barlow', monospace; font-size: 0.68rem; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--ink-dim); background: var(--paper-solid); border: 1px solid var(--line);
  border-radius: 100px; padding: 9px 14px; cursor: pointer; outline: none;
}
select:focus { border-color: var(--gold); }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 9px;
  font-family: 'Barlow', monospace; font-size: 0.72rem; letter-spacing: 0.12em; text-transform: uppercase;
  font-weight: 500; padding: 12px 22px; border-radius: 100px; cursor: pointer; border: 1px solid transparent;
  transition: all 0.2s; white-space: nowrap;
}
.btn-gold { background: var(--gold); color: #fff; box-shadow: 0 10px 30px -12px var(--gold-glow); }
.btn-gold:hover:not(:disabled) { background: var(--gold-soft); transform: translateY(-1px); }
.btn:disabled { opacity: 0.45; cursor: default; }
.btn-mini {
  font-family: 'Barlow', monospace; font-size: 0.58rem; letter-spacing: 0.12em; text-transform: uppercase;
  padding: 6px 13px; border-radius: 100px; border: 1px solid var(--line-hi);
  color: var(--ink-dim); background: transparent; cursor: pointer; transition: all 0.15s;
}
.btn-mini:hover { border-color: var(--gold); color: var(--gold-deep); }
.qhint {
  margin-top: 12px; font-family: 'Barlow', monospace; font-size: 0.6rem; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--ink-faint); display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
}
.qhint .sep { opacity: 0.4; }

/* ---------- results ---------- */
.res-meta {
  display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 10px;
  margin-bottom: 14px; font-family: 'Barlow', monospace; font-size: 0.62rem;
  letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-faint);
}
.res {
  background: var(--paper); border: 1px solid var(--line); border-radius: 16px; padding: 22px;
  box-shadow: var(--shadow-sm); margin-bottom: 16px;
  -webkit-backdrop-filter: blur(14px) saturate(150%); backdrop-filter: blur(14px) saturate(150%);
}
.res-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; }
.res-cite { font-family: 'Barlow Condensed', serif; font-weight: 600; font-size: 1.3rem; color: var(--ink); }
.res-catch { font-size: 0.9rem; color: var(--ink-dim); margin-top: 2px; }
.res-score { text-align: right; flex-shrink: 0; }
.res-score .v { font-family: 'Barlow Condensed', serif; font-weight: 600; font-size: 1.5rem; color: var(--gold); display: block; line-height: 1; }
.res-score .k { font-family: 'Barlow', monospace; font-size: 0.54rem; letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-faint); }
.chips { display: flex; flex-wrap: wrap; gap: 7px; margin: 14px 0; }
.chip {
  font-family: 'Barlow', monospace; font-size: 0.58rem; letter-spacing: 0.1em; text-transform: uppercase;
  padding: 4px 11px; border-radius: 100px; border: 1px solid var(--line); color: var(--ink-dim); background: var(--bg);
}
.chip.gold { border-color: var(--gold-soft); color: var(--gold-deep); background: var(--gold-glow); }
.res-body {
  white-space: pre-wrap; word-wrap: break-word; font-size: 0.92rem; line-height: 1.72; color: var(--ink-soft);
  background: var(--paper-solid); border: 1px solid var(--line); border-left: 2px solid var(--gold);
  border-radius: 10px; padding: 16px 18px; max-height: 420px; overflow-y: auto;
}
.res-body mark { background: var(--gold-glow); color: var(--ink); border-radius: 3px; padding: 1px 0; box-shadow: 0 0 0 2px var(--gold-glow); }
.res-foot {
  margin-top: 14px; padding-top: 13px; border-top: 1px dashed var(--line);
  display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap;
}
.res-prov { font-family: 'Barlow', monospace; font-size: 0.6rem; color: var(--ink-faint); line-height: 1.7; }
.res-prov .lbl { color: var(--gold-deep); }
.res-acts { display: flex; gap: 8px; flex-shrink: 0; }
.spanline {
  font-family: 'Barlow', monospace; font-size: 0.58rem; letter-spacing: 0.08em;
  color: var(--ink-faint); margin-top: 9px;
}

/* ---------- states ---------- */
.state { text-align: center; padding: 70px 24px; }
.state h3 { font-size: 1.5rem; margin-bottom: 10px; color: var(--ink); }
.state p { color: var(--ink-dim); font-size: 0.92rem; max-width: 480px; margin: 0 auto; line-height: 1.6; }
.state.err h3 { color: var(--red); }
.skel { background: var(--paper); border: 1px solid var(--line); border-radius: 16px; padding: 22px; margin-bottom: 16px; }
.skel-line { height: 11px; border-radius: 6px; background: linear-gradient(90deg, var(--bg-alt), var(--line), var(--bg-alt)); background-size: 200% 100%; animation: sh 1.3s infinite; margin-bottom: 10px; }
@keyframes sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.hidden { display: none !important; }

@media (prefers-reduced-motion: reduce) { .skel-line { animation: none; } }
@media (max-width: 900px) {
  /* Query first: on a phone the search box is the primary action, so the
     filter/sample/corpus rail moves below it rather than pushing it off
     the first screen. Entity defaults to "any", so filtering stays a
     deliberate scroll rather than a prerequisite. */
  body { flex-direction: column; }
  main { margin-left: 0; order: 1; }
  aside {
    position: static; width: auto; order: 2;
    border-right: none; border-top: 1px solid var(--line);
  }
  .side-brand { display: none; }
  .bar-brand { display: inline-flex; }
  .bar-title { display: none; }
  .qrow { flex-direction: column; }
  .qside { width: auto; flex-direction: row; }
  .qside .btn { flex: 1; }
  .content { padding: 20px 18px 40px; }
  header.bar { padding: 0 18px; }
}
</style>
</head>
<body>

<aside>
  <div class="side-brand">
    <span class="brand">
      <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle cx="16" cy="16" r="10.5" stroke="#b3902f" stroke-width="1.6"/>
        <path d="M11 10.5c3-1.6 7-1.6 10 0M11 21.5c3 1.6 7 1.6 10 0" stroke="#b3902f" stroke-width="1.3" stroke-linecap="round"/>
        <path d="M12 15h8M12 17h8" stroke="#b3902f" stroke-width="1.1" opacity="0.7"/>
        <circle cx="16" cy="16" r="1.4" fill="#b3902f"/>
      </svg>
      <span class="brand-text">MOTax<span class="co">Intelligence</span></span>
    </span>
    <div class="brand-sub">Statute query console</div>
  </div>

  <div class="side-sec">
    <div class="side-label">Entity filter</div>
    <div id="entList"></div>
  </div>

  <div class="side-sec">
    <div class="side-label">Try a question</div>
    <div class="samples" id="samples"></div>
  </div>

  <div class="side-foot">
    <div class="side-label">Corpus</div>
    <div class="health-row"><span>Sections</span><span class="v" id="hParents">—</span></div>
    <div class="health-row"><span>Windows</span><span class="v" id="hChildren">—</span></div>
    <div class="health-row"><span>Model</span><span class="v" id="hModel">—</span></div>
    <p class="side-note">Admin endpoints are service-key gated and deliberately absent from this console — a full-scope key does not belong in a browser.</p>
  </div>
</aside>

<main>
  <header class="bar">
    <div class="bar-left">
      <span class="brand bar-brand">
        <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="16" cy="16" r="10.5" stroke="#b3902f" stroke-width="1.6"/>
          <path d="M11 10.5c3-1.6 7-1.6 10 0M11 21.5c3 1.6 7 1.6 10 0" stroke="#b3902f" stroke-width="1.3" stroke-linecap="round"/>
          <path d="M12 15h8M12 17h8" stroke="#b3902f" stroke-width="1.1" opacity="0.7"/>
          <circle cx="16" cy="16" r="1.4" fill="#b3902f"/>
        </svg>
        <span class="brand-text">MOTax<span class="co">Intelligence</span></span>
      </span>
      <div class="bar-title">Statute query console</div>
    </div>
    <span class="pill gold"><span class="dot"></span> Verbatim · zero drift</span>
  </header>

  <div class="content">
    <div class="qpanel">
      <div class="qrow">
        <textarea id="q" rows="2" placeholder="Ask a Missouri tax question — e.g. can an S corp elect the pass-through entity tax?"></textarea>
        <div class="qside">
          <select id="topk" aria-label="Results to return">
            <option value="3">Top 3</option>
            <option value="5" selected>Top 5</option>
            <option value="10">Top 10</option>
          </select>
          <button class="btn btn-gold" id="run">Query</button>
        </div>
      </div>
      <div class="qhint">
        <span>Returns whole sections, verbatim</span><span class="sep">·</span>
        <span>Highlights = matched windows</span><span class="sep">·</span>
        <span>Every hit carries source + checksum</span>
      </div>
    </div>

    <div id="resMeta" class="res-meta hidden"></div>
    <div id="out"></div>

    <div class="state" id="idle">
      <h3>Ask the statute, not a summary of it</h3>
      <p>Every answer resolves to a whole section of Missouri law, returned exactly as published — with the source URL, retrieval date, and checksum needed to verify it against the original.</p>
    </div>
  </div>
</main>

<script>
(function () {
  'use strict';

  // Same-origin by default (this console is served BY the Worker, so /query
  // is a relative call and no CORS header is needed). ?api= overrides it for
  // local file:// use against a wrangler dev server.
  var API = (function () {
    var override = new URLSearchParams(location.search).get('api');
    if (override) return override.replace(/\\/+$/, '');
    if (location.protocol === 'file:') return 'http://127.0.0.1:8787';
    return '';
  })();

  var ENTITIES = [
    { v: 'any', label: 'Any entity', form: 'all sections' },
    { v: 'llc_single', label: 'Single-member LLC', form: 'MO-1040' },
    { v: 'llc_multi', label: 'Multi-member LLC', form: 'MO-1065' },
    { v: 's_corp', label: 'S corporation', form: 'MO-1120S' },
    { v: 'general', label: 'General', form: 'cross-class' }
  ];

  var SAMPLES = [
    'Can an S corp elect the pass-through entity tax?',
    'How is a single-member LLC treated for Missouri income tax?',
    'What are the filing requirements for a partnership return?',
    'How is Missouri taxable income computed for a resident?'
  ];

  var entity = 'any';
  var busy = false;

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt !== null && txt !== undefined) n.textContent = txt;
    return n;
  }

  // ---- sidebar: entity filter ----
  (function buildEntities() {
    var host = $('entList');
    ENTITIES.forEach(function (e) {
      var lab = el('label', 'ent-opt' + (e.v === entity ? ' on' : ''));
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'entity';
      radio.value = e.v;
      radio.checked = e.v === entity;
      radio.addEventListener('change', function () {
        entity = e.v;
        Array.prototype.forEach.call(host.querySelectorAll('.ent-opt'), function (n) { n.classList.remove('on'); });
        lab.classList.add('on');
      });
      var text = el('span');
      text.appendChild(document.createTextNode(e.label));
      text.appendChild(el('span', 'form', e.form));
      lab.appendChild(radio);
      lab.appendChild(text);
      host.appendChild(lab);
    });
  })();

  // ---- sidebar: sample questions ----
  (function buildSamples() {
    var host = $('samples');
    SAMPLES.forEach(function (s) {
      var b = el('button', 'sample', s);
      b.type = 'button';
      b.addEventListener('click', function () { $('q').value = s; run(); });
      host.appendChild(b);
    });
  })();

  // ---- health strip ----
  (function health() {
    fetch(API + '/health')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        if (d.parents !== null && d.parents !== undefined) $('hParents').textContent = String(d.parents);
        if (d.children !== null && d.children !== undefined) $('hChildren').textContent = String(d.children);
        if (d.model) $('hModel').textContent = String(d.model).split('/').pop();
      })
      .catch(function () { /* health is informational only — never blocks querying */ });
  })();

  // ---- matched-span rendering ----
  // Spans come back as real, invariant-checked offsets into the body. They are
  // rendered by slicing the body itself and appending TEXT nodes, so the
  // displayed statute is byte-for-byte what the API returned — highlighting
  // can never alter, reorder, or inject into the verbatim text.
  function mergeSpans(spans, len) {
    var clean = (spans || [])
      .map(function (s) {
        return {
          start: Math.max(0, Math.min(len, Number(s.start_char) || 0)),
          end: Math.max(0, Math.min(len, Number(s.end_char) || 0))
        };
      })
      .filter(function (s) { return s.end > s.start; })
      .sort(function (a, b) { return a.start - b.start; });

    var out = [];
    clean.forEach(function (s) {
      var last = out[out.length - 1];
      if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
      else out.push({ start: s.start, end: s.end });
    });
    return out;
  }

  function renderBody(host, body, spans) {
    host.textContent = '';
    var merged = mergeSpans(spans, body.length);
    var cursor = 0;
    merged.forEach(function (s) {
      if (s.start > cursor) host.appendChild(document.createTextNode(body.slice(cursor, s.start)));
      var mk = el('mark', null, body.slice(s.start, s.end));
      host.appendChild(mk);
      cursor = s.end;
    });
    if (cursor < body.length) host.appendChild(document.createTextNode(body.slice(cursor)));
    return merged.length;
  }

  // ---- result card ----
  function card(r) {
    var c = el('article', 'res');

    var head = el('div', 'res-head');
    var left = el('div');
    left.appendChild(el('div', 'res-cite', r.citation || ('Ch. ' + (r.chapter || '?') + ' \\u00a7 ' + (r.section || '?'))));
    if (r.catchline) left.appendChild(el('div', 'res-catch', r.catchline));
    head.appendChild(left);

    var sc = el('div', 'res-score');
    sc.appendChild(el('span', 'v', typeof r.score === 'number' ? r.score.toFixed(3) : '—'));
    sc.appendChild(el('span', 'k', 'match'));
    head.appendChild(sc);
    c.appendChild(head);

    var chips = el('div', 'chips');
    (r.entity_tags || []).forEach(function (t) { chips.appendChild(el('span', 'chip gold', t)); });
    if (r.chapter) chips.appendChild(el('span', 'chip', 'Ch. ' + r.chapter));
    if (r.statute_year) chips.appendChild(el('span', 'chip', r.statute_year));
    if (r.effective_date) chips.appendChild(el('span', 'chip', 'eff. ' + r.effective_date));
    if (r.authority) chips.appendChild(el('span', 'chip', r.authority));
    c.appendChild(chips);

    var bodyText = typeof r.body === 'string' ? r.body : '';
    var bodyHost = el('div', 'res-body');
    var nSpans = renderBody(bodyHost, bodyText, r.matched_spans);
    c.appendChild(bodyHost);

    c.appendChild(el(
      'div',
      'spanline',
      nSpans === 0
        ? 'Whole section returned · no span offsets on this hit'
        : nSpans + (nSpans === 1 ? ' matched window' : ' matched windows') + ' highlighted inside the full section'
    ));

    var foot = el('div', 'res-foot');
    var prov = el('div', 'res-prov');
    if (r.source_url) {
      var srcLine = el('div');
      srcLine.appendChild(el('span', 'lbl', 'source '));
      var a = el('a', null, r.source_url);
      a.href = r.source_url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      srcLine.appendChild(a);
      prov.appendChild(srcLine);
    }
    var stamp = el('div');
    stamp.appendChild(el('span', 'lbl', 'retrieved '));
    stamp.appendChild(document.createTextNode(r.retrieved_at || 'unknown'));
    if (r.checksum) {
      stamp.appendChild(el('span', 'lbl', '  \\u00b7  checksum '));
      stamp.appendChild(document.createTextNode(String(r.checksum).slice(0, 16)));
    }
    prov.appendChild(stamp);
    foot.appendChild(prov);

    var acts = el('div', 'res-acts');
    acts.appendChild(copyBtn('Copy citation', function () {
      return (r.citation || '') + (r.source_url ? ' — ' + r.source_url : '');
    }));
    acts.appendChild(copyBtn('Copy section', function () { return bodyText; }));
    foot.appendChild(acts);

    c.appendChild(foot);
    return c;
  }

  function copyBtn(label, getText) {
    var b = el('button', 'btn-mini', label);
    b.type = 'button';
    b.addEventListener('click', function () {
      var text = getText();
      var done = function () {
        b.textContent = 'Copied';
        setTimeout(function () { b.textContent = label; }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { b.textContent = 'Copy failed'; });
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { b.textContent = 'Copy failed'; }
        document.body.removeChild(ta);
      }
    });
    return b;
  }

  // ---- states ----
  function showState(kind, title, msg) {
    $('idle').classList.add('hidden');
    $('resMeta').classList.add('hidden');
    var out = $('out');
    out.textContent = '';
    var s = el('div', 'state' + (kind === 'err' ? ' err' : ''));
    s.appendChild(el('h3', null, title));
    s.appendChild(el('p', null, msg));
    out.appendChild(s);
  }

  function showSkeleton() {
    $('idle').classList.add('hidden');
    $('resMeta').classList.add('hidden');
    var out = $('out');
    out.textContent = '';
    for (var i = 0; i < 2; i++) {
      var sk = el('div', 'skel');
      [40, 90, 75, 85].forEach(function (w) {
        var line = el('div', 'skel-line');
        line.style.width = w + '%';
        sk.appendChild(line);
      });
      out.appendChild(sk);
    }
  }

  // ---- query ----
  function run() {
    if (busy) return;
    var q = $('q').value.trim();
    if (!q) { $('q').focus(); return; }

    busy = true;
    $('run').disabled = true;
    $('run').textContent = 'Querying';
    showSkeleton();

    fetch(API + '/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: q, entity: entity, top_k: parseInt($('topk').value, 10) })
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      })
      .then(function (r) {
        if (!r.ok) {
          showState('err', 'Query failed (' + r.status + ')', (r.data && r.data.error) || 'The Worker rejected the request.');
          return;
        }
        var results = (r.data && r.data.results) || [];
        if (!results.length) {
          showState(
            'empty',
            'No section scored against that query',
            'Nothing in the corpus matched — under this entity filter. That is not a statement that Missouri law is silent on the question; try a broader entity filter or different wording.'
          );
          return;
        }

        var meta = $('resMeta');
        meta.textContent = '';
        meta.appendChild(el('span', null, results.length + (results.length === 1 ? ' section' : ' sections') + ' · entity: ' + (r.data.entity || entity)));
        meta.appendChild(el('span', null, 'verbatim · resolved by parent id'));
        meta.classList.remove('hidden');

        var out = $('out');
        out.textContent = '';
        results.forEach(function (item) { out.appendChild(card(item)); });
        $('idle').classList.add('hidden');
      })
      .catch(function (e) {
        showState('err', 'Could not reach the API', String((e && e.message) || e) + ' — if this console is open as a local file, append ?api=http://127.0.0.1:8787 to the URL.');
      })
      .then(function () {
        busy = false;
        $('run').disabled = false;
        $('run').textContent = 'Query';
      });
  }

  $('run').addEventListener('click', run);
  $('q').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
  });
})();
</script>
</body>
</html>`;
