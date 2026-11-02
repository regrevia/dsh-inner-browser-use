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

## Where a cold start goes

A cold start is one Chrome launch, and until 0.47.1 it was a single opaque
number. `DSH_INNER_BROWSER_TRACE=1` now prints one stderr line per launch with the
cumulative time at each phase, so the cost can be attributed instead of guessed:

```
sidecar-start: 997 ms · closing 0 · login 1 · browser 608 · socket 799 · cdp 821
  · page 866 · cookies 866 · cast 869 · navigate 996
```

| phase | what it covers | what was changed in 0.47.1 |
| --- | --- | --- |
| `closing` | waiting for an outgoing `Browser.close` | nothing: single-flight, and the wait is only there when a rest and a call collide |
| `login` | pointing the profile at the saved sign-ins | nothing |
| `browser` | spawning Chrome and reading `DevToolsActivePort` | discovery now starts at 5 ms and backs off to 100 ms, instead of sleeping a flat interval first |
| `socket` | finding a `page` target on the debugging port | the `/json/list` poll starts at 10 ms and grows by 15 ms per try, capped at 100 ms |
| `cdp` / `page` / `cookies` / `cast` | handshake, page domain, saved cookies, screencast prep | nothing; these are tens of milliseconds together |
| `navigate` | the first URL actually loading | nothing: this is the site |

Two consequences worth knowing before reading the phases as a scoreboard: the
answer is wall clock on a warm machine, and `closing` alone ranges from 0 to
371 ms depending on whether a rest was in flight, so compare one phase against
itself across runs rather than comparing totals. The phase table with before and
after numbers is in `docs/BENCH.md` (the "冷启动拆解" section).

The other 1.1 s that used to sit in front of the first page was not a phase at
all: `browser_open` waited up to 1200 ms to find out whether a pane was going to
show the page. Nothing that long is worth a look at a picture that either arrives
on its own or never will, so the wait is now 250 ms and is skipped entirely when
the host has no pane to offer.

## Neighbours

Compared with the projects this one is usually put next to (`--idle-timeout`,
`keep_alive`, and their documentation). The numbers come from the same harness
on the same machine; the raw record is
`docs/measure-competitors-2026-11.json` and the method is in `docs/BENCH.md`.

| project | idle handling | idle CPU / RSS | what a wake costs | notes |
| --- | --- | --- | --- | --- |
| Playwright MCP 0.0.84 | `--idle-timeout`, default one hour for headless, whole browser closed | 38.1% / 1414 MB | cold start, 5.1 s | does release, but never looks at whether anyone is watching and never parks a page first; each client gets its own Chrome |
| Chrome DevTools MCP 1.12.0 | none — the browser lives until the process exits | 36.3% / 1280 MB | n/a | one dispose chain, no idle clock, screencast never pauses for a detached viewer |
| browser-use | `keep_alive` flag, no timeout value | not measured | n/a | teardown skipped while `keep_alive`; no idle timer, no memory policy |
| Stagehand | none | not measured | n/a | deliberately disables Chrome's background throttling, then tears down and removes the profile |
| this plugin 0.47.4 | viewer-aware ladder, timings learned from use, memory pressure, single-flight close | 0.9% idle (0.24% settled) with six tabs / 864–922 MB; 0.03–0.32% / 551 MB with one | 0.39–0.44 s, same page and address; 41–45 ms to open a tab on a warm browser | freeze keeps the DOM; rest keeps the cookies; six tabs share four renderers and add ~2 MB each; nothing cold-starts unless the process is new |

Playwright MCP's idle timeout was measured working (`--idle-timeout=6000` left no
Chrome after 14 s idle while the MCP process stayed up), so "we are the only one
that releases" would be false. What differs is the shape of the ladder: it is
one timer and one action, while this plugin never closes a page someone is
watching, freezes before it closes, and derives both windows from how often the
person actually calls.

The gaps that remain in the field, and that this document treats as the design
brief: nobody freezes a page instead of closing it; nobody pauses a screencast
because the viewer looked away; cold restart is the documented recovery
everywhere; tab caps and LRU are left to the caller; memory is a diagnostic
rather than a policy; multi-agent isolation is all-or-nothing. Those are the
five places where this plugin is deliberately ahead rather than equal — see
`docs/ARCHITECTURE.md` and `docs/BENCH.md` for the measured side of it.
