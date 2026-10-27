# Architecture

Two halves in two processes, and a Chrome that neither of them is.

```
server side  (index.js, in the DSH process)
  sidecar_* tools ──> Sidecar ── CDP over a socket ──> headless Chrome
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
| `--window-size=1440,900`, `--lang=zh-CN` | The viewport the pane mirrors, and a Chinese page locale. |

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
first tool call, and `sidecar_state` reports a stopped browser without starting one.

Shutdown asks Chrome to close (`Browser.close`), waits briefly, then sends `SIGTERM`, which is
the point where Chrome flushes cookies. An idle timer closes the browser after 15 minutes; a
tool call resets the clock, and a watching column defers the close when the timer fires, so a
page someone is reading outlives the idle window.

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
at 1440×900, `optimizeForSpeed`, `everyNthFrame: 1`, and acknowledges every frame it receives
so Chrome keeps sending. Frames are never queued: with two frames in flight, further frames
are dropped and the next one that fits takes their place. A slow reader loses frames, never
freshness.

The viewport is pinned with `Emulation.setDeviceMetricsOverride` to the same 1440×900, so a
frame is the whole page as laid out, not a crop.

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

`sidecarTools()` in `tools.js` builds the 23 definitions and `index.js` registers them on the
plugin's tool scope. All of them return one text block. A page read numbers the controls and
keeps those numbers across later reads, so `sidecar_click` by ref means the element the model
last saw; navigation drops them and the model gets `REF_GONE` rather than a wrong click.

An action answers with one line — address, title, focused field — and reads the page only when
`read: true` is passed. That is what keeps a long batch cheap (see `BENCH.md`).

Calls that touch the browser are marked not concurrency-safe; reading state, console and failed
requests is. `sidecar_open`, `sidecar_view`, `sidecar_wait` and `sidecar_shot` carry longer
timeouts than the rest.

Sign-in state lives in the profile, and session cookies — the kind a sign-in usually sets,
which Chrome would otherwise drop on exit — are saved next to it and restored on the next
launch, so a restart of the app does not sign the person out.

A system-prompt section (`browser-in-this-chat`) tells the model to reach for these tools
without asking first when someone wants something done on a site.

## Files

| File | Half |
| --- | --- |
| `index.js` | Server: routes, tools, CDP page reads, system prompt. |
| `sidecar.js` | Server: Chrome launch, attach, screencast, input, shutdown. |
| `client.js` | Page: the column, its stream, the arrow, the address row. |
| `locale/*.json` | Page: pane labels. |

Data on disk is confined to `~/.dsh/inner-browser-use/`: `chrome/<profile>` for the browser,
`screenshots/` for `sidecar_shot`.
