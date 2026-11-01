# Architecture

Two halves in two processes, and a Chrome that neither of them is.

```
server side  (index.js, in the DSH process)
  browser_* tools ──> Sidecar ── CDP over a socket ──> headless Chrome
                         │
  HTTP + SSE routes <────┘
        │
        │ same origin as the product document, no other channel
        │
page side  (client.js, in the product document)
  right column: JPEG picture, black arrow, input handlers, address row
```

## Why a wire

The page half runs in the product document. It can paint a picture and read the mouse, and
that is the limit: a page may not read another origin's DOM, and the product's own browser
tab belongs to the product. The agent needs the page's text, its controls and real input
events, which only the browser itself can give.

So the server half owns a Chrome process and speaks CDP to it, and the two halves exchange
two things over the plugin's own routes: frames going one way, input and navigation going the
other. The picture is a consequence of that, not the mechanism.

## Chrome lives outside the product

The browser is a normal Chrome launched with `--user-data-dir` pointing at
`~/.dsh/inner-browser-use/chrome/<profile>`, the profile name lowercased to `default`.
Chrome's own storage is not used, and the product's browser storage is not used either: that
one is created per process, so every sign-in in it is gone at the next restart.

Other launch flags:

| Flag | Why |
| --- | --- |
| `--headless=new` | No window on the desktop, still a full rendering engine. |
| `--remote-debugging-port=0` | Chrome picks its own debugging address. | <!-- ui-copy-ignore -->
| `--use-mock-keychain`, `--password-store=basic` | No keychain prompt on macOS. |
| `--remote-allow-origins=*` | The CDP client connects over a plain WebSocket. |
| `--disable-blink-features=AutomationControlled` | Sites that sniff for automation get the ordinary path. |
| `--window-size=1440,900`, `--lang=zh-CN` | The window the browser starts in, and a Chinese page locale; the layout viewport is set to the column instead. |

The binary comes from a fixed list: Google Chrome, Chromium or Canary under `/Applications`,
then `/usr/bin/google-chrome` and `/usr/bin/chromium`. Nothing else is probed and there is no
setting to add a path.

## Attach and lifetime

The browser outlives the plugin:

1. `ensure()` reads `DevToolsActivePort` from the profile directory.
2. It probes `GET http://127.0.0.1:<address>/json/version`. A stale file is deleted and Chrome
   is launched again.
3. Otherwise the running Chrome is adopted: the page target is read from `/json/list` (with
   `/json/new?about:blank` as a fallback) and a client connects to it.

One page per browser. `apply()` only constructs the `Sidecar`; no process exists until the
first tool call, and `browser_state` reports a stopped browser without starting one.

Shutdown asks Chrome to close (`Browser.close`), waits briefly, then sends `SIGTERM`, which is
the point where Chrome flushes cookies.

Lifetime is a ladder rather than one timer, because a browser that is being watched and one
that was forgotten deserve different answers (`docs/RESOURCES.md` has the measurements and the
comparison with other projects):

| step | trigger | effect |
| --- | --- | --- |
| awake | a tool call, or a mirror watching | none |
| quiet | no call for `quietAfter()` and a mirror is still open | screencast stopped, page frozen |
| rest | no call for `restAfter()` and nothing watching | cookies saved, whole tree closed |

`rest.js` derives both windows from the gap between the person's own calls: p95 of the last 64
gaps × 6 for rest, × 2 for quiet, each clamped (`90 s – 15 min`, `20 s – 2 min`). A fresh
process has no history and uses the floors. `decide()` is pure, so the clock is testable
without a browser, and the watched count always beats the deadline: a page someone can see is
frozen at most, never closed.

Closing is single-flight (`shutdown()` returns the promise already in flight) and `launch()`
waits for the outgoing browser before spawning the next one — without that, a rest that fires
as a call arrives closes the socket the call is about to use. Every 30 s the tree is weighed
against `DSH_INNER_BROWSER_MEMORY_MB` (default 2400): over budget, idle tabs are reclaimed by
LRU and casts back off; over again with nobody watching, the browser rests on the spot. Three
crashes inside ten minutes stop the restart loop and say why instead of trying forever.

