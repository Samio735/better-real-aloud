/**
 * Read Aloud — content script (Kokoro edition).
 *
 * This script does NOT synthesise anything. It:
 *   - extracts sentences and remembers a DOM Range for each,
 *   - asks the background worker to speak sentence n,
 *   - highlights sentence n and scrolls it into view,
 *   - advances when the worker reports the audio finished.
 *
 * Networking deliberately lives in the worker: a content script shares the
 * page's origin, so a fetch to 127.0.0.1 from here would be subject to the
 * page's CORS and Local Network Access rules. Host permissions do not lift
 * that in a content script.
 *
 * Highlighting uses the CSS Custom Highlight API rather than wrapping spans,
 * because wrapping mutates the page's own DOM inside whatever framework owns
 * it and the next re-render erases it.
 */

(() => {
  'use strict';

  if (window.__readAloudLoaded) return;
  window.__readAloudLoaded = true;

  const MSG = { TOGGLE: 'ra-toggle', STOP: 'ra-stop', PING: 'ra-ping' };

  const DEFAULTS = {
    serverUrl: 'http://127.0.0.1:8000',
    model: 'mlx-community/Kokoro-82M-bf16',
    voice: 'af_heart',
    speed: 1.0,
    volume: 1.0,
    autoScroll: true,
    scrollMode: 'center',
    dimVisited: true,
    skipNav: true,
    prefetch: true,
  };

  const MAX_CHUNK = 220;

  const state = {
    sentences: [],
    index: 0,
    playing: false,
    paused: false,
    settings: { ...DEFAULTS },
    runId: 0,
    hoverIndex: -1,
  };

  // ------------------------------------------------------------- utilities

  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false, error: 'no response' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });
  }

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(DEFAULTS, (got) => {
          if (chrome.runtime.lastError) return resolve({ ...DEFAULTS });
          resolve({ ...DEFAULTS, ...(got || {}) });
        });
      } catch (e) {
        resolve({ ...DEFAULTS });
      }
    });
  }

  // --------------------------------------------------------- extraction

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'KBD', 'SAMP', 'SVG', 'CANVAS', 'IFRAME', 'VIDEO', 'AUDIO',
    'BUTTON', 'LABEL', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE',
  ]);

  const CHROME_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE']);

  // Tags that make up one "section" for skip purposes. Walking up to the
  // nearest of these turns a flat sentence list back into paragraphs, which is
  // what a reader means by "skip this section" — stepping one sentence at a
  // time is not the same thing.
  const BLOCK_TAGS = new Set([
    'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'FIGCAPTION', 'TD', 'TH', 'DT', 'DD', 'PRE', 'ARTICLE',
    'SECTION', 'DIV', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'NAV',
  ]);

  // WeakMap so re-extraction does not leak; ids are assigned in document order
  // during extraction, which makes them ordered and comparable with < / >.
  const blockIds = new WeakMap();
  let nextBlockId = 0;

  /** Nearest block-level ancestor, as a stable ordered id for the sentence. */
  function blockOf(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      if (BLOCK_TAGS.has(node.tagName)) {
        if (!blockIds.has(node)) blockIds.set(node, nextBlockId++);
        return blockIds.get(node);
      }
      node = node.parentElement;
    }
    return -1;
  }

  function isHidden(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hasAttribute && el.hasAttribute('hidden')) return true;
    const cs = getComputedStyle(el);
    return (
      cs.display === 'none' ||
      cs.visibility === 'hidden' ||
      parseFloat(cs.opacity || '1') === 0
    );
  }

  function inSkipped(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      if (SKIP_TAGS.has(node.tagName)) return true;
      if (state.settings.skipNav && CHROME_TAGS.has(node.tagName)) return true;
      if (node.classList && node.classList.contains('ra-ignore')) return true;
      if (isHidden(node)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function extractSentences() {
    // Reset block numbering per extraction so ids reflect this pass only.
    nextBlockId = 0;
    const root = document.body || document.documentElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (inSkipped(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const collected = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = norm(node.nodeValue);
      if (text) collected.push({ node, text });
    }

    const sentences = [];
    for (const { node, text } of collected) {
      const raw = node.nodeValue;
      const segments = splitSentences(text);
      let searchFrom = 0;

      for (const seg of segments) {
        const at = findSegmentOffset(raw, seg, searchFrom);
        if (at < 0) continue;
        searchFrom = at + seg.length;

        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, Math.min(at + seg.length, raw.length));
        // Record which block (paragraph, list item, heading, …) this sentence
        // belongs to, so "skip section" can jump whole blocks instead of
        // stepping one sentence at a time. Consecutive sentences sharing a
        // block id are in the same paragraph.
        sentences.push({ text: seg, range, top: 0, block: blockOf(node.parentElement) });
      }
    }

    for (const s of sentences) {
      try {
        const rect = s.range.getBoundingClientRect();
        s.top = rect.top + window.scrollY;
      } catch (e) {
        s.top = 0;
      }
    }

    return sentences;
  }

  /** Map a normalised sentence back to a raw-text offset (whitespace tolerant). */
  function findSegmentOffset(raw, segment, from) {
    if (!segment) return -1;

    const direct = raw.toLowerCase().indexOf(segment.toLowerCase(), from);
    if (direct >= 0) return direct;

    const target = segment.replace(/\s+/g, ' ').trim();
    if (!target) return -1;

    let ti = 0;
    let ri = from;
    let startRaw = -1;

    while (ri < raw.length && ti < target.length) {
      const rc = raw[ri];
      const tc = target[ti];

      if (/\s/.test(rc)) {
        if (/\s/.test(tc)) {
          while (ri < raw.length && /\s/.test(raw[ri])) {
            if (startRaw === -1) startRaw = ri;
            ri++;
          }
          while (ti < target.length && /\s/.test(target[ti])) ti++;
          continue;
        }
        ri++;
        continue;
      }

      if (rc.toLowerCase() === tc.toLowerCase()) {
        if (startRaw === -1) startRaw = ri;
        ri++;
        ti++;
        continue;
      }

      if (startRaw === -1) ri++;
      else {
        ri = startRaw + 1;
        ti = 0;
        startRaw = -1;
      }
    }

    if (ti >= target.length && startRaw !== -1) return startRaw;
    return -1;
  }

  function splitSentences(text) {
    if (!text) return [];

    const ABBREV = [
      'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g',
      'i.e', 'fig', 'no', 'vol', 'inc', 'ltd', 'co', 'corp', 'dept', 'est',
      'approx', 'apt', 'mt', 'ft',
    ];

    const out = [];
    let buf = '';
    let i = 0;

    while (i < text.length) {
      const ch = text[i];
      buf += ch;

      const isTerm =
        ch === '.' || ch === '!' || ch === '?' || ch === '。' || ch === '！' || ch === '？';

      if (isTerm) {
        let j = i + 1;
        while (j < text.length) {
          const c = text[j];
          if ('.!?"\')]”’'.includes(c)) {
            buf += c;
            j++;
          } else break;
        }
        i = j;

        // Abbreviation / initial / decimal checks must run BEFORE the
        // "no space follows" guard. That guard exists to keep things like
        // "3.14" and "example.com" intact, but it also has to not override the
        // initial check: in "By A. Researcher" a space does follow, so testing
        // the guard first let the initial slip through and split the byline.
        if (ch === '.') {
          const tail = buf.toLowerCase().replace(/["')\]]+$/, '');
          const lastWord = tail.split(/[\s(]/).pop() || '';
          const isAbbrev = ABBREV.includes(lastWord.replace(/\.$/, ''));

          // A single letter before the dot is an initial ("By A. Researcher",
          // "J. R. R. Tolkien"). The dot is still the last character of the
          // buffer here, so the letter sits SECOND-to-last — anchoring the
          // pattern at the end tested the dot instead and never matched.
          const isInitial = /(^|[\s(])[\p{Ll}]\.$/u.test(tail);

          const isDecimal = /\d\.$/.test(tail) && /^\s*\d/.test(text.slice(i));
          if (isAbbrev || isInitial || isDecimal) continue;
        }

        // Only a real sentence terminator reaches here. If no whitespace
        // follows, it is a mid-token dot (a URL, a version number) — keep going.
        if (i < text.length && !/\s/.test(text[i])) continue;

        const seg = buf.trim();
        if (seg) out.push(seg);
        buf = '';
        while (i < text.length && /\s/.test(text[i])) i++;
        continue;
      }

      i++;
    }

    const tail = buf.trim();
    if (tail) out.push(tail);

    const final = [];
    for (const s of out) {
      if (s.length <= MAX_CHUNK) {
        final.push(s);
        continue;
      }
      let rest = s;
      while (rest.length > MAX_CHUNK) {
        let cut = -1;
        for (const sep of ['; ', ' — ', ', ', ' ']) {
          const at = rest.lastIndexOf(sep, MAX_CHUNK);
          if (at > MAX_CHUNK * 0.4) {
            cut = at + sep.length;
            break;
          }
        }
        if (cut <= 0) cut = MAX_CHUNK;
        final.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut);
      }
      if (rest.trim()) final.push(rest.trim());
    }

    return final.filter((s) => /[\p{L}\p{N}]/u.test(s));
  }

  // ------------------------------------------------------------ overlay

  let toolbar = null;
  let statusEl = null;
  let progressEl = null;
  let playBtn = null;
  let toastEl = null;

  /**
   * Apply the theme to an overlay element.
   *
   * The value is written as a `data-ra-theme` attribute and the CSS holds both
   * palettes, so switching is instant and needs no style recalculation in JS.
   * 'auto' is left in place for the stylesheet's prefers-color-scheme rule to
   * resolve, which also means an OS change is picked up while the page is open.
   */
  function applyTheme(el) {
    if (!el) return;
    const t = state.settings.theme || 'auto';
    el.setAttribute('data-ra-theme', t === 'light' || t === 'dark' ? t : 'auto');
  }

  function buildToolbar() {
    // Guard against duplicates. The toolbar is appended to documentElement (not
    // body), so a plain `document.body.contains(toolbar)` check is the wrong
    // test and let a second toolbar be built whenever toolbar was null but an
    // element still existed in the DOM. Query the DOM as the source of truth.
    const existing = document.getElementById('ra-toolbar');
    if (existing) {
      toolbar = existing;
      return;
    }
    if (toolbar && toolbar.isConnected) return;

    toolbar = document.createElement('div');
    toolbar.id = 'ra-toolbar';
    toolbar.className = 'ra-ignore';
    toolbar.setAttribute('role', 'toolbar');
    applyTheme(toolbar);

    const mkBtn = (label, title, cls) => {
      const b = document.createElement('button');
      b.className = 'ra-btn' + (cls ? ' ' + cls : '');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      return b;
    };

    playBtn = mkBtn('▶', 'Play / Pause (Alt+Shift+R)', 'ra-primary');
    const backBtn = mkBtn('⏮', 'Previous sentence');
    const fwdBtn = mkBtn('⏭', 'Next sentence');
    const prevSecBtn = mkBtn('⇡', 'Previous section (Alt+↑)');
    const nextSecBtn = mkBtn('⇣', 'Next section (Alt+↓)');
    const restartBtn = mkBtn('↺', 'Restart from the top');
    const rescanBtn = mkBtn('⟳', 'Rescan page for text (Alt+Shift+S)');
    const stopBtn = mkBtn('■', 'Stop (Alt+Shift+X)');

    const sep = document.createElement('span');
    sep.className = 'ra-sep';

    statusEl = document.createElement('span');
    statusEl.className = 'ra-status';
    statusEl.textContent = 'Ready';

    progressEl = document.createElement('div');
    progressEl.className = 'ra-progress';
    progressEl.style.width = '0%';

    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });
    backBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      jumpTo(state.index - 1);
    });
    fwdBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      jumpTo(state.index + 1);
    });
    prevSecBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      skipSection(-1);
    });
    nextSecBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      skipSection(1);
    });
    restartBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      restart();
    });
    rescanBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = e.currentTarget;
      // Brief disabled state doubles as feedback: a rescan of a long page is
      // not instant, and without this the button looks like it did nothing.
      b.disabled = true;
      rescan().finally(() => {
        b.disabled = false;
      });
    });
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      stopAll();
    });

    toolbar.append(
      playBtn, backBtn, fwdBtn, prevSecBtn, nextSecBtn, restartBtn, rescanBtn,
      sep, statusEl, stopBtn, progressEl
    );
    toolbar.addEventListener('click', (e) => e.stopPropagation());
    toolbar.addEventListener('mousedown', (e) => e.stopPropagation());

    document.documentElement.appendChild(toolbar);
    makeDraggable(toolbar);
  }

  function makeDraggable(el) {
    let dragging = false;
    let sx = 0, sy = 0, ox = 0, oy = 0;

    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ra-btn')) return;
      dragging = true;
      const r = el.getBoundingClientRect();
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.transform = 'none';
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = Math.max(4, ox + e.clientX - sx) + 'px';
      el.style.top = Math.max(4, oy + e.clientY - sy) + 'px';
    }, true);

    window.addEventListener('mouseup', () => { dragging = false; }, true);
  }

  function setStatus(t) { if (statusEl) statusEl.textContent = t; }

  function setProgress(i, total) {
    if (progressEl) progressEl.style.width = (total ? Math.round(((i + 1) / total) * 100) : 0) + '%';
  }

  function updatePlayButton() {
    if (!playBtn) return;
    if (state.playing && !state.paused) {
      playBtn.textContent = '❚❚';
      playBtn.title = 'Pause (Alt+Shift+R)';
    } else {
      playBtn.textContent = '▶';
      playBtn.title = state.paused ? 'Resume (Alt+Shift+R)' : 'Play (Alt+Shift+R)';
    }
  }

  function toast(text, ms = 2600) {
    if (toastEl) toastEl.remove();
    toastEl = document.createElement('div');
    toastEl.id = 'ra-toast';
    toastEl.className = 'ra-ignore';
    toastEl.textContent = text;
    applyTheme(toastEl);
    document.documentElement.appendChild(toastEl);
    setTimeout(() => {
      if (toastEl) { toastEl.remove(); toastEl = null; }
    }, ms);
  }

  // -------------------------------------------------------- highlighting

  function supportsHighlightAPI() {
    return typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
  }

  function rangeIsValid(s) {
    try {
      const r = s.range;
      if (!r || !r.startContainer || !r.startContainer.isConnected) return false;
      const now = norm(r.toString());
      return now.length > 0 && now === s.text;
    } catch (e) {
      return false;
    }
  }

  function renderHighlight() {
    if (!supportsHighlightAPI()) return;
    const current = state.sentences[state.index];

    if (!current) {
      CSS.highlights.delete('ra-current');
      CSS.highlights.delete('ra-visited');
      return;
    }
    if (!rangeIsValid(current)) return; // stale after re-render: skip rather than mis-highlight

    CSS.highlights.set('ra-current', new Highlight(current.range));

    if (state.settings.dimVisited) {
      const visited = [];
      const from = Math.max(0, state.index - 400);
      for (let i = from; i < state.index; i++) {
        const s = state.sentences[i];
        if (s && rangeIsValid(s)) visited.push(s.range);
      }
      if (visited.length) CSS.highlights.set('ra-visited', new Highlight(...visited));
      else CSS.highlights.delete('ra-visited');
    } else {
      CSS.highlights.delete('ra-visited');
    }
  }

  function clearHighlights() {
    if (supportsHighlightAPI()) {
      CSS.highlights.delete('ra-current');
      CSS.highlights.delete('ra-visited');
      CSS.highlights.delete('ra-hover');
    }
  }

  // --------------------------------------------------------- auto-scroll

  let scrollRaf = null;

  function scrollToCurrent(force) {
    if (!state.settings.autoScroll && !force) return;
    const s = state.sentences[state.index];
    if (!s || !s.range) return;
    if (scrollRaf) cancelAnimationFrame(scrollRaf);

    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      let rect;
      try {
        rect = s.range.getBoundingClientRect();
      } catch (e) {
        return;
      }
      if (!rect || rect.height === 0) return;

      const vh = window.innerHeight;
      const margin = Math.min(160, vh * 0.22);
      const above = rect.top < margin;
      const below = rect.bottom > vh - margin;
      if (!above && !below) return;

      let targetY;
      if (state.settings.scrollMode === 'center') {
        targetY = rect.top + window.scrollY - vh / 2 + rect.height / 2;
      } else {
        targetY = above
          ? rect.top + window.scrollY - margin
          : rect.bottom + window.scrollY - vh + margin;
      }

      const maxY = Math.max(
        0,
        (document.documentElement.scrollHeight || document.body.scrollHeight) - vh
      );
      window.scrollTo({ top: Math.max(0, Math.min(targetY, maxY)), behavior: 'smooth' });

      // Many article layouts scroll inside an overflow container instead.
      const scroller = findScrollContainer(s.range.startContainer);
      if (scroller) {
        try {
          const sRect = scroller.getBoundingClientRect();
          const delta = rect.top - sRect.top - scroller.clientHeight / 2 + rect.height / 2;
          if (Math.abs(delta) > scroller.clientHeight * 0.18) {
            scroller.scrollBy({ top: delta, behavior: 'smooth' });
          }
        } catch (e) {
          /* ignore */
        }
      }
    });
  }

  function findScrollContainer(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const cs = getComputedStyle(el);
      const oy = cs.overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 20) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ------------------------------------------------------------- playback

  /**
   * Completion latch, keyed by sentence index.
   *
   * Why keyed rather than a single slot: synthesis (~600 ms) can be slower than
   * playback of a very short sentence, so `ra-chunk-ended` may arrive before
   * step() is waiting for it. An unkeyed latch then either loses the signal or
   * records it against a stale index, and reading stalls forever after the
   * first short sentence. Storing completions per index makes the handoff order
   * independent: whoever finishes first, the other side finds it.
   */
  const finished = new Set(); // sentence indices whose audio has completed
  let pendingResolve = null;
  let pendingIndex = -1;

  function waitForChunk(index) {
    if (finished.has(index)) {
      finished.delete(index);
      return Promise.resolve();
    }
    pendingIndex = index;
    return new Promise((resolve) => {
      pendingResolve = resolve;
    });
  }

  /** Called when the worker reports the audio for `index` finished. */
  function signalChunkDone(index) {
    // If someone is waiting for exactly this index, release them.
    if (pendingResolve && pendingIndex === index) {
      const r = pendingResolve;
      pendingResolve = null;
      pendingIndex = -1;
      r();
      return;
    }
    // Otherwise remember it for the waiter that has not arrived yet.
    finished.add(index);
    if (finished.size > 8) {
      const oldest = finished.values().next().value;
      finished.delete(oldest);
    }
  }

  function resetChunkSignal() {
    finished.clear();
    if (pendingResolve) {
      const r = pendingResolve;
      pendingResolve = null;
      pendingIndex = -1;
      r(); // unblock the loop so it can notice the runId change and exit
    }
  }

  async function askTts(index) {
    const s = state.sentences[index];
    if (!s) return { ok: false, error: 'no sentence' };
    return await send({
      type: 'ra-tts',
      index,
      text: s.text,
      settings: {
        voice: state.settings.voice,
        speed: state.settings.speed,
        volume: state.settings.volume,
        model: state.settings.model,
        serverUrl: state.settings.serverUrl,
      },
    });
  }

  function playFrom(index) {
    if (!state.sentences.length) {
      toast('No readable text found on this page.');
      return;
    }
    index = Math.max(0, Math.min(index, state.sentences.length - 1));

    killPlayback();
    const myRun = ++state.runId;

    state.index = index;
    state.playing = true;
    state.paused = false;
    updatePlayButton();
    markCurrent(index);

    step(myRun, index);
  }

  async function step(myRun, index) {
    if (myRun !== state.runId) return;
    if (index >= state.sentences.length) {
      finish();
      return;
    }

    state.index = index;
    markCurrent(index);

    const res = await askTts(index);
    if (myRun !== state.runId) return; // superseded while synthesising

    if (!res.ok) {
      // Surface the failure clearly; continuing is pointless if the server is
      // unreachable or rejected the request.
      toast(res.error || 'Kokoro failed to speak this sentence.', 4200);
      if (res.offline || /not reachable|Cannot reach/i.test(res.error || '')) {
        setStatus('Kokoro offline');
      }
      finish();
      return;
    }

    // Wait for this chunk's audio to finish. The latch ensures a completion
    // that arrived during synthesis is not lost.
    await waitForChunk(index);
    if (myRun !== state.runId) return;

    step(myRun, index + 1);
  }

  function onChunkEnded(index) {
    signalChunkDone(index);
  }

  function killPlayback() {
    state.runId++;
    resetChunkSignal();
    send({ type: 'ra-stop-audio' });
  }

  function markCurrent(i) {
    state.index = i;
    renderHighlight();
    scrollToCurrent();
    setProgress(i, state.sentences.length);
    const s = state.sentences[i];
    if (s) {
      const preview = s.text.length > 50 ? s.text.slice(0, 50) + '…' : s.text;
      setStatus(`${i + 1}/${state.sentences.length} · ${preview}`);
    }
  }

  function finish() {
    state.playing = false;
    state.paused = false;
    updatePlayButton();
    setStatus('Finished');
  }

  // ------------------------------------------------------------- controls

  function toggle() {
    if (state.playing && !state.paused) pause();
    else if (state.paused) resume();
    else playFrom(state.index);
  }

  function pause() {
    if (!state.playing || state.paused) return;
    state.paused = true;
    send({ type: 'ra-pause-audio' });
    updatePlayButton();
    setStatus('Paused');
  }

  function resume() {
    if (!state.paused) return;
    state.paused = false;
    send({ type: 'ra-resume-audio' });
    updatePlayButton();
    setStatus('Reading…');
    renderHighlight();
  }

  function jumpTo(index) {
    if (!state.sentences.length) return;
    index = Math.max(0, Math.min(index, state.sentences.length - 1));
    if (state.playing || state.paused) {
      playFrom(index);
    } else {
      state.index = index;
      markCurrent(index);
      scrollToCurrent(true);
    }
  }

  /**
   * Skip to the start of the next/previous section (paragraph, list item,
   * heading). `dir` is +1 or -1.
   *
   * Works mid-playback: jumpTo() routes through playFrom(), which bumps runId
   * and cancels the in-flight chunk, so the reader never has to pause first.
   * Landing on the first sentence of the target block is deliberate — skipping
   * into the middle of a paragraph is rarely what someone pressing "next
   * section" wants.
   */
  function skipSection(dir) {
    const list = state.sentences;
    if (!list.length) return;

    const cur = Math.max(0, Math.min(state.index, list.length - 1));
    const curBlock = list[cur].block;

    // Find the first sentence belonging to a different block, walking in the
    // requested direction.
    let target = -1;
    for (let i = cur + dir; i >= 0 && i < list.length; i += dir) {
      if (list[i].block !== curBlock) {
        target = i;
        break;
      }
    }

    if (target < 0) {
      // No further section: clamp to the end (or start) rather than doing
      // nothing, so the key press still gives visible feedback.
      const edge = dir > 0 ? list.length - 1 : 0;
      if (edge === cur) {
        toast(dir > 0 ? 'Already at the last section.' : 'Already at the first section.');
        return;
      }
      jumpTo(edge);
    } else if (dir < 0) {
      // Walking backwards lands mid-block; rewind to that block's first
      // sentence so the whole section is read from its beginning.
      let first = target;
      const b = list[target].block;
      while (first > 0 && list[first - 1].block === b) first--;
      jumpTo(first);
    } else {
      jumpTo(target);
    }

    const s = list[state.index];
    if (s) {
      const preview = s.text.length > 38 ? s.text.slice(0, 38) + '…' : s.text;
      toast(`Section ${dir > 0 ? 'forward' : 'back'} — ${preview}`, 1800);
    }
  }

  function restart() {
    playFrom(0);
    toast('Restarting from the top');
  }

  function stopAll() {
    killPlayback();
    state.playing = false;
    state.paused = false;
    updatePlayButton();
    clearHighlights();
    setProgress(0, state.sentences.length);
    // Remove by id, not just via the cached reference: if state ever drifted
    // from the DOM a stale toolbar would be left on the page with no way to
    // dismiss it.
    document.querySelectorAll('#ra-toolbar').forEach((el) => el.remove());
    toolbar = null;
    removeHint();
    toast('Stopped');
  }

  // ------------------------------------------------------ click-to-start

  let hintIndex = -1;
  let readModeArmed = false;

  function removeHint() {
    hintIndex = -1;
    if (supportsHighlightAPI()) CSS.highlights.delete('ra-hover');
  }

  function sentenceAtPoint(x, y) {
    if (!state.sentences.length) return -1;

    let node = null;
    let offset = 0;
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) {
        node = r.startContainer;
        offset = r.startOffset;
      }
    }

    if (node && node.nodeType === 3) {
      for (let i = 0; i < state.sentences.length; i++) {
        const r = state.sentences[i].range;
        try {
          if (r.startContainer === node && r.endContainer === node) {
            if (offset >= r.startOffset && offset <= r.endOffset) return i;
          } else if (r.startContainer === node && offset <= r.startOffset) {
            return i;
          } else if (r.endContainer === node && offset <= r.endOffset) {
            return i;
          }
        } catch (e) {
          /* ignore */
        }
      }
    }

    return sentenceByRect(x, y);
  }

  function sentenceByRect(x, y) {
    const px = x + window.scrollX;
    const py = y + window.scrollY;
    for (let i = 0; i < state.sentences.length; i++) {
      let r;
      try {
        r = state.sentences[i].range.getBoundingClientRect();
      } catch (e) {
        continue;
      }
      if (!r || r.height === 0) continue;
      if (
        px >= r.left + window.scrollX &&
        px <= r.right + window.scrollX &&
        py >= r.top + window.scrollY &&
        py <= r.bottom + window.scrollY
      ) {
        return i;
      }
    }
    return -1;
  }

  const onMouseMove = (e) => {
    if (e.target && e.target.closest && e.target.closest('#ra-toolbar')) {
      removeHint();
      return;
    }

    const idx = sentenceAtPoint(e.clientX, e.clientY);
    if (idx < 0) {
      removeHint();
      return;
    }

    if (idx !== hintIndex) {
      hintIndex = idx;
      const s = state.sentences[idx];
      if (supportsHighlightAPI() && rangeIsValid(s)) {
        CSS.highlights.set('ra-hover', new Highlight(s.range));
      }
    }
  };

  const onClick = (e) => {
    if (e.target && e.target.closest && e.target.closest('#ra-toolbar')) return;
    if (!state.sentences.length) return;

    const idx = sentenceAtPoint(e.clientX, e.clientY);
    if (idx < 0) return;

    if (readModeArmed) {
      e.preventDefault();
      e.stopPropagation();
      disarmReadMode();
      playFrom(idx);
      toast(`Reading from sentence ${idx + 1}`);
      return;
    }
    if (e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      playFrom(idx);
    }
  };

  function armReadMode() {
    buildToolbar();
    readModeArmed = true;
    toast('Click any sentence to start reading from there', 4200);
    setStatus('Click a sentence…');
  }

  function disarmReadMode() {
    readModeArmed = false;
    removeHint();
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape' && readModeArmed) {
      disarmReadMode();
      setStatus(state.playing ? 'Reading…' : 'Ready');
      return;
    }
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;

    if (e.altKey && e.shiftKey && (e.key === 'R' || e.key === 'r' || e.code === 'KeyR')) {
      e.preventDefault();
      toggle();
    }

    if (e.altKey && e.shiftKey && (e.key === 'S' || e.key === 's' || e.code === 'KeyS')) {
      e.preventDefault();
      // Build the toolbar first so the rescan has somewhere to report into,
      // otherwise the toast and status line have no elements to write to.
      buildToolbar();
      rescan();
    }

    // Stop. Handled in-page rather than as a manifest command: Chrome caps
    // "commands" at 4 entries with a suggested_key, and play/pause, both
    // section skips and rescan already claim those slots.
    if (e.altKey && e.shiftKey && (e.key === 'X' || e.key === 'x' || e.code === 'KeyX')) {
      e.preventDefault();
      stopAll();
    }

    // Section skipping: Alt + Arrow jumps a whole paragraph/block. Works while
    // audio is playing — jumpTo() cancels the in-flight chunk, so there is no
    // need to pause first. Shift is accepted too so the mapped manifest
    // commands (alt+shift+Down/Up) behave identically.
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      const step =
        e.key === 'ArrowDown' || e.key === 'ArrowRight'
          ? 1
          : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
            ? -1
            : 0;
      if (step !== 0) {
        e.preventDefault();
        skipSection(step);
        return;
      }
    }
  };

  // ----------------------------------------------------------- bootstrap

  async function ensureSentences(force) {
    if (state.sentences.length && !force) return state.sentences;
    state.sentences = extractSentences();
    return state.sentences;
  }

  /**
   * Re-scan the page for readable text.
   *
   * This is the manual counterpart to the automatic index that `start()` does.
   * It exists because pages mutate after load — infinite-scroll feeds, SPAs that
   * swap their main content, "show more" buttons, lazy-loaded articles. On those
   * the sentence list captured at first read goes stale, and sentences the user
   * can plainly see on screen are simply not in it.
   *
   * Behaviour worth knowing:
   *  - Playback position is remapped by *text*, not by index. A rescan that
   *    inserts a paragraph above the cursor shifts every index by one, so
   *    holding the raw number would silently jump the reader somewhere else.
   *  - If the current sentence no longer exists we keep the index (clamped)
   *    rather than resetting to 0, which would be a jarring restart.
   *  - Playback is paused across the rescan and resumed afterwards if it was
   *    running. Letting a chunk finish mid-rescan was a bug: step() is awaiting
   *    `waitForChunk(oldIndex)` and the remap changes what that index means, so
   *    the awaited event never matches and reading stalls silently.
   *
   * Returns a small summary so callers can report what happened.
   */
  async function rescan() {
    const before = state.sentences.length;
    const prev = state.index >= 0 ? state.sentences[state.index] : null;
    const prevText = prev && prev.text ? prev.text.trim() : '';

    const wasPlaying = state.playing && !state.paused;

    // Bump the run id so any in-flight step() loop exits at its next check, and
    // release a waiter that would otherwise hang on the old index.
    killPlayback();
    state.playing = false;
    state.paused = false;

    await ensureSentences(true);

    if (!state.sentences.length) {
      state.index = -1;
      setStatus('No text found');
      setProgress(0, 0);
      updatePlayButton();
      toast('Rescan found no readable text on this page.');
      return { ok: true, before, after: 0, matched: false, delta: -before };
    }

    // Re-anchor by text so an insertion above the cursor does not move it.
    let matched = false;
    if (prevText) {
      let idx = state.sentences.findIndex((s) => s.text && s.text.trim() === prevText);
      if (idx < 0) {
        // Fall back to a prefix probe: markup-only changes (a link added inside
        // the sentence, re-rendered entities) alter the tail but not the head.
        const probe = prevText.slice(0, 40);
        if (probe) idx = state.sentences.findIndex((s) => s.text && s.text.trim().startsWith(probe));
      }
      if (idx >= 0) {
        state.index = idx;
        matched = true;
      }
    }

    const after = state.sentences.length;
    const delta = after - before;
    const sign = delta > 0 ? '+' : '';

    if (!matched) {
      // Nothing to anchor to: clamp instead of restarting, so a rescan never
      // punts the reader back to the top of the page.
      state.index = Math.min(Math.max(state.index, 0), after - 1);
    }

    markCurrent(state.index);
    setProgress(state.index, after);
    updatePlayButton();

    // Report "no change" honestly rather than "+0", which reads like a failure.
    const change = delta === 0 ? 'no change' : `${sign}${delta}`;
    const summary = matched
      ? `Re-scanned — ${after} sentences (${change}).`
      : `Re-scanned — ${after} sentences (${change}), cursor kept at ${state.index + 1}.`;
    setStatus(`${after} sentences`);
    toast(summary, 3000);

    // Resume only if audio was genuinely running before the rescan. A paused
    // reader stays paused, so rescanning can't startle you into sudden speech.
    if (wasPlaying) playFrom(state.index);

    // `index` is part of the contract: callers (and the worker) need to know
    // where the cursor landed, and the rescan may have moved it.
    return { ok: true, before, after, matched, delta, index: state.index, resumed: wasPlaying };
  }

  async function start() {
    state.settings = await loadSettings();
    await ensureSentences(true);

    if (!state.sentences.length) {
      toast('No readable text found on this page.');
      return { ok: false, error: 'no-text' };
    }

    buildToolbar();
    updatePlayButton();
    state.index = 0;
    markCurrent(0);
    armReadMode();
    return { ok: true, count: state.sentences.length };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg && msg.type) {
          case MSG.PING:
            sendResponse({ ok: true });
            return;

          case 'ra-start':
            sendResponse(await start());
            return;

          case MSG.TOGGLE:
            if (!toolbar) sendResponse(await start());
            else {
              toggle();
              sendResponse({ ok: true });
            }
            return;

          case MSG.STOP:
            stopAll();
            sendResponse({ ok: true });
            return;

          case 'ra-chunk-ended':
            onChunkEnded(msg.index);
            sendResponse({ ok: true });
            return;

          case 'ra-chunk-error':
            toast('Audio error: ' + (msg.error || 'unknown'), 3600);
            finish();
            sendResponse({ ok: true });
            return;

          case 'ra-get-sentence':
            sendResponse({
              ok: true,
              text: state.sentences[msg.index] ? state.sentences[msg.index].text : '',
            });
            return;

          case 'ra-settings':
            state.settings = { ...state.settings, ...(msg.settings || {}) };
            // Re-theme any overlay already on screen so the change is visible
            // immediately, without needing a restart.
            applyTheme(toolbar);
            applyTheme(toastEl);
            renderHighlight();
            sendResponse({ ok: true });
            return;

          case 'ra-next':
            await ensureSentences();
            jumpTo(state.index + 1);
            sendResponse({ ok: true });
            return;

          case 'ra-skip-section':
            await ensureSentences();
            skipSection(msg.dir === -1 ? -1 : 1);
            sendResponse({ ok: true, index: state.index });
            return;

          case 'ra-prev':
            await ensureSentences();
            jumpTo(state.index - 1);
            sendResponse({ ok: true });
            return;

          case 'ra-restart':
            await ensureSentences();
            restart();
            sendResponse({ ok: true });
            return;

          case 'ra-get-state':
            sendResponse({
              ok: true,
              playing: state.playing,
              paused: state.paused,
              index: state.index,
              total: state.sentences.length,
            });
            return;

          case 'ra-reindex':
            await ensureSentences(true);
            sendResponse({ ok: true, count: state.sentences.length });
            return;

          case 'ra-rescan': {
            const r = await rescan();
            // rescan() already stopped audio; this also clears whatever the
            // worker had prefetched, since those indices are now stale.
            send({ type: 'ra-stop-audio' });
            sendResponse({ ...r, count: state.sentences.length });
            return;
          }

          default:
            sendResponse({ ok: false, error: 'unknown' });
        }
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  });

  window.addEventListener('pagehide', () => {
    send({ type: 'ra-stop-audio' });
  }, { capture: true });

  document.addEventListener('mousemove', onMouseMove, { passive: true });
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);

  window.__readAloud = {
    state,
    start,
    stopAll,
    playFrom,
    rescan,
    skipSection,
    extractSentences,
    _internals: { splitSentences, findSegmentOffset },
  };
})();
