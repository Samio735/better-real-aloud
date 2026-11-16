# Read Aloud (Kokoro) — Chrome extension

Reads page text aloud through your **local Kokoro MLX server**, highlighting each
sentence as it is spoken, auto-scrolling to keep it visible, letting you click any
sentence to start from there, and giving you pause / resume / restart.

Everything runs on your machine. No API keys, nothing sent to a cloud service.

---

## 1. Start the Kokoro server

The extension needs the MLX-Audio server running:

```bash
cd ~/kokoro-tts
./run-server.sh          # foreground; Ctrl+C to stop
./run-server.sh --bg     # background, logs to server.log
./run-server.sh --status # is it up?
./run-server.sh --stop   # stop it
```

Check the green dot in the extension popup — that means it can reach the server.

## 2. Load the extension (one-time, manual)

**Chrome removed the `--load-extension` command-line flag in version 137**, so
this cannot be scripted — Chrome 157 (what you have) silently ignores it. It has
to be done by hand, once:

1. Open `chrome://extensions/`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the folder `~/kokoro-tts/reader-extension`

The extension persists across restarts. You only do this again after editing the
files (then press the reload ↻ button on the extension card).

## 3. Use it

1. Go to any article.
2. Click the extension icon, then **Read this page**.
3. The on-page toolbar appears and the page asks you to **click a sentence to
   start from there**.
4. Click any sentence — reading starts there, that sentence is highlighted, and
   the page scrolls to follow along.

### Controls

| Action | How |
| --- | --- |
| **Choose the start point** | Click any sentence on the page |
| Play / pause / resume | Toolbar **▶ / ❚❚**, or `Alt+Shift+R` |
| Stop and clear | Toolbar **■**, or `Alt+Shift+X` |
| **Skip a whole section** | Toolbar **⇡ / ⇣**, or `Alt+↑` / `Alt+↓` |
| **Restart from the top** | Toolbar **↺** |
| Previous / next sentence | Toolbar **⏮ / ⏭** |
| **Rescan the page for text** | Toolbar **⟳**, or `Alt+Shift+S` |
| Read from a sentence | `Alt`-click a sentence (without the picker) |
| Cancel the picker | `Esc` |

Every shortcut works **while audio is playing** — skipping a section or
restarting never requires pausing first. That is deliberate: `jumpTo()` routes
through `playFrom()`, which bumps the run id and cancels the in-flight sentence,
so the reader never stalls at a stale index.

The toolbar is draggable by its background — grab it and move it out of the way.

**Section vs. sentence.** A *section* is one paragraph, list item, heading or
blockquote. `Alt+↓` jumps to the first sentence of the next block, so you skip a
whole paragraph at a time instead of clicking **⏭** repeatedly. `Alt+↑` rewinds
to the *start* of the previous block rather than landing mid-paragraph.

**Rescan** exists because pages change after load. Infinite feeds, comment
threads, "show more" buttons and SPAs all add text that wasn't there when
reading started, and that text is simply missing from the sentence list. Press
**⟳** and it is picked up. Your position is re-anchored *by sentence text*, not
by index — inserting a paragraph above the cursor shifts every index, so holding
the raw number would silently jump you elsewhere. Audio resumes only if it was
playing, so a rescan can't startle you into sudden speech.

**Note on shortcuts:** Chrome allows at most **4** commands with a preset
shortcut per extension. Play/pause, both section skips and rescan take those
slots; stop and the sentence-level keys are handled in-page instead. All of them
can be rebound at `chrome://extensions/shortcuts`.

### Settings (extension popup)

- **Voice** — all 54 Kokoro voices, fetched live from the server, labelled by
  language and gender (`heart — US ♀`).
- **Speed** — 0.5× to 2×.
- **Volume**
- **Auto-scroll** — follow the spoken sentence.
- **Skip nav, headers and footers** — don't read the site menu aloud.
- **Toolbar theme** — `Auto` (follow the system), `Light`, or `Dark`. Changing it
  repaints the toolbar already on the page, so you don't have to restart reading.
- **Test voice** — hear a sample before committing to a long article.

