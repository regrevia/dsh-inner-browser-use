# Verify it works

Ten minutes, one page, no debugger. Each step names what a failure looks like.

## Before you start

- The plugin is installed and enabled in the profile (`0.3.0` or later).
- The app window was reloaded **after** the install: the page half only loads on
  a page load. A host-only reload is not enough.
- A chat is open, own workspace or not.

## 1. The page half is alive

```bash
curl -s http://127.0.0.1:<port>/dsh-inner-browser-use/state
```

Expected: `{"connected":[],"pending":0,"client":{…"tabType":true…}}`.

- `client: null`: the page half never reported in after this host started. Reopen the app.
- `"tabType":false`: the page loaded but the tab type did not register; the log
  line `phase:"idle"` in the proof log is the same fact.
- `client.fresh: false`: a page reported in and then stopped, or the app has been
  idle past a minute. The page half beats every 20 s.
- `client` present, `connected:[]`: correct before any tab is open. Seats are
  open tabs, not the page.

## 2. A tool opens its own page

Ask the model: `用 browser_view 看看当前页面`. Nothing was clicked.

Expected: the call returns the page text plus numbered controls, and the
**内置浏览器** tab shows the same page.

- `No 内置浏览器 tab answered.`: no page answered within `openWaitMs`. Check
  `phase:"resident-ready"` in the proof log; without it the stashed page never
  came up.

## 3. Drive a page

```text
browser_navigate  { "url": "https://example.com" }
browser_view      {}
browser_click     { "ref": 1 }
browser_type      { "ref": 2, "text": "hello", "submit": true }
browser_script    { "code": "return document.title" }
browser_screenshot{}
browser_download  { "url": "https://example.com/report.pdf" }
browser_upload    { "ref": 3, "file": "/absolute/path/note.txt" }
```

Expected: the pointer moves and ripples in the page; `click`/`type`/`upload`
each return a fresh `view`; the screenshot returns a path under
`.dsh-inner-browser-use/` in the chat's working directory.

Measured in the app on 2026-10-25, nothing clicked, one chat on screen:

| call | came back |
| --- | --- |
| `browser_navigate` | `Example Domain`, one control |
| `browser_view` | the page text and `#1 [link] Learn more` |
| `browser_script` | the selection it set |
| `browser_selection` | that selection, 917 characters |
| `browser_copy` | `Copied 917 characters` |
| `browser_click` | text changed to `clicked` |
| `browser_type` | `#1 [input] n = hello harness` |
| `browser_download` | `.dsh-inner-browser-use/downloads/report.pdf` and its size |
| `browser_upload` | `#2 [input] f = C:\fakepath\dshib-upload.txt` |

## 4. The tab does not disturb other panes

Open the guide pane (`开始`) and the files pane: both are unaffected by this
plugin. The plugin registers one tab type, one pane key and one title key, and no
guide card. `test/client.test.mjs` guards the last part.

## 5. Read the proof log

`DSH_INNER_BROWSER_PROOF` (default `/tmp/dsh-inner-browser-use.log`) records one
JSON line per lifecycle event: `downlink-open`, `uplink`, `watch-open`.

- `watch-open` with no `wanted` lines and a failing tool: the page never received
  the ask; check step 1.
- `uplink` frames with `"ok":false`: the page answered and refused; the error
  string is the answer.

## Exit codes

`npm test` runs both halves: 19 host tests over a real socket, 6 client tests
that load the page module with a fake module loader and a fake `EventSource`.
`node ~/.dsh/skills/ui-restraint/scripts/ui-copy-lint.mjs .` must print
`ui-copy-lint: clean.`

## A capture needs that chat's page to be drawn

Reading, clicking and typing drive the page itself, so they work while you are
looking at another chat. Pixels are different: they come from a surface the app
is drawing. A view sitting behind another conversation's view is not drawn — the
guest keeps a real size (`575x1015`) and `capturePage` never answers at all, so
the tool tries twice for a short time and then reports what it got, rather than
waiting fifteen seconds. `browser_script` still reads that page.

Two things were measured here, and both say the same: the app draws only the pane
it is showing. `capturePage` on the covered guest fails with
`UnknownVizError` — a surface with no frame — and a guest the plugin appends to
the page itself is never attached at all: every accessor throws
`The WebView must be attached to the DOM and the dom-ready event emitted`.
Rendering the page out of sight is therefore not something the page half can do,
so the tool reports the chat to open and stops. The frame
`why:"capture-covered"` records the page it was asked to draw.

The proof log carries the reason in the frame next to it:

```bash
tail -5 /tmp/dsh-inner-browser-use.log   # look for "why":"shot-geometry"
```

