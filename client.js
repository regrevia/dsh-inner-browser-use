/**
 * dsh-inner-browser-use — the client half.
 *
 * It adds one tab: a picture of a headless Chrome, mirrored into the column.
 * A click, wheel or key on that picture is forwarded to that browser as real
 * input, and the black arrow shows where the agent last acted.
 */

var BRIDGE_ROUTE = '/dsh-inner-browser-use'

window.__ModuleLoader__.load({
  id: 'dsh-inner-browser-use',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'inner-browser-use'
    /* The sidecar's tab is a picture of another Chrome, not a guest of this app:
       it is named apart from the product's own browser so the two never swap. */
    const SIDE_ID = 'dsh-inner-browser-use:sidecar'
    const SIDE_KIND = 'inner-browser-sidecar'
    const SIDE_VIEW = { width: 1440, height: 900 }
    /* The black arrow, inline so the pane needs no image of its own. */
    const SIDE_POINTER = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 2.5 20.5 11l-7.2 1.6L9.8 21z" fill="#111" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>')
    const ROUTE = BRIDGE_ROUTE
    const STYLE_ID = 'dsh-inner-browser-use-css'
    /** Set by the sidecar tab while it is registered: opens the mirror in the chat that asked. */
    let sidecarOpener = null
    const SLOT = 'sidebar.right.pane.tab'
    const TITLE_SLOT = 'sidebar.right.pane.tab.title'

    const DICT = {
      zh: {
        'side.label': '后台浏览器',
        'side.empty': '后台的独立 Chrome 还没有页面，在上方地址栏输入网址',
        'side.restore': '恢复上次的页面',
        'side.connecting': '正在连接…',
        'side.failed': '画面没有连上',
        'side.foreign': '这个浏览器属于发起它的会话，回到那个会话继续。',
        'side.back': '后退',
        'side.forward': '前进',
        'side.reload': '刷新',
        'side.address': '输入地址',
        'side.type': '输入文字',
      },
      en: {
        'side.label': 'Background browser',
        'side.empty': 'The background Chrome has no page yet; type an address above',
        'side.restore': 'Reopen the last page',
        'side.connecting': 'Connecting…',
        'side.failed': 'The picture did not connect',
        'side.foreign': 'This browser belongs to the chat that opened it.',
        'side.back': 'Back',
        'side.forward': 'Forward',
        'side.reload': 'Reload',
        'side.address': 'Enter an address',
        'side.type': 'Type here',
      },
    }
    const LANG = /^zh/i.test(typeof navigator === 'undefined' ? '' : navigator.language ?? '') ? 'zh' : 'en'
    const L = (key) => DICT[LANG][key] ?? key

    const CSS = [
      /* The sidecar pane: a picture of another browser, with its own pointer. */
      '.dshib-side{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;height:100%;background:var(--dsw-alias-bg-base)}',
      '.dshib-side-bar{flex:none;display:flex;align-items:center;gap:4px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-subtle)}',
      '.dshib-side-key{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer}',
      '.dshib-side-key:hover{background:var(--dsw-alias-bg-subtle);color:var(--dsw-alias-label-primary)}',
      '.dshib-side-url{flex:1 1 auto;min-width:0;border:1px solid transparent;border-radius:6px;background:var(--dsw-alias-bg-subtle);padding:4px 8px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);outline:none}',
      '.dshib-side-url:focus{border-color:var(--dsw-alias-border-strong);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}',
      '.dshib-side-wins{flex:none;display:flex;gap:4px;padding:4px 6px;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-separator)}',
      '.dshib-side-win{flex:0 1 auto;min-width:0;max-width:180px;display:inline-flex;align-items:center;gap:4px;border:0;border-radius:6px;padding:2px 8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer}',
      '.dshib-side-win[data-on="1"]{background:var(--dsw-alias-bg-subtle);color:var(--dsw-alias-label-primary)}',
      '.dshib-side-win > span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshib-side-stage{flex:1 1 auto;position:relative;min-width:0;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--dsw-alias-bg-base);outline:none;cursor:default}',
      '.dshib-side-frame{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none;cursor:default}',
      '.dshib-side-ime{position:absolute;width:1px;height:1px;padding:0;margin:0;border:0;resize:none;overflow:hidden;opacity:0;pointer-events:none}',
      /* The black arrow is the agent's pointer, not the person's cursor: both are
         on screen at once, and moving the mouse never takes the arrow over. */
      '.dshib-side-ptr{position:absolute;width:20px;height:20px;pointer-events:none;z-index:2;transform:translate(-2px,-2px);transition:left 60ms linear,top 60ms linear;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}',
      '.dshib-side-note{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:0 16px;text-align:center}',
      '.dshib-side-back{border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:6px 12px;cursor:pointer}',
      '.dshib-side-back:hover{background:var(--dsw-alias-bg-subtle)}',
    ].join('')

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.locale.register(NS, { zh: DICT.zh, 'zh-CN': DICT.zh, en: DICT.en })
        } catch {
          /* one locale service or none */
        }
        ctx.effect(() => {
          /* A reload keeps one sheet, not one per lifetime: the same id is
             replaced instead of stacked. */
          document.getElementById?.(STYLE_ID)?.remove()
          const style = document.createElement('style')
          style.id = STYLE_ID
          /* A sheet is keyed by the plugin that brought it. */
          style.dataset.pluginCss = 'dsh-inner-browser-use'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-inner-browser-use: styles')

        /* The sidecar tab: the column shows it, the work happens in another process. */
        ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => scope.effect(() => {
          const tabs = scope.sidebarRightTabs
          const surface = scope.sidebarRight
          const disposers = []
          /* The one chat that owns the mirror. Every other chat loses the tab
             and gets no picture: the column is global, the browser is not. */
          let ownerSession = ''
          const mountedOf = () => {
            try {
              return String(surface?.mounted?.getSnapshot?.() ?? '')
            } catch {
              return ''
            }
          }
          /* The chat that asked for the pane, and the chats whose pane the
             person closed. A strip close and a layout restore do not both
             report themselves here, so the mark is kept on this side too: no
             automatic ask may redraw a column the person shut. */
          let openWho = ''
          let openAt = 0
          let paneSeen = false
          let missing = 0
          const closedAt = new Map()
          const hasPane = (sessionId) => {
            try {
              const rows = surface?.tabsIn?.(sessionId) ?? []
              return rows.some((row) => {
                const kind = String(row?.kind ?? row?.record?.kind ?? '')
                const id = String(row?.id ?? row?.record?.id ?? '')
                return kind === SIDE_KIND || id === SIDE_ID
              })
            } catch {
              return false
            }
          }
          const closeHere = (sessionId, byPerson = false) => {
            if (sessionId === '') return
            closedAt.set(sessionId, Date.now())
            if (openWho === sessionId) {
              openWho = ''
              openAt = 0
              paneSeen = false
              missing = 0
            }
            /* A note is sent only when the person is quitting the mirror, not when a
               chat switch closes this column: the switch's own ask claims the
               mirror a moment later, and a late note would take it away from the
               chat that just asked. */
            if (byPerson === true) {
              /* A close usually unmounts the pane in the same tick, which cancels
                 an ordinary request; a beacon is delivered after the page is gone,
                 so the note always arrives. */
              const url = `${ROUTE}/sidecar/forget?session=${encodeURIComponent(sessionId)}` // ui-copy-ignore
              try {
                const sent = typeof navigator?.sendBeacon === 'function' && navigator.sendBeacon(url) === true
                if (sent !== true) void fetch(url, { method: 'POST' })
              } catch {
                /* a page that cannot hear it keeps its note */
              }
            }
            let records = []
            try {
              records = surface?.tabsIn?.(sessionId) ?? []
            } catch {
              records = []
            }
            for (const record of records) {
              const kind = String(record?.kind ?? record?.record?.kind ?? '')
              const id = String(record?.id ?? record?.record?.id ?? '')
              if (kind !== SIDE_KIND && id !== SIDE_ID) continue
              /* The person's close arrives from the tab strip: the host is
                 already taking that tab down, and closing it again here races
                 the host and can leave the tab half closed. Forgetting the ask
                 is what this path owes. */
              if (byPerson) continue
              try {
                if (typeof record?.close === 'function') record.close()
                else if (typeof surface?.closeIn === 'function') surface.closeIn(sessionId, id)
              } catch {
                /* a tab already gone needs no closing */
              }
            }
          }
          const ask = (sessionId, reason = 'ask', at = 0) => {
            if (sessionId === '' || mountedOf() !== sessionId) return
            const shut = closedAt.get(sessionId)
            /* A slow beat that only wants the frames back must not put a closed
               column on screen again: it may refresh a pane that is drawn and
               nothing else. */
            if (reason === 'keepalive' && (shut !== undefined || !hasPane(sessionId))) return
            /* A real ask is only newer than the close that preceded it: a
               replayed one from before the person shut the pane stays spent. */
            if (shut !== undefined && (reason !== 'ask' || (at !== 0 && at <= shut))) return
            if (shut !== undefined) closedAt.delete(sessionId)
            if (ownerSession !== '' && ownerSession !== sessionId) closeHere(ownerSession)
            ownerSession = sessionId
            openWho = sessionId
            missing = 0
            paneSeen = hasPane(sessionId)
            if (paneSeen !== true) openAt = Date.now()
            try {
              if (typeof surface?.openTabIn === 'function') surface.openTabIn(sessionId, SIDE_KIND, {})
              else if (typeof surface?.openTab === 'function') surface.openTab(SIDE_KIND)
            } catch {
              /* a column that refuses keeps its own tabs */
            }
          }
          /* The pane this chat asked for can be taken down by paths that never
             call onClose. One that was drawn and is gone was closed by the
             person, and that is the answer this watcher waits for. */
          const watchPane = () => {
            if (openWho === '') return
            if (mountedOf() !== openWho) return
            if (hasPane(openWho)) {
              paneSeen = true
              missing = 0
              return
            }
            /* A pane the person never saw draw is still being built; only one
               that was on screen and then vanished is a close. */
            if (paneSeen !== true) return
            if (Date.now() - openAt < 2500) return
            missing += 1
            if (missing < 2) return
            closeHere(openWho, true)
          }
          /* The same rule on this side: a second mount of the same tab is a
             no-op, not a thrown error that takes the pane down. */
          const safely = (register) => {
            try {
              return register()
            } catch (error) {
              return () => {}
            }
          }
          disposers.push(safely(() => tabs.register({
            id: SIDE_ID, // ui-copy-ignore
            kind: SIDE_KIND, // ui-copy-ignore
            keepMounted: true,
            single: true,
            priority: 'extension',
            title: () => L('side.label'),
            /* The tab strip's close control is not the pane's own button: a
               tab closed there never sent the note, the ask stayed alive, and
               the keepalive put the mirror back a few seconds later — a tab
               the person closed that would not stay closed. Every close path
               ends here. */
            onClose: (_tab, where) => closeHere(String(where?.sessionId ?? mountedOf()), true),
          })))
          disposers.push(scope.slots.inject(SLOT, () => scope.slots.register({
            name: SLOT, // ui-copy-ignore
            key: SIDE_ID, // ui-copy-ignore
            inject: (sessionId) => ({ sessionId, dropMirror: () => closeHere(sessionId, true) }),
          }, SidecarBody)))
          disposers.push(scope.slots.inject(TITLE_SLOT, () => scope.slots.register({
            name: TITLE_SLOT, // ui-copy-ignore
            key: SIDE_ID, // ui-copy-ignore
            locale: NS, // ui-copy-ignore
          }, () => h('span', { className: 'dshib-title' }, L('side.label')))))
          /* The mirror comes only when this chat asked for it: the ask is pushed
             to this chat's page, and nothing opens by itself. // ui-copy-ignore */
          sidecarOpener = (sessionId, reason = 'ask', at = 0) => ask(sessionId, reason, at)
          /* The ask arrives on this chat's own downlink, so a frame for another
             chat never reaches this column. The stream follows the chat on
             screen: a switch closes the old one and opens the new one. */
          let askSource = null
          let askWho = ''
          const closeAsk = () => {
            if (askSource !== null) {
              try {
                askSource.close()
              } catch {
                /* a stream already gone needs no closing */
              }
            }
            askSource = null
            askWho = ''
          }
          const syncAsk = () => {
            const who = mountedOf()
            /* A stream the browser gave up on keeps its address here, so the
               next tick has to notice it is dead and open a fresh one, or this
               chat never hears an ask again. */
            if (who === askWho && askSource !== null && Number(askSource.readyState) !== 2) return
            closeAsk()
            if (who === '') return
            try {
              const source = new EventSource(`${ROUTE}/downlink?session=${encodeURIComponent(who)}`) // ui-copy-ignore
              source.addEventListener('message', (event) => {
                let frame
                try {
                  frame = JSON.parse(event.data)
                } catch {
                  return
                }
                if (frame?.type !== 'sidecar-wanted') return
                const asked = String(frame.session ?? '')
                if (asked !== '') sidecarOpener?.(asked, String(frame.reason ?? 'ask'), Number(frame.at ?? 0))
              })
              askSource = source
              askWho = who
            } catch {
              /* a page with no stream keeps its tab closed */
            }
          }
          const watchAsk = () => {
            try {
              if (typeof surface?.mounted?.subscribe === 'function') {
                const off = surface.mounted.subscribe(() => {
                  syncAsk()
                  restore()
                })
                if (typeof off === 'function') return off
              }
            } catch {
              /* a store that cannot be watched is polled instead */
            }
            return null
          }
          syncAsk()
          /* An app restart leaves the browser alive but no ask on the wire, so
             the column would come back empty in a chat that never closed it.
             This chat asking for the state of the browser it still owns is what
             puts the mirror back without anyone pressing anything. */
          const restoreTimers = []
          const restore = (tries = 0) => {
            const who = mountedOf()
            if (who === '') return
            const again = () => {
              if (tries >= 2) return
              restoreTimers.push(setTimeout(() => restore(tries + 1), 1500))
            }
            try {
              fetch(`${ROUTE}/sidecar/state?session=${encodeURIComponent(who)}`) // ui-copy-ignore
                .then((said) => (said.ok === true ? said.json() : null))
                .then((state) => {
                  if (state?.owner !== who) return
                  const live = state?.alive === true || state?.chat?.alive === true
                  if (live !== true) {
                    again()
                    return
                  }
                  ask(who, 'restore')
                })
                .catch(again)
            } catch {
              again()
            }
          }
          restore()
          /* A pane whose page the browser reclaimed is closed once, so coming
             back to the chat does not bring the empty column back. */
          const dropExpired = () => {
            const who = mountedOf()
            if (who === '' || hasPane(who) !== true) return
            void fetch(`${ROUTE}/sidecar/state?session=${encodeURIComponent(who)}`) // ui-copy-ignore
              .then((said) => (said.ok === true ? said.json() : null))
              .then((state) => {
                if (state?.chat?.expired !== true) return
                if (mountedOf() !== who) return
                closeHere(who, false)
              })
              .catch(() => {})
          }
          const offAsk = watchAsk()
          let beats = 0
          const pollAsk = setInterval(() => {
            syncAsk()
            watchPane()
            beats += 1
            if (beats % 5 === 1) dropExpired()
          }, 1000)
          const stopAsk = () => {
            clearInterval(pollAsk)
            for (const timer of restoreTimers) clearTimeout(timer)
            if (typeof offAsk === 'function') {
              try {
                offAsk()
              } catch {
                /* a gone store needs no release */
              }
            }
            closeAsk()
          }
          return () => {
            if (sidecarOpener !== null) sidecarOpener = null
            stopAsk()
            for (const dispose of disposers.reverse()) {
              try {
                dispose()
              } catch {
                /* a slot already gone needs no release */
              }
            }
          }
        }, 'dsh-inner-browser-use: sidecar tab'))
      },
    }

    /**
     * The sidecar's screen in the column.
     *
     * It is a picture of another Chrome: a click here is sent to that browser as
     * real mouse input, and the black arrow shows where the last one landed. The
     * page keeps working while this pane is not being watched.
     */
    function SidecarBody(props) {
      const [frame, setFrame] = React.useState(null)
      const [ptr, setPtr] = React.useState(null)
      /* The page is laid out at the size of this column, so the picture it
         sends already has the right shape; these are its pixels. */
      const [view, setView] = React.useState({ w: SIDE_VIEW.width, h: SIDE_VIEW.height })
      /* The person at the mirror drives with their own hand: while they are,
         the agent's arrow stays out of the way, and it comes back by itself
         once their hold runs out. */
      const [person, setPerson] = React.useState(false)
      const personTimer = React.useRef(0)
      /* The person's own hand hides the arrow the moment it lands, without
         waiting for the browser to report a hold: the arrow is a claim about
         what the agent did, and a claim that outlives the agent's turn is a lie
         the person has to look past. It returns when their hand stops. */
      const [hand, setHand] = React.useState(false)
      const handTimer = React.useRef(0)
      const touched = () => {
        setHand(true)
        clearTimeout(handTimer.current)
        handTimer.current = setTimeout(() => setHand(false), 1500)
      }
      const hearHold = (message) => {
        const hold = Number(message?.hold ?? 0)
        if (!Number.isFinite(hold) || hold <= 0) return
        setPerson(true)
        clearTimeout(personTimer.current)
        personTimer.current = setTimeout(() => setPerson(false), hold + 120)
      }
      const [phase, setPhase] = React.useState('connecting')
      const [note, setNote] = React.useState('')
      /* The address this chat had before its tab went away: the pane reopens
         that address, so a lost picture costs one click. */
      const [back, setBack] = React.useState('')
      const [url, setUrl] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [editing, setEditing] = React.useState(false)
      const [size, setSize] = React.useState({ w: 0, h: 0 })
      /* The browser's own windows, this chat's only: a second window a site
         opened is a row here, not a second tab in the column. */
      const [wins, setWins] = React.useState([])
      const stage = React.useRef(null)
      /* Which chat owns the mirror, as the sidecar host records it. // ui-copy-ignore
         Empty until
         the host answers; a chat that does not own it draws no picture at all. // ui-copy-ignore */
      const [owner, setOwner] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        let dropped = false
        /* The tab is still in this chat's column, so this chat may say the
           mirror is its own: a reload forgets the owner, and a pane that only
           waited would stay dark until some tool ran. */
        const reclaim = () => {
          const id = String(props.sessionId ?? '')
          if (id === '') return
          void fetch(`${ROUTE}/sidecar/claim`, { // ui-copy-ignore
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: id }),
          })
            .then((reply) => (reply.ok === true ? reply.json() : null))
            .then((info) => {
              if (alive !== true) return
              if (info?.ok === true) {
                setOwner(id)
                /* The owner was just named, so the next poll may adopt the
                   browser: ask now instead of up to a poll later. */
                setTimeout(read, 0)
              }
            })
            .catch(() => {})
        }
        const read = () => {
          const who = String(props.sessionId ?? '')
          /* Naming the chat lets a browser that outlived a reload be picked
             up for us; an anonymous poll cannot, and the column would sit on
             an empty stage with the browser running behind it. */
          void fetch(`${ROUTE}/sidecar/state?session=${encodeURIComponent(who)}`, { cache: 'no-store' }) // ui-copy-ignore
            .then((reply) => (reply.ok === true ? reply.json() : null))
            .then((info) => {
              if (alive !== true) return
              const next = String(info?.owner ?? '')
              const asked = String(props.sessionId ?? '')
              /* Nobody owns it, or this chat does but the note was lost: ask
                 back instead of showing a note for a browser this column shows. */
              if (asked !== '' && next !== asked) reclaim()
              setOwner((prev) => (prev === next ? prev : next))
              /* A browser that is gone still remembers where this chat was:
                 keep the address so the pane can offer to reopen it. */
              const was = String(info?.chat?.remembered ?? '')
              if (was !== '') setBack((prev) => (prev === was ? prev : was))
              /* Another chat holds the browser now: this tab goes away instead
                 of sitting here as a note. */
              if (dropped !== true && next !== '' && next !== String(props.sessionId ?? '')) {
                dropped = true
                try {
                  props.dropMirror?.()
                } catch {
                  /* a column already gone needs no closing */
                }
              }
            })
            .catch(() => {})
        }
        read()
        const timer = setInterval(read, 2500)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [props.sessionId])
      const asked = String(props.sessionId ?? '')
      /* Unknown until the host answers: the pane then shows no picture. // ui-copy-ignore
         But it
         does not flash a refusal either. Once the answer names another chat,
         this chat keeps only a note. // ui-copy-ignore */
      const unknown = owner === null
      const mine = unknown !== true && owner === asked
      /* A picture that stops arriving has to come back by itself: the pane
         re-opens its stream instead of sitting on an empty stage until the
         person reloads the page. */
      const [attempt, setAttempt] = React.useState(0)
      const drawnAt = React.useRef(0)

      React.useEffect(() => {
        if (mine !== true) return undefined
        drawnAt.current = Date.now()
        const who = encodeURIComponent(String(props.sessionId ?? ''))
        const source = new EventSource(`${ROUTE}/sidecar/frames?session=${who}`)
        /* Bursts arrive faster than a picture can decode: only the newest frame
           is painted, once per display refresh, so the mirror never falls behind
           by a queue of stale frames. */
        /** @type {any} */
        let pending = null
        let raf = 0
        const paint = () => {
          raf = 0
          if (pending === null) return
          const message = pending
          pending = null
          setFrame(message)
          setPtr(message.pointer ?? null)
          if (Number.isFinite(Number(message.w)) && Number.isFinite(Number(message.h))) {
            setView({ w: Number(message.w), h: Number(message.h) })
          }
          setPhase('live')
          drawnAt.current = Date.now()
          if (typeof message.url === 'string' && message.url !== '') setUrl(message.url)
        }
        const draw = (message) => {
          hearHold(message)
          pending = message
          if (raf !== 0) return
          if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(paint)
          else paint()
        }
        const stuck = setInterval(() => {
          /* Hello alone is not a picture: six quiet seconds means the stream is
             dead, so ask for a new one. */
          if (Date.now() - drawnAt.current > 6000) setAttempt((n) => n + 1)
        }, 3000)
        source.onmessage = (event) => {
          let message
          try {
            message = JSON.parse(event.data)
          } catch {
            return
          }
          if (message.type === 'hello') {
            setPhase('live')
            drawnAt.current = Date.now()
            setUrl(String(message.url ?? ''))
            setBack(String(message.chat?.remembered ?? ''))
          } else if (message.type === 'failed') {
            setPhase('failed')
            setNote(String(message.text ?? ''))
          } else if (message.type === 'pointer') {
            /* The arrow is drawn the moment the agent moves, not when the page
               next repaints: it stays honest even on a page that is idle. */
            hearHold(message)
            setPtr(message.pointer ?? null)
          } else if (typeof message.jpeg === 'string') {
            draw(message)
          }
        }
        source.onerror = () => setPhase('lost')
        return () => {
          clearInterval(stuck)
          clearTimeout(personTimer.current)
          clearTimeout(handTimer.current)
          if (raf !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
          source.close()
        }
      }, [props.sessionId, mine, attempt])

      /* The address field follows the page except while the person is editing it. */
      React.useEffect(() => {
        if (editing !== true) setDraft(url)
      }, [url, editing])

      React.useEffect(() => {
        const el = stage.current
        if (el === null) return undefined
        const measure = () => {
          const box = el.getBoundingClientRect()
          setSize({ w: box.width, h: box.height })
        }
        const observer = new ResizeObserver(measure)
        observer.observe(el)
        measure()
        return () => observer.disconnect()
      }, [])

      /* The picture carries the page, not the window list: ask for the list on
         a slow clock, and after a switch. */
      const [winsTick, setWinsTick] = React.useState(0)
      React.useEffect(() => {
        if (mine !== true) return undefined
        let alive = true
        const chat = String(props.sessionId ?? '')
        const load = () => {
          fetch(`${ROUTE}/sidecar/tabs?session=${encodeURIComponent(chat)}`) // ui-copy-ignore
            .then((reply) => (reply.ok === true ? reply.json() : null))
            .then((info) => {
              if (alive === false || info?.ok !== true || Array.isArray(info.tabs) !== true) return
              setWins(info.tabs)
            })
            .catch(() => {})
        }
        load()
        const clock = setInterval(load, 2500)
        return () => {
          alive = false
          clearInterval(clock)
        }
      }, [mine, props.sessionId, winsTick])

      const switchWin = (at) => {
        fetch(`${ROUTE}/sidecar/tabs`, { // ui-copy-ignore
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session: String(props.sessionId ?? ''), op: 'use', index: at }), // ui-copy-ignore
        })
          .then((reply) => (reply.ok === true ? reply.json() : null))
          .then((info) => {
            if (info?.ok === true && Array.isArray(info.tabs) === true) setWins(info.tabs)
            setWinsTick((n) => n + 1)
          })
          .catch(() => {})
      }

      /* Where the page actually got drawn inside the column: the frame fills
         the stage and the picture sits inside it, so the answer comes from the
         element that is on screen rather than from the last size remembered.
         A stale measure can then never shrink the picture to a thumbnail. */
      const frameEl = React.useRef(null)
      const picture = () => {
        const at = frameEl.current
        const areaEl = stage.current
        if (at === null || at === undefined || areaEl === null || areaEl === undefined) return null
        if (!(view.w > 0) || !(view.h > 0)) return null
        const a = at.getBoundingClientRect()
        const b = areaEl.getBoundingClientRect()
        if (!(a.width > 1) || !(a.height > 1)) return null
        const scale = Math.min(a.width / view.w, a.height / view.h)
        if (!(scale > 0)) return null
        return {
          scale,
          x: a.left - b.left + (a.width - view.w * scale) / 2,
          y: a.top - b.top + (a.height - view.h * scale) / 2,
        }
      }

      /* The column tells the page how big it is, a beat after the resize stops:
         a page that relayouts on every pointer step would never settle. */
      React.useEffect(() => {
        if (mine !== true || size.w < 200 || size.h < 200) return undefined
        /* The page already has that shape: a resize that lands between two
           viewport sizes would only cost a relayout and another frame. */
        if (Math.abs(Number(view?.w ?? 0) - size.w) < 1 && Math.abs(Number(view?.h ?? 0) - size.h) < 1) return undefined
        /* The page is told the column's size a beat after the resize stops.
           One ask: the pane draws at whatever shape the frame says it has, so
           a browser that is still starting costs nothing more than the next
           resize doing the same thing again. */
        const timer = setTimeout(() => {
          fetch(`${ROUTE}/sidecar/viewport`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: String(props.sessionId ?? ''), w: Math.round(size.w), h: Math.round(size.h) }),
          })
            .then((answer) => (answer.ok === true ? answer.json() : { ok: false }))
            .then((said) => {
              /* The browser answers with the shape it actually took: drawing
                 the picture at that size fills the pane even when the page
                 refused the exact one asked for. */
              const took = said?.view ?? null
              if (said?.ok === true && took !== null && Number(took.width) > 0 && Number(took.height) > 0) {
                setView({ w: Math.round(Number(took.width)), h: Math.round(Number(took.height)) })
              }
            })
            .catch(() => {})
        }, 250)
        return () => clearTimeout(timer)
      }, [mine, size.w, size.h, view?.w, view?.h])

      const who = String(props.sessionId ?? '')
      const post = (path, body) => {
        void fetch(`${ROUTE}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, session: who }),
        }).catch(() => {})
      }
      /* The page names the cursor it would show under the hand; the black
         arrow is the agent's, so it keeps its own shape and colour. */
      const CURSORS = ['default', 'text', 'pointer', 'crosshair', 'move', 'grab', 'grabbing', 'not-allowed', 'help', 'wait', 'progress', 'ew-resize', 'ns-resize', 'nwse-resize', 'nesw-resize', 'col-resize', 'row-resize', 'zoom-in', 'zoom-out']
      const setCursor = (name) => {
        const el = stage.current
        if (el === null || el.style === undefined) return
        el.style.cursor = CURSORS.includes(name) === true ? name : 'default'
      }
      const hover = (point) => {
        /* A page that cannot say keeps the plain cursor: nothing here throws. */
        void fetch(`${ROUTE}/sidecar/input`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'hover', x: point.x, y: point.y, session: who }),
        })
          .then((reply) => (reply.ok === true ? reply.json() : null))
          .then((answer) => {
            if (answer !== null && typeof answer.cursor === 'string') setCursor(answer.cursor)
          })
          .catch(() => {})
      }
      const toView = (event) => {
        const el = stage.current
        if (el === null) return null
        const spot = picture()
        if (spot === null) return null
        const box = el.getBoundingClientRect()
        const x = (event.clientX - box.left - spot.x) / spot.scale
        const y = (event.clientY - box.top - spot.y) / spot.scale
        if (x < 0 || y < 0 || x > view.w || y > view.h) return null
        return { x: Math.round(x), y: Math.round(y) }
      }
      const ime = React.useRef(null)
      const composing = React.useRef(false)
      const sendText = (value) => {
        const text = String(value ?? '')
        if (text === '') return
        post('/sidecar/input', { kind: 'text', text })
      }
      const clearIme = () => {
        const field = ime.current
        if (field !== null && typeof field.value === 'string') field.value = ''
      }
      const stageRef = stage
      const onPointerDown = (event) => {
        touched()
        const point = toView(event)
        if (point === null) return
        const field = ime.current
        if (field !== null && typeof field.focus === 'function') field.focus()
        else {
          const el = stageRef.current
          if (el !== null && typeof el.focus === 'function') el.focus()
        }
        post('/sidecar/input', { kind: 'click', x: point.x, y: point.y })
      }
      const movedAt = React.useRef(0)
      const onPointerMove = (event) => {
        touched()
        const point = toView(event)
        if (point === null) return
        /* Hover is part of a page: menus open under the hand, so the movement
           also reaches the browser. It never moves the agent's arrow, which
           only follows what the agent itself did. */
        const now = Date.now()
        if (now - movedAt.current < 60) return
        movedAt.current = now
        hover(point)
      }
      const onWheel = (event) => {
        touched()
        event.preventDefault()
        const point = toView(event) ?? { x: Math.round(view.w / 2), y: Math.round(view.h / 2) }
        post('/sidecar/input', { kind: 'wheel', x: point.x, y: point.y, dx: event.deltaX, dy: event.deltaY })
      }
      /* The page's keys are the person's keys: shift makes a capital, a
         shortcut stays a shortcut so Ctrl+V pastes and Ctrl+A selects, and the
         key that goes down also goes up so a game can hold it. */
      const modsOf = (event) => (event.altKey === true ? 1 : 0)
        | (event.ctrlKey === true ? 2 : 0)
        | (event.metaKey === true ? 4 : 0)
        | (event.shiftKey === true ? 8 : 0)
      const MODIFIER_KEYS = ['Alt', 'Control', 'Meta', 'Shift', 'AltGraph', 'OS', 'Super', 'Hyper']
      const keyBody = (event, down) => {
        const modifiers = modsOf(event)
        const shortcut = (modifiers & 7) !== 0
        const typing = down === true && event.key.length === 1 && (modifiers & 7) === 0 && event.repeat !== true
        return {
          kind: 'key',
          key: event.key,
          code: event.code || event.key,
          keyCode: event.keyCode || 0,
          modifiers,
          ...(typing ? { text: event.key } : {}),
          ...(down === false ? { down: false } : {}),
        }
      }
      const onKeyDown = (event) => {
        touched()
        /* A key still being composed belongs to the IME, not to the page. */
        if (event.isComposing === true) return
        if (event.key == null || MODIFIER_KEYS.includes(event.key) === true) return
        event.preventDefault()
        post('/sidecar/input', event.repeat === true ? { ...keyBody(event, true), repeat: true } : keyBody(event, true))
      }
      const onKeyUp = (event) => {
        if (event.isComposing === true) return
        if (event.key == null || MODIFIER_KEYS.includes(event.key) === true) return
        event.preventDefault()
        post('/sidecar/input', keyBody(event, false))
      }
      const goto = () => {
        const address = String(draft ?? '').trim()
        if (address === '') return
        setEditing(false)
        post('/sidecar/nav', { op: 'goto', url: address })
      }

      /* A chat that does not own the browser never shows its picture. */
      if (mine !== true && unknown !== true) {
        return h('div', { className: 'dshib-side' },
          h('div', { className: 'dshib-side-note' }, L('side.foreign')))
      }
      const pointer = person === true || hand === true ? null : ptr
      const spot = pointer === null ? null : (picture() ?? { scale: 1, x: 0, y: 0 })
      const noteText = phase === 'failed' ? note || L('side.failed') : phase === 'live' ? L('side.empty') : L('side.connecting')
      return h('div', { className: 'dshib-side' },
        h('div', { className: 'dshib-side-bar' },
          h('button', { className: 'dshib-side-key', type: 'button', title: L('side.back'), 'aria-label': L('side.back'), onClick: () => post('/sidecar/nav', { op: 'back' }) }, '\u2190'), // ui-copy-ignore
          h('button', { className: 'dshib-side-key', type: 'button', title: L('side.forward'), 'aria-label': L('side.forward'), onClick: () => post('/sidecar/nav', { op: 'forward' }) }, '\u2192'), // ui-copy-ignore
          h('button', { className: 'dshib-side-key', type: 'button', title: L('side.reload'), 'aria-label': L('side.reload'), onClick: () => post('/sidecar/nav', { op: 'reload' }) }, '\u27f3'), // ui-copy-ignore
          h('input', {
            className: 'dshib-side-url',
            value: draft,
            placeholder: L('side.address'),
            spellCheck: false,
            'aria-label': L('side.address'),
            onChange: (event) => setDraft(event.target.value),
            onFocus: () => setEditing(true),
            onBlur: () => setEditing(false),
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              goto()
            },
          })),
        ...(wins.length > 1
          ? [h('div', { className: 'dshib-side-wins' },
            ...wins.map((win) => h('button', {
              key: `${win.index}:${win.url}`,
              className: 'dshib-side-win',
              type: 'button', // ui-copy-ignore
              'data-on': win.current === true ? '1' : '0',
              title: win.url,
              onClick: () => switchWin(win.index),
            }, h('span', null, String(win.title ?? '') || String(win.url ?? '')))))]
          : []),
        h('div', {
          className: 'dshib-side-stage',
          ref: stage,
          tabIndex: 0,
          onPointerDown,
          onPointerMove,
          onWheel,
          onKeyDown,
          onKeyUp,
        },
          frame === null && back !== ''
            ? h('button', {
              className: 'dshib-side-back',
              type: 'button', // ui-copy-ignore
              onClick: () => { // ui-copy-ignore
                void fetch(`${ROUTE}/sidecar/open`, { // ui-copy-ignore
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ session: who, url: back }), // ui-copy-ignore
                })
                  .then((reply) => (reply.ok === true ? reply.json() : null))
                  .then((info) => {
                    if (info?.ok === true) setAttempt((n) => n + 1)
                  })
                  .catch(() => {})
              },
            }, L('side.restore'))
            : frame === null ? h('div', { className: 'dshib-side-note' }, noteText) : null,
          h('textarea', {
            className: 'dshib-side-ime',
            ref: ime,
            tabIndex: 0,
            spellCheck: false,
            'aria-label': L('side.type'),
            style: pointer === null || spot === null ? undefined : { left: `${spot.x + pointer.x * spot.scale}px`, top: `${spot.y + pointer.y * spot.scale}px` },
            onCompositionStart: () => {
              composing.current = true
            },
            onCompositionEnd: (event) => {
              composing.current = false
              sendText(event.data)
              clearIme()
            },
            onChange: (event) => {
              if (composing.current === true) return
              sendText(event.target.value)
              clearIme()
            },
            onKeyDown,
            onKeyUp,
          }),
          frame === null ? null : h('img', {
            className: 'dshib-side-frame',
            ref: frameEl,
            src: `data:image/jpeg;base64,${frame.jpeg}`,
            width: Math.max(1, Math.round(view.w)),
            height: Math.max(1, Math.round(view.h)),
            alt: '', // ui-copy-ignore
            draggable: false,
          }),
          pointer === null ? null : h('img', {
            className: 'dshib-side-ptr',
            src: SIDE_POINTER, // ui-copy-ignore
            alt: '', // ui-copy-ignore
            style: spot === null ? undefined : { left: `${spot.x + pointer.x * spot.scale}px`, top: `${spot.y + pointer.y * spot.scale}px` },
          })))
    }
  },
})

/* census probe */
