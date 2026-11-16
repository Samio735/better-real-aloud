/**
 * Offscreen document — owns audio playback for the extension.
 *
 * The play queue is a stream of WAV blobs fetched by the service worker.
 * Playback is sequential: play chunk n, report when it finishes, receive n+1.
 * That gives the content script a precise "sentence n is now being spoken"
 * signal, which is what drives the highlight.
 *
 * Why not just feed raw samples to Web Audio? Because <audio> already handles
 * decoding, buffering and device routing, and we only need gain for volume.
 */

let audio = null;
let audioCtx = null;
let gainNode = null;
const blobUrls = new Set();
let currentUrl = null;

function ensureAudio() {
  if (!audio) {
    audio = new Audio();
    audio.preload = 'auto';
    // Keep playback inside this document's element; nothing is attached to
    // the page, so page CSS cannot affect it.
    audio.crossOrigin = 'anonymous';

    audio.addEventListener('ended', () => {
      notify({ type: 'ra-playback-ended' });
    });

    audio.addEventListener('error', () => {
      const err = audio.error;
      notify({
        type: 'ra-playback-error',
        error: err ? `media error ${err.code}` : 'unknown media error',
      });
    });
  }
  return audio;
}

function ensureGain() {
  // Only used to apply volume; playback itself goes through <audio> so it
  // works even when the AudioContext is suspended for autoplay reasons.
  if (audioCtx) return gainNode;
  try {
    audioCtx = new AudioContext();
    gainNode = audioCtx.createGain();
    const src = audioCtx.createMediaElementSource(ensureAudio());
    src.connect(gainNode);
    gainNode.connect(audioCtx.destination);
  } catch (e) {
    // If this fails we simply fall back to audio.volume.
    audioCtx = null;
    gainNode = null;
  }
  return gainNode;
}

function notify(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  } catch (e) {
    /* ignore */
  }
}

function revoke(url) {
  if (url && blobUrls.has(url)) {
    URL.revokeObjectURL(url);
    blobUrls.delete(url);
  }
}

/** Play one chunk of WAV data. Resolves immediately; completion is an event. */
async function playChunk({ dataUrl, volume, playbackRate }) {
  const el = ensureAudio();

  // Convert base64 data URL -> Blob -> object URL. Blobs keep memory low
  // compared to holding large base64 strings around.
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  blobUrls.add(url);

  const previous = currentUrl;
  currentUrl = url;

  el.src = url;
  el.playbackRate = clamp(playbackRate, 0.5, 4);
  el.volume = clamp(volume, 0, 1);
  el.currentTime = 0;

  try {
    await el.play();
  } catch (e) {
    revoke(url);
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }

  // Safe to release the previous chunk once the new one is playing.
  revoke(previous);
  return { ok: true };
}

function clamp(v, lo, hi) {
  v = Number(v);
  if (!isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function pausePlayback() {
  if (audio && !audio.paused) {
    audio.pause();
    return { ok: true };
  }
  return { ok: true };
}

function resumePlayback() {
  if (audio && audio.paused && audio.src) {
    audio.play().catch(() => {});
    return { ok: true };
  }
  return { ok: false, error: 'nothing to resume' };
}

function stopPlayback() {
  if (audio) {
    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch (e) {
      /* ignore */
    }
  }
  if (currentUrl) {
    revoke(currentUrl);
    currentUrl = null;
  }
  for (const u of Array.from(blobUrls)) revoke(u);
  return { ok: true };
}

function setVolume(v) {
  const val = clamp(v, 0, 1);
  if (audio) audio.volume = val;
  if (gainNode) gainNode.gain.value = val;
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.target || msg.target !== 'offscreen') {
      return; // not ours
    }
    try {
      switch (msg.type) {
        case 'ra-offscreen-play':
          sendResponse(await playChunk(msg));
          return;
        case 'ra-offscreen-pause':
          sendResponse(pausePlayback());
          return;
        case 'ra-offscreen-resume':
          sendResponse(resumePlayback());
          return;
        case 'ra-offscreen-stop':
          sendResponse(stopPlayback());
          return;
        case 'ra-offscreen-volume':
          sendResponse(setVolume(msg.volume));
          return;
        default:
          sendResponse({ ok: false, error: 'unknown offscreen message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true;
});

// Announce readiness so the worker knows it can queue work.
notify({ type: 'ra-offscreen-ready' });
