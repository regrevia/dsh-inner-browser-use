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

## 2. A tool opens its own tab

Ask the model: `用 browser_view 看看当前页面`. Nothing was clicked.

Expected: the right sidebar gains an **内置浏览器** tab and the call returns the
page text plus numbered controls.

- `No 内置浏览器 tab answered.`: the tab did not open within `openWaitMs`. Check
  that the right sidebar is not collapsed and reload the window.

## 3. Drive a page

```text
browser_navigate  { "url": "https://example.com" }
browser_view      {}
browser_click     { "ref": 1 }
browser_type      { "ref": 2, "text": "hello", "submit": true }
browser_script    { "code": "return document.title" }
browser_screenshot{}
browser_upload    { "ref": 3, "file": "/absolute/path/note.txt" }
```

Expected: the pointer moves and ripples in the page; `click`/`type`/`upload`
each return a fresh `view`; the screenshot returns a path under
`.dsh-inner-browser-use/` in the chat's working directory.

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

`got` is the size of the returned PNG, or `none` when nothing painted. A page
that needs a sign-in still signs in, because the second guest shares the
partition; a page mid-form is rendered as it loads, not as it was.