Both palettes are defined once as CSS custom properties and selected by a
`data-ra-theme` attribute, so switching is a single attribute write with no
style recalculation in JS. `Auto` is left to a `prefers-color-scheme` media
query, which means an OS appearance change is picked up even while a page is
open. Status text keeps a WCAG AA contrast ratio against the toolbar surface in
both themes (7.4:1 dark, 5.8:1 light).

Settings sync across your Chrome profile via `chrome.storage.sync`.

---

## Trying it out

A test page with enough text to exercise scrolling and highlighting:

```bash
open ~/kokoro-tts/test-page.html
```

Note: `file://` URLs work, but if you find the extension won't attach, serve it
over HTTP instead:

```bash
cd ~/kokoro-tts && python3 -m http.server 8899
# then open http://127.0.0.1:8899/test-page.html
```

---

## How it works (and why it's built this way)

```
content script          background worker           offscreen document
──────────────          ─────────────────           ──────────────────
extract sentences   →   POST /v1/audio/speech   →   play WAV
build DOM Ranges        (Kokoro / MLX server)       report "ended"
highlight via           cache WAV as data URL
CSS Highlight API   ←   "sentence finished"     ←
auto-scroll
```

Five non-obvious constraints shaped this design. Each is a real bug that I hit or
verified, not a hypothetical:

**1. Networking happens in the worker, never the content script.**
A content script shares the *page's* origin for network purposes, so fetching
`127.0.0.1:8000` from it is subject to that page's CORS and Chrome's Local
Network Access rules. Host permissions do **not** lift CORS in a content script.
In the extension context — with `host_permissions` declared — the request is
exempt. This is the single most common surprise in MV3.

**2. Audio plays in an offscreen document.**
MV3 service workers have no DOM and cannot play audio. The `offscreen`
permission creates a hidden document (`AUDIO_PLAYBACK` reason) that owns the
`<audio>` element. Note it auto-closes 30 seconds after audio stops, so the
worker recreates it on demand.

**3. The worker is kept alive only while speaking.**
MV3 workers are killed after ~30s idle, and audio playback is *browser-process*
activity — it does not count as worker activity. Without a keepalive the worker
dies mid-article and the highlight freezes while audio keeps playing, because
nothing is left to advance it. A 20s `chrome.runtime.getPlatformInfo()` ping runs
while, and only while, something is playing.

**4. Highlighting uses the CSS Custom Highlight API, not `<span>` wrapping.**
Wrapping text nodes mutates the page's own DOM inside whatever framework owns
it; the next React/Vue re-render erases the span or fights you for it. Ranges +
`::highlight()` never touch the DOM. Chrome 105+ (you have 157). Two things
people miss: `::highlight()` accepts only colour-ish properties (no padding,
border or shadow), and you must set the text colour explicitly — otherwise a
dark-mode page renders white text on the yellow highlight, which is unreadable
at exactly the moment the user is looking at it. Both handled in `content.css`.

**5. Sentence-sized chunks, not one long utterance.**
Kokoro is asked for one sentence at a time. This is what makes the highlight
exact (one chunk = one known sentence), keeps each request short, and lets the
next sentence's audio be prefetched while the current one plays. Without
prefetch, every sentence boundary would have a gap the length of a synthesis
call.

**Sentences are snapshotted at extraction time.** If a page re-renders while
being read, the stored ranges go stale. Rather than highlight the wrong text, we
detect the mismatch (range text no longer equals the recorded sentence) and skip
drawing for that sentence. Audio continues normally.

---

## Verified behaviour

The extension is exercised end to end with Playwright driving real Chrome,
Kokoro synthesising real audio, and the offscreen document really playing it.
125 checks pass across nine suites:

