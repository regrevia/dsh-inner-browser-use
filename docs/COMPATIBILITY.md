# Compatibility

What this plugin assumes, and what it degrades to when an assumption fails.

## Requirements

| Capability | Needed for | Missing means |
| --- | --- | --- |
| Desktop app (`dshDesktop.browser`) | The leased `<webview>` | Tab body shows "Desktop app only"; tools stay registered but have no seat. |
| `sidebar.right.pane.tab` slot | The tab itself | Nothing registers; no tab appears in the **+** menu. |
| `ctx.sidebarRightTabs` | Tab type registration | Registration is skipped silently; the tab never appears. |
| `ctx.webServer.register` | The whole wire | Plugin fails to load, visibly. |
| `ctx.tools.register` | The tool surface | Bridge still runs; the model sees no `browser_*` tools. |
| `ctx.sidebarRight.openTabIn` | Opening a tab on demand | Tools need the tab opened by hand; the call fails with one sentence. |
| `EventSource` in the page | Learning that a tab is wanted | Same as above. |

## What it never touches

Installing this plugin changes nothing a user already had:

- No shipped tab type is replaced or wrapped: it owns `inner-browser-use` only.
- No guide card: the `开始` pane renders exactly the entries it had before. A
  client test asserts the registered tab type carries no `guide` array.
- No global CSS: every rule is scoped under the pane's own class.
- No slot occupant on any slot it does not own, and no `computerUse`/`browserUse`
  provider registration, so the shipped browser's own providers keep their seats.
- Removing the bundle removes every one of the above; nothing is left behind
  except the tab-local partition the product itself owns.

## Version notes

- **Node 20+** on the Host. The plugin uses only `node:http`, `node:fs/promises`, `URL`, and `AbortSignal`.
- **No dependencies.** No bundler, no build step, no post-install script.
- Tested to 0.6.10 against DeepSeek Harness Desktop builds whose sidebar browser tab kind is `browser` and whose guest protocol exposes `acquire`/`release`. If `dshDesktop.protocolVersion` is not `1`, the plugin treats the Desktop bridge as absent rather than guessing.

## Coexistence

- The tab kind is `inner-browser-use`. The built-in `browser` kind is never registered, wrapped, or shadowed.
- The route prefix is `/dsh-inner-browser-use`. Nothing is mounted under `/api`.
- The guest partition is the workspace's own `dsh-sidebar-browser-<uuid>`. Two plugins leasing the same workspace key share storage, exactly as two built-in tabs do.

## Known limits

| Limit | Why | Workaround |
| --- | --- | --- |
| Login does not survive an app restart | The guest partition is in memory | Sign in again after restarting the app |
| One storage partition per workspace | The lease key is the workspace CWD | Use one workspace per account you need isolated |
| No downloads, popups, permission prompts | The guest attaches sandboxed | Read bytes in-page with `browser_script` |
| Tools need the tab open | A tool cannot mount UI on your behalf | Open **内置浏览器** once per chat |
| Text-only observations | Frames are JSON over one SSE socket | Use `browser_script` to pull exact values |
| A capture needs that chat's page drawn | The app has no surface to read for a page another tab covers | Bring the chat's tab forward; the call says so in about two seconds |

## Unverified on this machine

- Seeing the pointer overlay and the ripple in a picture: the placement is measured
  from the page (`transform`, `opacity 1`, the top `z-index`), and the click reply
  names the point, but no capture of a page the app is drawing has been taken
  since the pointer stayed for eight seconds.
- The built-in browser's own tab continuing to work while this plugin's tab is also open (they share a partition by design, but the two kinds have never been opened side by side here).
- `browser_selection` and `browser_copy` in the app: the half that carries them
  loads on the next start of the app. Their bridge is covered by
  `test/host.test.mjs`.

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
`activate`/`focus`, `focus(id)`, `focus(session, id)`, `active(id)`, `placeTab`
(throws `no tab type is registered`), `place` (throws), `tab.activate` and
`tab.focus` were each tried and left the active tab unchanged; the tab bar's
controls are not inside `sidebarRight.host`, so there is no element to click.

A call therefore does not depend on that switch. With no pane mounted, the page
half mounts a guest of its own in a container held off screen and answers there;
when a pane for the same chat reports ready, that guest is dropped so one page
serves the chat at a time. The proof log names both halves: `resident-opening`,
`resident-ready`, then `resident-closed` and `resident-drop` once a pane took
over.
