# Better Real Aloud

A Chrome extension that reads web pages aloud using a **local Kokoro TTS model** —
highlighting each sentence as it is spoken, auto-scrolling to keep it in view, and
letting you start, pause, skip and resume wherever you like.

Everything runs on your own machine. No API keys, no accounts, and no page text
ever leaves your computer.

Detailed setup, architecture notes and troubleshooting live in
[EXTENSION.md](EXTENSION.md).

## Why this exists

Chrome ships a `speechSynthesis` API, but it routes your page text through the
operating system's voices — the robotic ones, or a cloud service you did not
choose. This extension instead talks to a **Kokoro-82M** model running locally
via [MLX-Audio](https://github.com/Blaizzy/mlx-audio) on Apple Silicon, so the
voice is a modern neural TTS model and the audio never leaves the loopback
interface.

## Features

- **Sentence-level highlighting** via the CSS Custom Highlight API — no DOM
  mutation, so it cannot break the page's own scripts or styling.
- **Auto-scroll** that follows the spoken sentence.
- **Click any sentence to start from there**, or `Alt`-click to do it without
  the picker overlay.
- **Skip by section**, not just by sentence — a whole paragraph, heading or list
  item at a time.
- **Rescan the page** for text that appeared after load: infinite feeds, comment
  threads, "show more" buttons, SPAs.
- **Light / dark / auto theme** that follows your OS setting.
- **Works mid-playback** — skipping or restarting never requires pausing first.

## Requirements

- macOS on Apple Silicon (MLX is Apple-silicon only)
- Chrome 116 or newer
- A running Kokoro MLX server on `127.0.0.1:8000`

## Install

**1. Start the Kokoro server.** See [below](#the-kokoro-server) if you have not
done this yet.

**2. Load the extension:**

1. Open `chrome://extensions/`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this repository's folder

**3. Click the extension icon → "Read this page".**

> **Note:** Chrome 137+ removed the `--load-extension` command-line flag, so
> loading via `chrome://extensions/` is the only supported route. This is also
> why the extension is not on the Web Store — it depends on a local server.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `Alt+Shift+R` | Play / pause / resume |
| `Alt+↓` / `Alt+↑` | Next / previous section |
| `Alt+Shift+S` | Rescan the page for text |
| `Alt+Shift+X` | Stop (in-page) |
| `Alt`-click | Read from a sentence |
| `Esc` | Cancel the start-point picker |

All of these work while audio is playing. Rebind them at
`chrome://extensions/shortcuts`.

Chrome caps an extension at **4** commands with a preset shortcut, which is why
stop is handled in-page rather than as a registered command.

## The Kokoro server

This extension is the client half; it needs the MLX-Audio server running.

```bash
# One-time setup
uv venv .venv && source .venv/bin/activate
uv pip install mlx-audio "misaki[en]"

# Run it
python -m mlx_audio.server --host 127.0.0.1 --port 8000
```

The extension expects two endpoints:

- `POST /v1/audio/speech` — `{model, input, voice, response_format: "wav", speed}`
- `GET  /v1/audio/voices?model=...` — populates the voice picker

Use `response_format: "wav"`. The server's default `mp3` path returned an empty
body in testing.

## How it works

Manifest V3, split across four contexts because each has a hard constraint:

```
popup  ──settings──┐
                   ├─►  service worker  ──►  Kokoro server (127.0.0.1:8000)
content script ◄───┘         │
   │                         ▼
   │                   offscreen document  ──►  speakers
   └─ CSS Custom Highlight API (ra-current / ra-visited / ra-hover)
```

- **Content script** extracts sentences, renders highlights, scrolls, and owns
  the toolbar. It shares the *page* origin, so it cannot fetch the server —
  host permissions do not lift CORS for content scripts.
- **Service worker** does all networking (extension contexts are CORS-exempt),
  caches synthesized audio, and keeps itself alive while speaking.
- **Offscreen document** plays audio; an MV3 service worker cannot.

Two subtleties that shaped the design:

1. **The service worker is killed after ~30s idle**, which would cut off
   playback, so it pings itself while speaking.
2. **Re-anchoring is by sentence text, not index.** When you rescan after the
   page grows, inserting a paragraph above the cursor shifts every index;
   holding the raw number would silently move you elsewhere.

## Testing

The extension is verified by a Playwright harness that drives a real Chrome with
the extension loaded: **125 checks across nine suites**, covering sentence
splitting, highlighting, auto-scroll, the full user flow, continuous playback,
both themes, rescan, section skipping and keyboard shortcuts.

The harness uses an in-extension probe file rather than `eval`, because MV3's
Content Security Policy blocks `eval` and `new Function` inside
`chrome.scripting.executeScript`. That probe is not part of the shipped
extension and is gitignored here.

## Privacy

Page text is sent **only** to `127.0.0.1:8000`. The extension requests no
standing page access: it uses `activeTab`, so it can only touch a page after you
explicitly click the icon or press a shortcut. The only host permissions are the
two loopback forms of the Kokoro port.

## License

MIT