## Routes

Everything hangs under `/dsh-inner-browser-use`, all same-origin, bodies capped at 1 MB.

| Route | Kind | Purpose |
| --- | --- | --- |
| `GET /sidecar/frames?session=` | SSE | The mirror: `hello`, then frame messages, plus pointer messages. |
| `GET /sidecar/state` | JSON | What the browser is doing. |
| `POST /sidecar/open` | JSON | Start or reuse the browser, optionally navigating. |
| `POST /sidecar/input` | JSON | `hover`, `move`, `click`, `wheel`, `text`, `key`; answers with the page's cursor. |
| `POST /sidecar/nav` | JSON | `back`, `forward`, `reload`, or a `goto` with an address. |
| `POST /sidecar/stop` | JSON | Close the browser now. |
| `GET /downlink?session=` | SSE | Per-session notices; the only message today is `sidecar-wanted`. |

The page half never learns the debugging address. It knows the route prefix and nothing else;
the CDP socket stays in the server half.

## Mirror

The server half starts `Page.startScreencast` with JPEG quality 72, `maxWidth` and `maxHeight`
at the pane's size, `optimizeForSpeed`, `everyNthFrame: 1`, and acknowledges every frame it receives
so Chrome keeps sending. Frames are never queued: with two frames in flight, further frames
are dropped and the next one that fits takes their place. A slow reader loses frames, never
freshness.

The layout viewport follows the column: the pane measures itself, posts the size to
`/sidecar/viewport` a beat after the resize settles, and the server pins
`Emulation.setDeviceMetricsOverride` to that size and restarts the screencast at it. So a frame
is the whole page as laid out at the shape it is shown in — no letterbox bands, no crop. Sizes
below 320 px or above 1920×1600 are ignored rather than applied as a sliver.

If `Browser.getVersion` reports `HeadlessChrome`, the user agent is overridden with an ordinary
Chrome string, `acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8'` and `platform: 'MacIntel'`, so a site
that gates on headless gets the normal rendering.

The stream is SSE with a comment beat every 15 seconds. A response that falls more than 3 MB
behind is given up rather than buffered, Nagle is off on the socket, and a session that opens a
second stream replaces its first seat: one column per session, no fan-out of stale frames.

## Pointer, input, cursor

Two pointers, two sources:

