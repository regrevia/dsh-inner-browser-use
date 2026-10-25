# Changelog

## 0.4.3

- Opening the right pane works. `layout` has to be in the plugin's inject list,
  not only in the list passed to one nested scope: the nested read threw
  "cannot get property layout without inject", so the pane stayed closed and
  every screenshot of it came back empty.

## 0.4.2

- A capture no longer trusts the webview element's own width. The element
  reported 0×0 while its page was 575×1080, so a screenshot failed before it
  tried. The capture now measures the box, opens the pane when the box is empty,
  follows the guest that is actually mounted, and tries three times.
- A capture that still comes back empty names the geometry it saw, so the next
  report is a measurement rather than "no image".

## 0.4.1

- The tab has a real height. The guest was laid out inside a column that had no
  height to give it, so the page rendered at 0×0 and every capture came back
  empty. The body is now a flex item of the pane, with a viewport between it and
  the guest — the same chain the shipped browser pane uses.
- A capture puts the pane on screen first when the guest has no size, and a guest
  that is still off screen reports its size instead of "no image".

## 0.4.0

- `browser_screenshot` returns again. The panel's PNG is handed back as a data
  URL string, because the image Buffer does not cross the desktop bridge, and the
  guest debugger this build exposes has no `Page.captureScreenshot` to use. Each
  stage now has its own budget, so a slow attach fails as "attach timed out"
  instead of a bare timeout.
- A tool call can no longer steer another chat's tab. Every open page hears the
  ask, so a page now opens the asking chat's tab by id; opening "the current
  chat" is allowed only when the mounted pane is that same chat.
- `browser_selection` returns what is selected in the page, so the agent can quote
  it here. `browser_copy` puts the selection, or one numbered control's text, on
  the clipboard for a paste into the chat.

## 0.3.6

- A PNG now comes from the guest's own debugger, which answers with base64 in
  this page. The panel's capture is still the fallback.

## 0.3.5

- `browser_screenshot` works again: the first capture of a guest that has not
  painted yet fails inside the compositor, so it is retried once, and the PNG is
  written without depending on a Node global the plugin context may not expose.

## 0.3.4

- Fixed the ask stream going to a half that no longer exists: after the host half
  is reloaded (every install), the page's stream still looked open and reached
  nothing, so a call waited and then reported "no tab answered". The heartbeat
  reply now names the half serving it, and a page that hears a new name reopens
  its stream — no page reload needed after an install.

## 0.3.3

- The tab body gets its workspace under a name React keeps: `key` is reserved by
  React and never reaches a component, which is why the first tab to open failed
  with `options.key is not a function`.
- A chat and its tab do not always share an id, so the page now reports the tab
  it opened and the host routes that chat to it. Two open tabs no longer rely on
  "the only seat".

## 0.3.2

- Fixed the reason a call never opened its tab: the page half read
  `ctx.sidebarRight` without asking for the service, so it only ever saw
  `undefined` and the ask was dropped in silence. It now runs its listener on a
  scope injected with `layout` and `sidebarRight`, and reports `phase:"wired"`
  once that scope is live.

## 0.3.1

- The page opens the tab in its own chat first (`openTab`), and falls back to the
  chat id (`openTabIn`) only when that refuses — the id path alone could decline
  silently, which is what a call then reported as "no tab answered".
- Every step of that handshake now reports itself: `phase:"open"` says which path
  ran, and `guest-opening` / `guest-ready` / `guest-error` say whether the tab
  body leased a browser at all. `GET /state` shows the last one.

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