- `columnBefore` / `columnAfter` — the right column's size. `0x…` means the
  column is closed; the tool tried to open it and this is what it got.
- `body` — the page body's own size. Two zeros with a wide column mean the tab
  exists but is not the one the pane is showing.
- `active` — which view the pane had in front.
- `rooms` — the visible session containers and their sizes.

## A chat that is not on screen

Pixels come from a painted surface. A page behind another chat's tab has a size
but no surface, so the capture comes back empty; the tool then says which tab to
bring forward instead of guessing. A second guest would be no help here: it would
load the address again and photograph the top of a page whose scroll position and
form state are not the ones the chat is reading, so the image would not be of the
page the answer describes. Read the content instead — `browser_script` returns the
same text, and `browser_view` returns the same controls.

`browser_screenshot` with `offscreen: true` never opens the right column: it takes
the image only if a surface already exists and otherwise says so at once.

The proof log records what the capture found:

```bash
tail -3 /tmp/dsh-inner-browser-use.log   # "why":"capture-covered" carries href and error
```

A call for a chat the person is not reading never takes the column. If that chat
has no page yet, one is mounted out of sight and answers from there; only if that
is impossible does the call say which chat to open. The proof log shows the two
halves:

```bash
grep -m1 '"phase":"wanted"' /tmp/dsh-inner-browser-use.log   # panes, screen
grep -m1 'resident-open' /tmp/dsh-inner-browser-use.log      # the page made out of sight
```

At most three pages are kept out of sight, and the oldest goes first, so a long
session cannot pile them up.

## What has been run in the app

Each line was run against the live pane on 2026-10-25 and is what the tool
returned, not what the code was meant to do.

| Tool | The page | Result |
| --- | --- | --- |
| `browser_navigate` | example.com | title `Example Domain` |
| `browser_view` | the same page | one control, the link's text |
| `browser_script` | the same page | added a button, a form, and an output to the page |
| `browser_click` | the added button at 60,140 (120x40) | its label changed to `clicked`, its title to `probe clicked`, and the reply named the point: `at 120,160` |
| the pointer | read from the page after a click | `translate3d(116px, 158px, 0px)`, opacity `1`, `z-index: 2147483647` — the click point less the pointer's hotspot |
| `browser_type` | the added text field | the field held the text that was typed |
| `browser_download` | a page with a "Download" link | the file is in `<chat folder>/.dsh-inner-browser-use/downloads/` and the tool returns that path |
| `browser_upload` | the added file field | the field held the chosen file's name |
| a link the page saves itself | a page whose own script saves a file | the reply names the file under the chat's folder; `POST /land` without the page's header answers 403 |
| `browser_selection` | not yet run in the app | the host half that carries this tool loads on the next start; the bridge is covered by `test/host.test.mjs` |
| `browser_copy` | not yet run in the app | same |
| the page is remounted | the page went blank | the next call reopened it; frame `why:"restore"` |
| `browser_screenshot` | a page the app is not drawing | said which tab to open; frame `why:"capture-covered"` |

A capture of a page the app *is* drawing returned a 74 KB PNG of that page; the
same call on a covered page has no surface to read, which is the boundary
described above.

## Both halves reload without restarting the app

A change is verifiable without asking anyone to restart anything. The two halves
load at different moments, and both get there on their own:

- `index.js` (the host half) is re-imported as soon as the file changes. A route
  added or removed answers at once: `curl -s -o /dev/null -w '%{http_code}'
  http://127.0.0.1:49631/dsh-inner-browser-use/<route>` flips from 404 to 200 on
  the next request, with no app restart.
- `client.js` (the page half) replaces itself on its own: a loaded copy asks
  `/state` every four seconds and reloads when the served build differs from its
  own. A copy loaded before that self-check existed cannot replace itself, so the
  window's refresh control is the one step that is not automatic; after it, the
  page half keeps itself current. To prove which copy is loaded, read the hash
  the page reports instead of guessing: `curl -s
  http://127.0.0.1:49631/dsh-inner-browser-use/state | python3 -c "import json,sys;
  print(json.load(sys.stdin)['client'])"` — `native: true` means the page runs a
  copy that drives the product's own browser.

So: no restart to check a behaviour, and no restart to see the result of one.

To skip the wait, a reloader plugin mounted in the same app can be asked directly.
`dsh-unlag` answers on `POST /dsh-unlag/reload` with the header `x-dsh-unlag: 1`;
`GET /dsh-unlag/state` reports its two switches. It only acts while no turn is
running, so a request made from inside a turn answers `{"status":"busy"}` — leave
a waiter behind that asks again once the turn ends, and the next check runs on
the new code.

