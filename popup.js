/**
 * Popup — settings + start/stop.
 *
 * The popup is an extension page, so it may fetch the Kokoro server directly
 * (host permission applies) — but it delegates to the service worker anyway,
 * so there is exactly one place that knows the server contract.
 */

const $ = (id) => document.getElementById(id);

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
  theme: 'auto',
};

let settings = { ...DEFAULTS };

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || { ok: false, error: 'no response' });
    });
  });
}

function save() {
  return new Promise((resolve) => {
    chrome.storage.sync.set(settings, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function load() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULTS, (got) => {
      if (chrome.runtime.lastError) return resolve({ ...DEFAULTS });
      resolve({ ...DEFAULTS, ...(got || {}) });
    });
  });
}

// ------------------------------------------------------------- voice list

/** Kokoro voice names encode language and gender: af_heart = American female. */
function prettyVoice(id) {
  const LANG = {
    a: 'US', b: 'UK', j: 'Japanese', z: 'Chinese',
    e: 'Spanish', f: 'French', h: 'Hindi', i: 'Italian', p: 'Portuguese',
  };
  const parts = String(id).split('_');
  const code = parts[0] || '';
  const lang = LANG[code[0]] || code[0].toUpperCase();
  const gender = code[1] === 'f' ? '♀' : code[1] === 'm' ? '♂' : '';
  const name = parts.slice(1).join(' ') || code;
  return `${name} — ${lang} ${gender}`.trim();
}

async function loadVoices() {
  const sel = $('voice');
  sel.innerHTML = '';

  // Show the currently-saved voice immediately, then replace with the real list.
  const opt = document.createElement('option');
  opt.value = settings.voice;
  opt.textContent = prettyVoice(settings.voice);
  sel.appendChild(opt);

  const res = await send({ type: 'ra-check-server' });
  if (!res.ok) return false;

  const voices = res.voices || [];
  if (voices.length) {
    sel.innerHTML = '';
    for (const v of voices) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = prettyVoice(v);
      if (v === settings.voice) o.selected = true;
      sel.appendChild(o);
    }
    if (!voices.includes(settings.voice)) {
      settings.voice = voices[0];
      sel.value = voices[0];
      await save();
    }
  }
  return true;
}

function setServer(status, text) {
  const dot = $('serverDot');
  const msg = $('serverMsg');
  dot.className = 'dot dot-' + status;
  msg.className = 'server-msg ' + (status === 'ok' ? 'ok' : status === 'bad' ? 'bad' : '');
  msg.textContent = text;
}

// ----------------------------------------------------------------- wiring

async function init() {
  settings = await load();

  $('voice').value = settings.voice;
  $('speed').value = settings.speed;
  $('speedVal').textContent = Number(settings.speed).toFixed(2) + '×';
  $('volume').value = settings.volume;
  $('volumeVal').textContent = Math.round(settings.volume * 100) + '%';
  $('autoScroll').checked = !!settings.autoScroll;
  $('skipNav').checked = !!settings.skipNav;
  $('theme').value = settings.theme || 'auto';

  const ok = await loadVoices();
  if (ok) {
    setServer('ok', 'Kokoro server connected.');
  } else {
    setServer(
      'bad',
      'Kokoro server not reachable. Start it with run-server.sh, then reopen this popup.'
    );
    $('help').classList.remove('hidden');
  }
}

$('voice').addEventListener('change', async (e) => {
  settings.voice = e.target.value;
  await save();
  await send({ type: 'ra-settings-changed' });
});

$('speed').addEventListener('input', (e) => {
  settings.speed = Number(e.target.value);
  $('speedVal').textContent = settings.speed.toFixed(2) + '×';
});
$('speed').addEventListener('change', async () => {
  await save();
  await send({ type: 'ra-settings-changed' });
});

$('volume').addEventListener('input', (e) => {
  settings.volume = Number(e.target.value);
  $('volumeVal').textContent = Math.round(settings.volume * 100) + '%';
  send({ type: 'ra-volume', volume: settings.volume });
});
$('volume').addEventListener('change', save);

$('autoScroll').addEventListener('change', async (e) => {
  settings.autoScroll = e.target.checked;
  await save();
  await send({ type: 'ra-settings-changed' });
});

$('skipNav').addEventListener('change', async (e) => {
  settings.skipNav = e.target.checked;
  await save();
  await send({ type: 'ra-settings-changed' });
});

$('theme').addEventListener('change', async (e) => {
  settings.theme = e.target.value;
  await save();
  await send({ type: 'ra-settings-changed' });
});

$('startBtn').addEventListener('click', async () => {
  $('startBtn').disabled = true;
  $('startBtn').textContent = 'Starting…';

  const res = await send({ type: 'ra-from-popup', command: { type: 'ra-start' } });

  if (!res.ok) {
    setServer('bad', res.error || 'Could not start reading.');
    $('help').classList.remove('hidden');
    $('startBtn').disabled = false;
    $('startBtn').textContent = 'Read this page';
    return;
  }

  // Close so the user sees the page and the on-page toolbar.
  window.close();
});

$('stopBtn').addEventListener('click', async () => {
  await send({ type: 'ra-from-popup', command: { type: 'ra-stop' } });
  setServer('ok', 'Stopped.');
  window.close();
});

$('rescanBtn').addEventListener('click', async () => {
  const btn = $('rescanBtn');
  btn.disabled = true;
  btn.textContent = '⟳ Scanning…';

  // Unlike start/stop this deliberately does NOT close the popup, so the
  // sentence count stays visible while the user decides what to do next.
  const res = await send({ type: 'ra-from-popup', command: { type: 'ra-rescan' } });

  btn.disabled = false;
  btn.textContent = '⟳ Rescan for text';

  if (!res.ok) {
    setServer('bad', res.error || 'Could not scan this page.');
    $('help').classList.remove('hidden');
    return;
  }
  if (!res.count) {
    setServer('bad', 'No readable text found on this page.');
    return;
  }
  const delta = typeof res.delta === 'number' ? res.delta : 0;
  const sign = delta > 0 ? '+' : '';
  setServer('ok', `Found ${res.count} sentences (${sign}${delta}).`);
});

$('testBtn').addEventListener('click', async () => {
  const btn = $('testBtn');
  btn.disabled = true;
  btn.textContent = 'Speaking…';
  const res = await send({ type: 'ra-test-voice', voice: settings.voice });
  btn.disabled = false;
  btn.textContent = 'Test voice';
  if (!res.ok) setServer('bad', res.error || 'Test failed.');
  else setServer('ok', 'Playing a sample of ' + prettyVoice(settings.voice) + '.');
});

$('helpBtn').addEventListener('click', () => {
  $('help').classList.toggle('hidden');
});

$('copyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('cmd').textContent);
    $('copyBtn').textContent = 'Copied!';
    setTimeout(() => ($('copyBtn').textContent = 'Copy command'), 1400);
  } catch (e) {
    /* ignore */
  }
});

init();