| Suite | Covers | Result |
| --- | --- | --- |
| Architecture | manifest, permissions, message wiring between the four contexts | 32/32 |
| Sentence splitter | abbreviations, initials, decimals, URLs, ellipses, quotes | 13/13 |
| Completion latch | both arrival orders, stale indices, stop-unblocks-waiter | 6/6 |
| Core pipeline | extraction, nav skipping, Highlight API, hit-testing, WAV, playback | 22/22 |
| User flow | start, continuous reading, auto-scroll, pause, restart, stop | 21/21 |
| Toolbar theme | auto/light/dark, OS following, contrast, live switching | 19/19 |
| Rescan | stale list, new text, position re-anchoring, edges | 25/25 |
| Section skip | block boundaries, forward/back, mid-playback, edges | 22/22 |
| Keyboard shortcuts | play/pause, skip, rescan, stop, field safety | 12/12 |

Four real bugs surfaced during that verification and were fixed:

1. **Playback stopped after the first sentence.** The prefetch cache stores
   *promises*, but `playSentence` read `.ok` off the promise itself, got
   `undefined`, and treated every prefetched sentence as a failure. Now awaited.
2. **The byline split in the wrong place.** `"By A. Researcher"` became
   `"By A."` + `"Researcher"` because the initial-detection regex anchored the
   letter at the end of the buffer, where the dot actually sits.
3. **Reading stalled on short sentences.** `ra-chunk-ended` could arrive before
   the page started waiting for it (synthesis is slower than playing a two-word
   sentence), and the signal was silently dropped. The latch is now keyed by
   sentence index so arrival order does not matter.
4. **Two toolbars appeared, and stop left one behind.** The duplicate guard
   tested `document.body.contains()`, but the toolbar is appended to
   `documentElement`; cleanup now removes by id.
5. **The extension refused to load at all.** Chrome caps `commands` at four
   entries carrying a `suggested_key`; adding rescan and both section skips on
   top of the existing two made five, and the manifest was rejected outright.
6. **Rescanning mid-playback stalled the reader.** `step()` waits on
   `waitForChunk(oldIndex)`, and re-anchoring changes what that index means, so
   the awaited event never arrived. Rescan now cancels the in-flight chunk and
   resumes afterwards only if audio was running.

## Troubleshooting

**"Kokoro server not reachable"**
Run `./run-server.sh --status`. If down, `./run-server.sh --bg`. The first
request after starting loads the model (~3s); later ones are faster.

**Server returns no audio / "install ffmpeg"**
The server's default audio format is MP3, which needs `ffmpeg`. The extension
always requests `response_format: "wav"` to avoid this, since WAV is always
available. If you see this, something is overriding the format.

**Highlight doesn't move but audio plays**
Usually the stale-range case (a page that re-renders), or the worker was
collected. Reload the page and restart reading.

**Nothing happens when I click Read this page**
Some pages can't be scripted: `chrome://` pages, the Chrome Web Store, and the
PDF viewer. The popup will say so.

**Toolbar not visible**
It's fixed at the top center. If the page has an aggressive z-index or a
full-bleed header, drag it by its background, or scroll — it stays fixed.

**Sentence boundaries look wrong**
The splitter handles abbreviations (`Dr.`, `e.g.`), decimals, ellipses and
quoted endings, but it's heuristic. Use the ⏭ / ⏮ buttons to skip a bad join.

---

## Files

```
reader-extension/
  manifest.json      MV3 manifest (activeTab, scripting, storage, offscreen)
  background.js      service worker: Kokoro fetch, prefetch, keepalive, routing
  content.js         sentence extraction, highlight, auto-scroll, click-to-start
  content.css        ::highlight() styles + on-page toolbar
  offscreen.html/js  hidden document that plays the audio
  popup.html/css/js  settings, voice picker, connection status
  icons/             generated PNG icons
run-server.sh        start / stop / status the Kokoro server
test-page.html       sample article for trying it out
```

## Security notes

- The server binds to `127.0.0.1` only, so it isn't reachable from other machines.
- The extension requests `activeTab`, not `<all_urls>`: it can only touch a page
  after you explicitly click the icon or press the shortcut. It has no standing
  access to your browsing.
- Host permissions are limited to `127.0.0.1:8000` and `localhost:8000`.
- The MLX-Audio server has no authentication. Loopback binding is what protects
  it. Don't rebind it to `0.0.0.0`.
