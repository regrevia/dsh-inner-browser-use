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

- No `client` key: the page half is not running. Reload the window.
- `"tabType":false`: the page loaded but the tab type did not register; the log
  line `phase:"idle"` in the proof log is the same fact.
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

`npm test` runs both halves: 15 host tests over a real socket, 2 client tests
that load the page module with a fake module loader and a fake `EventSource`.
`node ~/.dsh/skills/ui-restraint/scripts/ui-copy-lint.mjs .` must print
`ui-copy-lint: clean.`
