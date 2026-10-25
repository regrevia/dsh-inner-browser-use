# Changelog

## 0.3.0

- Tools open the tab themselves: a call with no tab asks the page over a new
  `GET /watch` stream, and the page opens this chat's tab before the call runs.
  A call waits `openWaitMs` (8 s) for that tab, then fails with one sentence.
- One tab ask per burst: a second call for the same chat within 3 s does not ask
  again, and a call with no page listening never silences the next ask.
- `GET /state` reports whether the page half is alive: a heartbeat carries its
  age and `fresh` goes false after a minute, so a plugin whose page half never
  loaded no longer looks installed-and-fine.
- The tab type no longer contributes a card to the guide pane, so the plugin
  adds nothing to any pane it does not own; `test/client.test.mjs` asserts that.
- Client-half tests run the page module in Node with a fake module loader, so
  registration and the auto-open handshake are covered without a browser.

## 0.2.0

- `browser_screenshot`: captures the tab's viewport and writes a PNG under
  `.dsh-inner-browser-use/` in the chat's working directory, returning the path.
- `browser_upload`: reads a local file and attaches it to a numbered file field
  through an in-page `File` and `DataTransfer`, with an 8 MB ceiling.
- Tests now cover both new tools, including the bytes that cross the wire.

## 0.1.0

First release.

- Host bridge over same-origin HTTP: `GET /downlink` (SSE), `POST /uplink`, `POST /push`, `GET /state`.
- Five tools: `browser_navigate`, `browser_view`, `browser_click`, `browser_type`, `browser_script`.
- Client tab kind `inner-browser-use` on the `sidebar.right.pane.tab` slot, leasing a `<webview>` from the Desktop main process with the workspace's own partition.
- In-page runtime: numbered controls, real pointer and ripple, scroll-into-view, genuine mouse and keyboard events.
- Per-chat seats with a single-tab fallback; a closed tab rejects waiters, a silent one times out.
- Client heartbeat on the state route, so install problems are diagnosable without a debugger.
- 10 host tests, no dependencies, no build step.