- The agent's arrow comes from the tool calls. `movePointer()` sends `{type: 'pointer', w, h,
  pointer}` on the same stream and the pane draws it at once, so the arrow does not wait for
  the next frame. Hovering with your own mouse sends `mouseMoved` and never touches that state.
- Your own cursor stays the system cursor. The pane asks the page which CSS cursor sits under
  the hand (`cursorAt()`), the reply to `/sidecar/input` carries it, and the pane applies it
  only when it is in the pane's allow-list.

Clicks are `Input.dispatchMouseEvent` down and up at one point. Typing is `Input.insertText`:
a composed Chinese word or a pasted string lands as one insertion rather than key by key.
Named keys go through `Input.dispatchKeyEvent` with a table mapping Enter, Tab, Escape,
Backspace, Delete, the arrows, Home, End, PageUp and PageDown to their key and code, which is
what makes Backspace delete a character on the page instead of nothing.

## Session scoping

The right column is shared by every plugin and belongs to whichever session is on screen. A
tool call pushes `sidecar-wanted` down that session's own `/downlink`, and the page half opens
the mirror tab only when `sidebarRight.mounted` equals the session that asked. An unknown or
empty `mounted` is a refusal, not permission.

The frame stream is opened by the pane with its own `session` in the query. A chat whose column
sits on another session gets no frames, and a tool call in the background drives the same
browser without pulling the column away from the person reading it.

## Tool surface

`sidecarTools()` in `tools.js` builds the 39 definitions and `index.js` registers them on the
plugin's tool scope. All of them return one text block. A page read numbers the controls and
keeps those numbers across later reads, so `browser_click` by ref means the element the model
last saw; navigation drops them and the model gets `REF_GONE` rather than a wrong click.

Before a ref click or a ref focus, one page-side probe asks what is on top of that control.
When something is, and that something carries its own safe way out (a banner with Accept /
Close, a modal with 同意 / 关闭), the probe's answer names that button's point, the driver takes
it, checks the control is clear, and then performs the action the model asked for. The result
says both things. An overlay whose wording involves deleting, paying or signing out is only
reported, never accepted on the person's behalf. The whole exchange is one `Runtime.evaluate`
and a possible `mousePressed`/`mouseReleased` pair on an already-open CDP connection, so an
uncovered click pays nothing.

`browser_do` runs the same probe before a step that names a control — by `ref`, by
text, or by field label — so a banner the first step clears is gone for the rest of
the batch, and the step's own line says it in one clause (`after Accept on a banner,`).
A batch therefore pays for one overlay, not one per step.

An action answers with one line — address, title, focused field — and reads the page only when
`read: true` is passed. That is what keeps a long batch cheap (see `BENCH.md`).

Calls that touch the browser are marked not concurrency-safe; reading state, console and failed
requests is. `browser_open`, `browser_view`, `browser_wait` and `browser_shot` carry longer
timeouts than the rest.

`browser_wait` does not poll: one call hands the page a predicate and a `MutationObserver`, and the
picture comes back on the mutation that satisfies it. A page that changes 137 ms after the wait
starts answers at 138 ms, not at the next 100 ms tick — the same reason `idle` (a mutation-free
window) costs one round trip on an animation-heavy page instead of one per frame.

## Reading for an answer

`browser_read` with a `query` does not return the page; it returns the sentences that answer the
question. The page-side block reader already returns paragraphs with their heading trail
(`Plans \u203a Trial`), their link density, a 0-1 quality score and table rows as one
`column: value | column: value` line, so the work stays in `read.js` and costs no extra round trip.
When the page's own menu would eat the budget, the blocks past the ceiling are chosen by quality and
then put back in page order, so prose survives where document order would have spent everything
above it.

Paragraphs are ranked first (BM25 over the question's terms, link-heavy menus down-weighted), then
split into sentences. Each sentence is scored on its own with the same saturation and length
normalisation, and that score is multiplied by three priors: the words of its heading, the rank of
the paragraph it sits in, and inverse link density. Words the page says everywhere are dropped
before scoring — a term in most sentences cannot point at anything — and a sentence that matches
only part of the question is scaled by the share of the question's idf weight it actually covers,
which is what stops a paragraph containing "to" from competing with one containing "refund". The
block's quality score and its being a table row are priors as well, so a menu that repeats the
question's words cannot outrank the sentence that explains them.

Selection is not "the top N scores": each pick subtracts its Jaccard overlap with what is already
chosen (MMR), selection stops when the best remaining sentence is worth nothing, and picked
sentences are packed to a character budget and restored to document order. Terms are folded
(plurals, trailing `-ing`/`-ed`) so a question can use a different inflection than the page.

`sentences: false` keeps the paragraph path for callers who want the whole section.

A question the page cannot answer costs the miss, not the page: when no sentence clears the
cut, `readRelevant` returns the three blocks that ranked highest (each trimmed towards 260
characters) and no text, and the tool turns that into a line saying nothing directly answers the
question plus those passages. The whole page is still one `browser_view` away, so the expensive
fallback — a page pasted into the context for a question it never addressed — is gone.

## Looking at a page that draws itself

A canvas, a game and a Flash movie have no text tree and no controls: a snapshot reads
an empty page and a screenshot costs image tokens on every look. `browser_look` takes
the captured frame, decodes the PNG inside Node (so no page policy and no browser
decode step is involved) and prints a grid of palette letters — one letter per block of
screen, the same letter for the same colour. A 12×8 look costs about 200 characters; a
second look diffs against the first grid and reports only the cells that moved, plus the
box they moved in. `browser_prepare` is the way in: it reports the surface, the frame
rate and whether keys arrive, and says when the page needs the Flash runtime.

## Sites that teach the next read

Two calls into the same origin, the browser knows what it is looking at. A record per
origin in `sites.json` holds an exponentially drifted average of the page's character
count, its control count and its article length, updated by every `browser_view` and
`browser_read` — measured before the budget cuts the output, so a cut does not shrink
the site on the next visit. Past two reads, a site whose text or control count is big
opens `browser_view` as the `map:` view instead of a page of numbered controls, and a
site whose articles are long has `browser_read` land at 3,500 characters and say where
it cut. Every learned default carries the measurement that produced it, and every one
yields to what the model asked for: an explicit `mode`, `query` or `max_chars` is used
as given. The record lives in `~/.dsh/inner-browser-use/sites.json` (override with
`DSH_INNER_BROWSER_STATE_DIR`), is written at most once every two seconds, and never
holds page text — only counts.

## Answering across tabs

A question can be answered by a tab that is not the one on screen. Moving the mirror there and
reading again costs two calls, a screencast teardown, and the person's view moved for nothing, so
a miss tries the tabs instead: `elsewhere(session)` lists the tabs the calling chat holds (its own
mirror excluded), opens one read-only CDP handle per tab — `Cdp` on that tab's own
`webSocketUrl`, never a full `SidecarPage`, never `cast()`, never a screencast stop — and
`readTabs` pools blocks from all of them under one `maxChars` ceiling and runs the same
`evidence()` pass once, so a merged answer costs the same characters as a single-tab one. Every
row keeps the title of the tab its text came from, and every handle is closed in a `finally`.

Only the calling session's claimed tabs are candidates: another chat's tab, and an unclaimed one,
are not read. At most three extra tabs are opened, and the path only runs when the current tab has
no answer, so a normal question pays nothing for it. `across: false` turns it off. `pruneStrays`
counts claimed tabs as owned, because a tab a chat holds is not a stray.

## Sign-ins and reclaim

Sign-in state lives in the profile, and session cookies — the kind a sign-in usually sets,
which Chrome would otherwise drop on exit — are saved next to it and restored on the next
launch, so a restart of the app does not sign the person out.

Three layers, each adding one thing the previous cannot do:

- **The profile** keeps everything Chrome writes: dated cookies, origin storage, service
  workers. It survives a restart of the app and a restart of the machine.
- **The session jar** (`session-cookies.json`) covers the part Chrome throws away on exit.
  Every cookie that comes back from `page.cookies()` without an expiry is written when the
  browser closes, and put back on the next launch. A cookie the browser already holds is
  never overwritten from the jar — a rotation happened in the live browser, and the jar is
  the older truth.
- **`chromecookies.js`** reads a browser's own cookie store off disk, in memory only: copy `Cookies`
  (with `-wal`/`-shm`, since the browser holds the lock) to a temp dir, then `node:sqlite` or
  `/usr/bin/sqlite3 -readonly`. Values are sealed with the browser's Safe Storage password from the
  macOS keychain: PBKDF2-SHA1 (1003 iterations, `saltysalt`) → AES-128-CBC with a space IV, and the
  SHA-256 host prefix newer Chromium builds prepend is checked and stripped. Values it cannot open
  (Chrome 127+ app-bound `v20`) are counted, never guessed; cookie values are never returned to the
  model or logged. On macOS the process needs Full Disk Access for the profile root, and the tool says
  exactly that instead of pretending there is no profile.
- **`browser_login`** (`vault.js`) turns that state into named snapshots a chat can call
  back: cookies plus per-origin `localStorage`, saved under a name, listed, restored, or
  dropped. `list` is a directory read, so it costs nothing while the browser is down.
  Restoring writes cookies first, then navigates to each stored origin to write its local
  storage (the API is origin-bound), then reopens the page that was saved.

Everything written at rest is sealed with AES-256-GCM (`{v, alg, iv, tag, data}`, all
base64). The key comes from `DSH_INNER_BROWSER_VAULT_KEY` when a test sets one, otherwise
from the macOS keychain, otherwise from `vault.key` in the state root — 0600, and a fallback
rather than the intended home, because an unattended `security add-generic-password` can
block on a prompt. A tampered blob, a wrong key and a truncated file all come back empty;
nothing trusts what it cannot verify. A plaintext jar from a version before this one is
still read and re-sealed on the next write, so an upgrade does not sign anyone out.

The reclaim ladder is three separate timers, because they answer three different questions:

| Question | Timer | What happens |
| --- | --- | --- |
| Did the person close the column? | `REST_MS` = 60 s | The browser is put away a minute after the last pane lets go. |
| Has nobody touched it at all? | `IDLE_MS` = 15 min | The whole process is reclaimed, but never while a pane is still watching a frame. |
| Is this one tab stale? | `TAB_IDLE_MS` = 10 min, `MAX_TABS` = 6 | The tab is closed, not the browser; a returning chat gets a fresh page instead of a dead one (`expired`). |

`browser_state` reports both what the process costs right now (`ps` over its process tree,
which includes renderers, not just the parent) and `closesIn`, so the model can decide
between keeping the page and letting it go instead of guessing. A freeze
(`Page.setWebLifecycleState`) is deliberately not wired in: closing a stale tab is already
cheap, and a frozen page that misses a mutation would make the event-driven wait lie.

A system-prompt section (`browser-in-this-chat`) tells the model to reach for these tools
without asking first when someone wants something done on a site.

## Network

`Network.enable` is already on for the mirror. A request is kept when it is
sent and settled when its response arrives, so the list holds method, status,
type and address of what the page actually got — 120 rows, oldest dropped.
`browser_network` reads that list without touching the page, which is why it
can answer while a dialog is open.

## Downloads

Chrome is pointed at `<profile>/downloads` when the page starts, so a click
that saves a file writes it there instead of nowhere. The folder belongs to
the profile: it is the same one on the next launch, and nothing outside the
profile is touched. `browser_downloads` lists what is on disk, newest first;
a `.crdownload` still in flight is not listed.

## Frames and popups

A page is not one document. Chrome keeps a table of frames and gives each one the
JavaScript context its scripts run in; the plugin listens for those contexts as they
are created and destroyed, so a read can be sent to the context that owns the
controls it wants.

- A read walks the frame tree main frame first and sends one snapshot per frame, so a
  form inside an iframe is numbered with the page's own controls.
- Refs from a frame are offset: `900000 + slot * 100000 + local`. The slot is the
  frame's position in the tree, so the number says which context to resolve in, and a
  frame's refs never collide with the page's.
- A click on a framed control resolves in that frame, then adds the frame's rectangle
  to the point it found, because input is always dispatched in viewport coordinates.
- A frame Chrome runs in another process is a target of its own: the plugin keeps the
  session Chrome hands it, so a read can be sent there and its controls still get a slot.
  Its corner is asked from the page, through the frame's owner element, because the
  frame's own process cannot see where it sits.

A click can open a tab. A page target gets no handle on its own popups, so after an
action the plugin asks the DevTools address list for page targets other than the one it
drives. If one appears, the mirror navigates to its address and the popup is closed with
the target HTTP endpoints. A person watching the column sees where the click went,
and there is still one page to drive.

## Files

| File | Half |
| --- | --- |
| `index.js` | Server: routes, tools, CDP page reads, system prompt. |
| `sidecar.js` | Server: Chrome launch, attach, screencast, input, shutdown. |
| `client.js` | Page: the column, its stream, the arrow, the address row. |
| `locale/*.json` | Page: pane labels. |

Data on disk is confined to `~/.dsh/inner-browser-use/`: `chrome/<profile>` for the browser,
`screenshots/` for `browser_shot`.
