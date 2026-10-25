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

## Version notes

- **Node 20+** on the Host. The plugin uses only `node:http`, `node:fs/promises`, `URL`, and `AbortSignal`.
- **No dependencies.** No bundler, no build step, no post-install script.
- Tested against DeepSeek Harness Desktop builds whose sidebar browser tab kind is `browser` and whose guest protocol exposes `acquire`/`release`. If `dshDesktop.protocolVersion` is not `1`, the plugin treats the Desktop bridge as absent rather than guessing.

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

## Unverified on this machine

- Visual confirmation of the pointer overlay, the ripple, and the tab body in a live window.
- The built-in browser's own tab continuing to work while this plugin's tab is also open (they share a partition by design, but the two kinds have never been opened side by side here).
