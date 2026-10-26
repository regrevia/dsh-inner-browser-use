# Compatibility

What this plugin assumes, and what it does when an assumption fails.

| | |
| --- | --- |
| Harness | 0.2.0 or newer, with the right column |
| Runtime | Node 20 or newer |
| Browser | Google Chrome, Chromium or Canary, 112 or newer |
| System | macOS 12 or newer; Linux x86_64 or arm64 |
| License | MIT |

## Where Chrome is looked for

The plugin starts a browser it finds at one of these paths, in this order:

```
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
/Applications/Chromium.app/Contents/MacOS/Chromium
/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary
/usr/bin/google-chrome
/usr/bin/chromium
```

That is the whole list. A Chromium kept elsewhere (snap, flatpak, a home directory, a bundled
runtime) is not found, and there is no setting to point at one. Installing Chrome the ordinary
way, or placing the binary at `/usr/bin/chromium`, is the supported arrangement.

If nothing in the list exists, the first tool call returns `sidecar: no Chrome found on this
machine` and nothing is written to disk.

Chrome 112 is the floor: the mirror needs `--headless=new` and a screencast that survives an
idle page.

## macOS

The browser is launched with `--use-mock-keychain` and `--password-store=basic`, so no keychain
dialog appears on the person's screen and no password is read from the OS keyring. Chrome's own
password store inside the profile still works.

The profile directory is created under the home directory of whoever runs DSH, which is the
same user the browser runs as. Running that process as a different user leaves the profile
unwritable, and running it as root leaves Chrome unable to start its sandbox: run DSH as the
person using it.

## Linux

The two Linux entries above are the same lookup list; put Chrome or Chromium there. The browser
runs without a display, so no X or Wayland session is needed for the mirror itself.

Linux has not been part of the release test pass; macOS is where this plugin is developed and
checked.

## Windows

Not supported. There is no Windows path in the lookup list, and no installation of this plugin
on Windows has been checked.

## When an assumption fails

| Assumption | What happens |
| --- | --- |
| No Chrome at a listed path | First tool call returns the error above; no profile, no process. |
| Harness older than 0.2.0 | The plugin does not load. |
| A Harness build with no right column | The tools still drive the browser; there is nowhere to show the mirror. |
| A site that refuses headless | The user agent is replaced with an ordinary desktop Chrome string; a site that insists on a window can be opened with `headless: false`. |
| A page wider than 1440×900 | The viewport is fixed, so the page lays out for 1440 wide; nothing is scaled. |
| Two plugin instances, one profile | The second adopts the Chrome already running on that profile rather than starting another. |
| The debugging file left by a crashed Chrome | It is removed and the browser is started again. |

## Limits by design

One page per browser, fixed 1440×900 viewport, no mobile emulation, no downloads, no uploads, no
script evaluation. The eight tools in the README are the whole surface.
