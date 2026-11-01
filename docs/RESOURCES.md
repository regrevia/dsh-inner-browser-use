# Long-term resources: what keeps a browser cheap when nobody is looking

A sidecar is only worth keeping if leaving it open overnight costs nothing. This
document describes the ladder a browser steps down when it goes unused, how the
timings are chosen, and how the same problem is solved by the four projects a
person is most likely to compare this plugin to.

## The ladder

| step | when | what happens | cost while parked |
| --- | --- | --- | --- |
| `awake` | calls are arriving, or someone is watching the mirror | nothing | one headless Chrome |
| `quiet` | no call for a while, but a pane still shows the page | screencast stopped, page frozen (`Page.setWebLifecycleState`) | JS/timers paused, DOM and cookies kept, still one process tree |
| `rest` | no call for a while and no pane watching | cookies saved, `Browser.close`, whole tree gone | zero |

The rest step is what the pane closing at `x` earns: the plugin tells the
sidecar the mirror is gone, and if nobody else is watching it arms a one-minute
rest. A chat that never closed its pane still gets the quiet step, which is
reversible and keeps the page exactly where the person left it.

## Choosing the timings without guessing

Fixed timeouts are wrong in both directions: too short and every pause pays a
cold start, too long and an abandoned browser outlives the work. The rest and
quiet windows are therefore derived from what the user actually did in this
process. `rest.js` keeps the last 64 gaps between calls, takes the 95th
percentile, and multiplies it:

```text
rest  = clamp(p95(gaps) × 6,  90 s, 15 min)
quiet = clamp(p95(gaps) × 2,  20 s,  2 min)
```

A person clicking every two seconds gets a two-minute rest; one coming back
every ninety seconds gets nine minutes. Gaps longer than the maximum rest are
treated as a new session, not as evidence. With no history at all the floors
apply, so a fresh process parks quickly instead of waiting for a pattern that
does not exist yet.

The decision itself is a pure function of four numbers — now, last use, the
rest deadline, and how many mirrors are watching — which is what makes it
testable without a browser (`test/rest.test.mjs`). The watched count wins over
the deadline: a pane on screen always means `quiet` at most, never `rest`.

## Memory pressure

Timings are the first line; memory is the second. Every 30 s the sidecar weighs
the whole process tree and compares it with a budget (2400 MB by default,
`DSH_INNER_BROWSER_MEMORY_MB`). Over budget while a pane is open, it stops
screencasts and reclaims unused tabs (LRU, pinned pages excluded). Over budget
again with nobody watching, it puts the browser away on the spot rather than
waiting for the clock. Being over once is not enough to close a browser the
person is looking at.

## What breaks a long run, and what is done about it

| failure | response |
| --- | --- |
| a rest and the next call arrive together | `shutdown()` is single-flight and `launch()` awaits the outgoing browser, so a fresh socket is never closed by the one leaving |
| the browser dies three times in ten minutes | the crash-loop guard refuses to start it again and says why, instead of spinning |
| a tab is left in a chat that stopped using it | 10-minute LRU, skipped while it streams or holds a popup |
| the last call was minutes ago but the pane is open | freeze, not close: scroll position, DOM and sign-ins are still there on wake |

## Neighbours

Compared with the projects this one is usually put next to (`--idle-timeout`,
`keep_alive`, and their documentation):

| project | idle handling | what a wake costs | notes |
| --- | --- | --- | --- |
| Playwright MCP | one flag, `--idle-timeout`, default one hour for headless, whole browser closed | a cold start | no viewer awareness; each client gets its own Chrome; `src/` is no longer in the repository |
| Chrome DevTools MCP | none — the browser lives until the process exits | n/a | one dispose chain, no idle clock, screencast never pauses for a detached viewer |
| browser-use | `keep_alive` flag, no timeout value | n/a | teardown skipped while `keep_alive`; no idle timer, no memory policy |
| Stagehand | none | n/a | deliberately disables Chrome's background throttling, then tears down and removes the profile |
| this plugin | viewer-aware ladder, timings learned from use, memory pressure, single-flight close | 0.3–1.1 s, same page and address | freeze keeps the DOM; rest keeps the cookies; nothing cold-starts unless the process is new |

The gaps that remain in the field, and that this document treats as the design
brief: nobody freezes a page instead of closing it; nobody pauses a screencast
because the viewer looked away; cold restart is the documented recovery
everywhere; tab caps and LRU are left to the caller; memory is a diagnostic
rather than a policy; multi-agent isolation is all-or-nothing. Those are the
five places where this plugin is deliberately ahead rather than equal — see
`docs/ARCHITECTURE.md` and `docs/BENCH.md` for the measured side of it.
