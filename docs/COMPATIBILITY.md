# Compatibility

What this plugin assumes, and what it degrades to when an assumption fails.

## Requirements

| Capability | Needed for | Missing means |
| --- | --- | --- |
| Desktop app (`dshDesktop.browser`) | Leasing the app's own browser tab | The call answers that the built-in browser is not available; tools stay registered. |
| `sidebar.right.pane.tab` slot | The tab body | Nothing registers; no tab appears in the **+** menu. |
| `ctx.sidebarRightTabs` | Tab type registration | Registration is skipped silently; the tab never appears. |
| `ctx.sidebarRight.openTabIn` | Placing a tab in the column | Tools need the tab opened by hand; the call says so in one sentence. |
| `ctx.webServer.register` | The whole wire | Plugin fails to load, visibly. |
| `ctx.tools.register` | The tool surface | Bridge still runs; the model sees no `browser_*` tools. |
| `EventSource` in the page | Learning that a tab is wanted | Same as the row above. |

## What it never touches

Installing this plugin changes nothing a user already had:

- Nothing shipped is wrapped or shadowed: the browser tab, its kind, its tools'
  behaviour and its partition are the product's; this plugin only drives them.
- No guide card: the `开始` pane renders exactly the entries it had before. A
  client test asserts the registered tab type carries no `guide` array.
- No global CSS: every rule is scoped to the page it drives.
- No slot occupant on any slot it does not own, and no `computerUse`/`browserUse`
  provider registration, so the shipped browser's own providers keep their seats.
- Removing the bundle removes every one of the above.

## Version notes

- **Node 20+** on the Host. The plugin uses only `node:http`, `node:fs/promises`,
  `URL`, and `AbortSignal`.
- **No dependencies.** No bundler, no build step, no post-install script.
- `engines.dsh` is `>= 0.2.0`. Checked against Desktop builds whose sidebar
  browser tab kind is `browser` and whose guest handshake is an `about:blank#`
  webview carrying the workspace partition; on any other shape the plugin treats
  the Desktop bridge as absent rather than guessing.

## Coexistence

- The tab kind is `browser` — the built-in browser's own. This plugin registers no
  tab kind of its own.
- The route prefix is `/dsh-inner-browser-use`. Nothing is mounted under `/api`.
- The guest partition is the one the app leases for the workspace
  (`dsh-sidebar-browser-<uuid>`). Two plugins leasing the same workspace key share
  storage, exactly as two built-in tabs do.

## Known limits

| Limit | Why | Workaround |
| --- | --- | --- |
| A login is kept only if the page can read its cookie | `HttpOnly` cookies are not visible to the page half | Sites that keep the session in a readable cookie come back signed in |
| One storage partition per workspace | The lease key is the workspace CWD | Use one workspace per account you need isolated |
| One chat is on screen at a time | The column shows one chat, so another chat's page does not exist | Open the chat that asks; the call answers in about a second |
| Text-only observations | Frames are JSON over one SSE socket | Use `browser_script` to pull exact values |
| A capture needs that page drawn | The app has no surface to read for a page another tab covers | Bring the chat's tab forward; the call says so |

## Downloads land in the chat folder

The app cancels its own downloads, so a page cannot save a file by itself. The
page half therefore collects what a page offers — an `<a download>`, a `blob:`
address, a `data:` address, or a link whose path ends in an archive, office
document, PDF, text, image or media extension — and hands the bytes to the Host,
which writes them under `<chat folder>/.dsh-inner-browser-use/downloads/`. The
call returns that path, and `browser_download` with no argument prints the files
already collected.

Limits that come from the page, not from the plugin:

- One offered file is capped at 7 MB and twelve are tracked per page load; the
  Host refuses an upload over 8 MB with the size named.
- A page whose `connect-src` forbids the site's own address cannot fetch it; the
  plugin then has only what the page already holds, so ask the page for the file
  through its own UI.
- A file streams only while the page keeps answering. A page that navigates away
  mid-save ends the transfer, and the call says so instead of writing half a file.

## Checking an install

Run these in the chat whose tab is open, in this order. Each line is what a
working install answers.

1. `browser_navigate` to `https://example.com/` → title `Example Domain`, one control.
2. `browser_view` → the same page, so the tab is the one this chat owns.
3. `browser_script` adding a button, then `browser_click` it → `Clicked #2 [button] clicked at 120,160`.
4. `browser_screenshot` → a path under `.dsh-inner-browser-use/`, or the sentence
   naming the tab to bring forward.
5. Restart the app once if `browser_selection` answers `unknown tool`: the tool
   list is read at start.

## A tab that is not the active one

The strip mounts only the tab it shows, and after a restart the restored tab is
not the active one. Nothing in the tab face switches it: `openTabIn` with
`activate`/`focus`, `focus(id)`, `focus(session, id)`, `active(id)`,
`tab.activate` and `tab.focus` were each tried and left the active tab
unchanged; the tab bar's controls are not inside `sidebarRight.host`, so there is
no element to click.

A call therefore never depends on that switch. On load, the chat on screen gets
its own tab back and the page it had; every other chat opens nothing, because a
tab lands in the column that is showing.
