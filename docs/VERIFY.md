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

Pixels come from a painted surface. When this chat's page is not the one the
right column is drawing, the capture renders the same address in a second guest
on the same session partition and takes the image from there, then removes that
guest. `browser_screenshot` with `offscreen: true` always takes that path, so it
can be checked from any chat:

```json
{ "offscreen": true }
```

The proof log records what it found:

```bash
tail -3 /tmp/dsh-inner-browser-use.log   # "why":"capture-lens"
```

`why` is `capture-covered` when the app had no surface to read, and the message
says which tab to open.

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
  http://127.0.0.1:49661/dsh-inner-browser-use/<route>` flips from 404 to 200 on
  the next request, with no app restart.
- `client.js` (the page half) is re-imported about twenty seconds after a save.
  To prove which copy is loaded without a restart, put a temporary field in the
  probe and read it back instead of guessing:
  `grep -o '"rev":"[^"]*"' /tmp/dsh-inner-browser-use.log | tail -1`.

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
curl -s http://127.0.0.1:49661/dsh-inner-browser-use/state | grep -o '"pending":[0-9]*'
grep -o '"step":"other-chat"' /tmp/dsh-inner-browser-use.log | tail -1
```

The tool result names the tab strip of the chat being read, so the next step is
the person opening that chat — no empty column, and no eight-second pause.
