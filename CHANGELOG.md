# Changelog

## 0.1.0

First release.

- Host bridge over same-origin HTTP: `GET /downlink` (SSE), `POST /uplink`, `POST /push`, `GET /state`.
- Five tools: `browser_navigate`, `browser_view`, `browser_click`, `browser_type`, `browser_script`.
- Client tab kind `inner-browser-use` on the `sidebar.right.pane.tab` slot, leasing a `<webview>` from the Desktop main process with the workspace's own partition.
- In-page runtime: numbered controls, real pointer and ripple, scroll-into-view, genuine mouse and keyboard events.
- Per-chat seats with a single-tab fallback; a closed tab rejects waiters, a silent one times out.
- Client heartbeat on the state route, so install problems are diagnosable without a debugger.
- 10 host tests, no dependencies, no build step.
