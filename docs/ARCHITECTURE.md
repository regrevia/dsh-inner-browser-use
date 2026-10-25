# Architecture

Two halves, one wire.

```
Host (plugin index.js)                Client (client.js, in the page)
──────────────────────                ────────────────────────────────
tools.register(browser_*)             sidebar.right.pane.tab  → <webview>
        │                                       │
        │  bridge.call(chat, op, args)          │  executeJavaScript(RUNTIME)
        ▼                                       ▼
   POST /push ────── SSE ──────►  dispatch op, reply via POST /uplink
        ▲                                       │
        └────────── /uplink ◄───────────────────┘
```

## Why the Host needs a wire at all

The sidebar browser is a Client object. The `<webview>` is created in the product
document, leased from the Desktop main process, and it only exists while the tab
is mounted. A tool, however, executes on the Host. Nothing in the Host can reach
a DOM element that lives in another process, so the two halves talk.

## The transport

The Client `fetch`es relative URLs under `/dsh-inner-browser-use/`; the Host
registers that prefix on its web server.

Same-origin is the whole trick, and it holds on both builds:

- **Web build:** the page already sits on the Host origin.
- **Desktop build:** the product document is `dsh-app://app`. Its protocol
  handler forwards every path it does not serve itself to the Host, with the
  Host cookie attached. A relative `fetch` therefore lands on these routes with
  no CORS preflight, no port number, and no token for the Client to learn.

| Route | Direction | Purpose |
| --- | --- | --- |
| `GET /downlink?session=` | Host → tab | Server-sent events, one long-lived response per open tab. |
| `POST /uplink?session=` | tab → Host | Replies and lifecycle frames. |
| `POST /push?session=` | Host → tab | Diagnostic push without a waiting call. Not used by tools. |
| `GET /watch` | Host → page | Server-sent events, one long-lived response per page (not per tab): the channel the page uses to learn that some chat needs a tab. |
| `GET /state` | either | Which chats have a tab, how many calls are in flight, last client heartbeat. |

## Surviving a reload of the other half

Each host half names itself (`epoch`) in every heartbeat reply. A page whose ask
stream predates that name still holds an open socket to the old half, which can
never open a tab. The next heartbeat (≤20 s) answers with a new name, and the page
reopens the stream. Installing, or reloading the host, therefore needs no page
reload.

## Routing a chat to its tab

The tool layer names a chat by its agent id; the tab the page opens may carry a
different session id. Right after an ask, the page reports which tab it opened
(`phase:"open"`, `opened:"current"`), and the host records that pair for the next
30 s. Later calls resolve chat → tab through the pair, so two open tabs stay
apart instead of both falling back to the single-seat rule.

## Opening the tab on demand

A tool cannot ask a user to click `+`, so the call carries the ask: when no seat
exists, the Host pushes `wanted` down `/watch`, the page opens this chat's tab
through `ctx.sidebarRight.openTabIn(sessionId, "inner-browser-use")`, and the
call waits up to `openWaitMs` (8 s) for the seat to appear before it fails.

`/watch` is per page rather than per tab on purpose: a page with no tab open has
no `/downlink` stream, and it is exactly that page which must be able to obey.

## Seats

One open tab is one seat, keyed by the chat id. A tool resolves its seat by the
agent id that called it and falls back to the only seat when exactly one tab is
open — that fallback is what lets a chat drive a tab another chat opened, which
is occasionally what you want while debugging.

A seat that disappears mid-call rejects the waiter; it does not hang until the
timeout. A seat that goes silent does hang until the timeout, which is
deliberate: a page can be slow, and the model should see "did not finish" rather
than a misleading success.

## Frames

```jsonc
// Host → tab
{ "type": "call", "id": "<random>", "tool": "click", "args": { "ref": 4 } }
// tab → Host
{ "type": "reply", "id": "<same>", "ok": true, "value": { "text": "…" } }
{ "type": "reply", "id": "<same>", "ok": false, "error": "no control 4 on this page" }
{ "type": "wanted", "session": "<chat id>" }
{ "type": "client-alive", "phase": "registered", "tabType": true }
```

Frames are JSON, not binary, and they carry text, not screenshots. A page
observation is a few kilobytes of text; a screenshot would be megabytes over the
same socket, and it is not what the model needs to decide where to click.

## The guest runtime

`client.js` keeps the whole in-page side as one string, evaluated per call:

```js
el.executeJavaScript(`(async function(){ ${RUNTIME}; return await run(${op}, ${args}) })()`)
```

Rewriting it on every call costs a few milliseconds and buys immunity from the
one failure that would otherwise break everything: the page navigating and
taking an earlier injection with it. Nothing persists in the guest except what
the call itself creates.

`view` numbers every control it can see (`a`, `button`, `input`, `select`,
`textarea`, `[role=…]`, `[onclick]`, `[tabindex]`) in document order, trimming
invisible and zero-sized nodes, and returns the first 2400 characters of visible
text. The numbers are only valid for the page the model last read, which is why
every mutating tool returns a fresh `view` afterwards.

`click` and `type` scroll the target into view, move the pointer there, ripple,
and dispatch real `MouseEvent`s (full `pointerdown/mousedown/mouseup/click`
sequence) so frameworks that listen on any of them react.

## The lease

The tab does not create its own browser. It asks the Desktop main process:

```js
const reservation = await dshDesktop.browser.acquire("cwd:/path/to/workspace")
webview.name = reservation.lease
webview.partition = reservation.partition
webview.src = `about:blank#${reservation.lease}`
```

All three attributes matter. The main process cancels `will-attach-webview` when
the `src` hash does not match the lease it issued, so a webview configured
loosely never attaches — it silently shows nothing. The partition is
`dsh-sidebar-browser-<uuid>`, in memory, scoped to the workspace key: `cwd:<path>`
for a chat in a workspace, `session:<id>` for an ungrouped one. Same key, same
cookies as the built-in browser tab.

Because that partition is in memory, the page half reads the guest's cookies over
the debugger and files them under `~/.dsh/inner-browser-use/cookies/<hash>.json`,
mode 0600, keyed by the same workspace key; the next guest for that workspace gets
them back before its first page loads. Nothing but a name, a value, and where the
cookie belongs is kept, and the file is local to this machine.

## Failure modes, by design

- **No tab:** the call asks for one, waits, and fails with one sentence if none opens.
- **No Desktop:** the body renders "Desktop app only"; nothing else registers.
- **Page refuses:** the error string reaches the model as a tool error.
- **Plugin stops:** every seat closes, every waiter rejects.