## The panel is taken only for the chat the person is looking at

A tool call can arrive for a chat whose page is not open. Taking the right panel
then would put an empty column in front of the chat the person is reading, so the
page half first asks which chat is on screen and answers only that one.

The answer comes from an occupant this plugin puts in the conversation header:
it renders nothing, measures the nearest header container that has a size, and
watches whether that container is on screen. Its beats name the chat:

```
grep -o '"phase":"seen","session":"[^"]*"' /tmp/dsh-inner-browser-use.log | tail -1
```

Switch chats in the app and the named chat follows, one line per switch. When the
call is for another chat, its tab is placed in that chat's strip and the call
answers that the tab is there — the panel is left alone:

```
grep -o '"step":"other-chat"' /tmp/dsh-inner-browser-use.log | tail -1
```

A frame naming no chat at all, when no header reports, keeps the older behaviour:
the tab is placed and the panel may open, then closes itself after three seconds
unless a page of ours mounted in it (`"step":"selfheal"`).

## A call that cannot get the panel answers at once

When the chat that asked is not the one on screen, the page says so on its next
heartbeat instead of opening anything, and the Host turns that into the call's
answer rather than waiting out `openWaitMs`:

```
curl -s http://127.0.0.1:49631/dsh-inner-browser-use/state | grep -o '"pending":[0-9]*'
grep -o '"step":"other-chat"' /tmp/dsh-inner-browser-use.log | tail -1
```

The tool result names the tab strip of the chat being read, so the next step is
the person opening that chat — no empty column, and no eight-second pause.

## Where a login lives

A pane leases the app's own sidebar guest, and the shell decides which storage
partition that guest gets. The shipped code reserves it like this:

```
partition = `dsh-sidebar-browser-${randomUUID()}`
// "Reserve one guest in a workspace's process-lifetime partition."
```

So a login is shared by every chat of the same project and survives closing the
tab or the chat. The partition itself is named fresh each run, so the guest keeps
nothing on disk; the page half therefore files what the *page* can read under
`~/.dsh/inner-browser-use/cookies/<hash>.json`, mode 0600, keyed by the workspace
key, and writes it back when that origin is opened again:

```console
$ ls -l ~/.dsh/inner-browser-use/cookies/
-rw-------@ 1 apple  staff   811 Oct 25 21:26 7b5c760580d2febdb4d5f50a.json
$ python3 -c "import json,glob,os;print([(c['name'],c['url']) for c in json.load(open(glob.glob(os.path.expanduser('~/.dsh/inner-browser-use/cookies/*.json'))[0]))])"
[('i18next', 'http://127.0.0.1:8765'), ('sid', 'http://127.0.0.1:8765'), ('__ac_nonce', 'https://www.douyin.com'), ...]
```

That file was produced by the app: one guest had been to `http://127.0.0.1:8765`,
another to `https://www.douyin.com`, and each save replaced only its own origin, so
both sites sit in the same workspace file. A save runs on `did-stop-loading` and
every 30 s while the guest is alive; a restore runs once the page it belongs to has
loaded, and the page is loaded once more only when a cookie was actually written,
because a cookie set from the page cannot affect a document already open. The log
shows `{"why":"cookies-restored"}` or `{"why":"signed-in-again"}` when that happens.

Two limits stay. Cookies marked `HttpOnly` are invisible to the page, so a login
that lives only in those needs the password again after the app quits. And the
store holds only what the page could read when it was saved, so a workspace that
has not opened a site yet has no file; `node scripts/doctor.mjs` prints
`sign-in  kept per workspace` either way.

## What a running app showed

Three flows were driven against the app itself, each one visible in its own output:

- **The arrow is in the image.** A click answered `at 101,167`, and the saved
  image showed the pointer over that control — the capture puts the arrow back
  even when the action is older than the arrow's own timeout.
- **A download lands in the chat's folder and arrives in the chat.** Following a
  file link answered `Saved <chat folder>/.dsh-inner-browser-use/downloads/report.txt
  (21 bytes)` and printed the file's contents in the same answer.
- **The page and its cookies stay.** A guest reopened with `"why":"reopen"` on the
  page it had been on, and a cookie set before a full navigation was still there
  after it.
- **A file the chat made goes back to the page.** A file input took the caller's
  own saved image: `Attached <image>.png to #1`, and the page reported
  `<image>.png 17033 bytes`. So a page reaches the chat, the chat reaches the
  folder, and the folder reaches the page again without anyone moving it by hand.

The caller sat in one chat while the person read another, and the page work
happened in the background chat's own guest: no pane was taken from the reader.
