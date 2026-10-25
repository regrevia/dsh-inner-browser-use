# dsh-inner-browser-use

**Lets an agent drive the built-in sidebar browser of DeepSeek Harness — the one already in the right panel, not a new window.**

The agent navigates, reads the page as numbered controls, clicks, types, and runs JavaScript. You watch it happen: a pointer moves to each target and ripples where it lands. Everything runs inside the `<webview>` the product already leases, with the same partition and the same cookies, so a page you signed into by hand is the page the agent works on.

> **On the name:** *inner* means the browser built into the Harness sidebar. This plugin opens no window of its own and never attaches to Chrome.

## What you get

| Tool | What it does |
| --- | --- |
| `browser_navigate` | Opens a URL in this chat's sidebar tab and returns the page. |
| `browser_view` | Returns the address, title, visible text, and every control as `#1 … #80`. |
| `browser_click` | Clicks one numbered control and returns the page it leads to. |
| `browser_type` | Types into one numbered field, optionally pressing Enter. |
| `browser_script` | Evaluates JavaScript and returns the last expression. |
| `browser_selection` | Returns the text currently selected in the page. |
| `browser_copy` | Copies the selection, or one control's text, to the clipboard. |
| `browser_screenshot` | Saves a PNG of the tab and returns its path. |
| `browser_upload` | Attaches a local file to a numbered file field. |

Every call is visible: the pointer travels to the control, a ring marks it, and the page scrolls the target into view first.

The first call opens the tab for you: the page half hears that a chat needs one and opens **内置浏览器** in the right sidebar. Nothing else in that sidebar changes — this plugin adds its own tab type and nothing to the guide pane.

## Install

```bash
git clone https://github.com/regrevia/dsh-inner-browser-use
```

Then in DeepSeek Harness: **Plugins → Install from folder**, and pick the clone. Or from a shell:

```bash
dsh plugin install /path/to/dsh-inner-browser-use
```

The plugin appears under **Plugins** as *内置浏览器*. It needs the Desktop app, because the sidebar browser is a Desktop capability.

## Use

1. Open the chat you want the agent to browse for.
2. In the right panel, press **+** and choose **内置浏览器**.
3. Ask the agent for something on a page: *"打开 example.com，告诉我标题"*.

The tab is per chat. If a chat has no tab, a tool call says so instead of guessing.

## Drag data both ways

- **Page → chat:** `browser_script` returns strings and `browser_screenshot` saves a PNG, so the agent can read what the page shows and quote it — or hand you the image path — in the conversation.
- **Chat → page:** `browser_type` puts text into a field; `browser_script` can set values the page cannot be typed into.
- **Selection → chat:** `browser_selection` reads what is selected and `browser_copy` copies it through the page's own
  clipboard, so the model can quote it or you can paste it. There is no drag handle yet: sending a page fragment
  into the conversation goes through those two tools.

## What it will not do

- **It does not create a second browser.** No new window, no Chrome profile, no CDP mirror.
- **It does not outlive a restart.** The guest partition lives in memory, so a page you signed into with a password needs the password again after the app restarts. Cookies survive a tab close and reopen within one session of the app.
- **Screenshots are viewport-sized.** A `<webview>` captures what is visible, not the whole scroll height; scroll first, then capture.
- **One partition per workspace.** Two chats in the same workspace share the browser's storage, exactly as two tabs of the built-in browser do.
- **No downloads, popups, or permission prompts.** The guest runs sandboxed. To get bytes out of a page (an image, a file), read them in-page with `browser_script`.
- **It needs the tab open.** Tools fail with a one-line instruction rather than opening the tab for you.
- **A capture of a chat you are not looking at.** Reading, clicking and typing work while you are looking at
  another chat, because they drive the page itself. Pixels come from a surface the app is drawing, and a view
  behind another tab of the same pane is not drawn: the capture tries to bring this chat's tab forward, and if the
  page still has no surface it says so in a couple of seconds instead of waiting. Read what you need from the page
  instead — `browser_script` returns the same content.

## Compatibility

| | |
| --- | --- |
| Harness | Desktop app, sidebar browser present |
| Tab kind | `inner-browser-use` — never shadows the built-in `browser` kind |
| Host | Node 20+ |
| License | MIT |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the wire and [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for version limits.

## Develop

```bash
node --test test/*.test.mjs
```

The host half is plain ESM with no dependencies; the client half is a dynamic client module with no build step. Both are loaded by the app as-is.

## License

MIT © regrevia
