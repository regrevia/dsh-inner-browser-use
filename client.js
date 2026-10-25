/**
 * dsh-inner-browser-use — client half.
 *
 * Registers a sidebar tab whose page is a real browser guest: the Desktop main
 * process leases it, so it is the same inner browser the product ships, not a
 * window this plugin opens. The tab holds the only end that can touch that
 * page, so it is also the Client end of the tool wire: it keeps a downlink
 * stream open, runs the operation each frame asks for inside the page, and
 * posts the answer back up.
 *
 * Operations the Host can ask for: navigate, view, click, type, script. // ui-copy-ignore
 */

window.__ModuleLoader__.load({
  id: 'dsh-inner-browser-use',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'inner-browser-use'
    const KIND = 'inner-browser-use'
    const ID = 'dsh-inner-browser-use'
    const ROUTE = '/dsh-inner-browser-use'
    const STYLE_ID = 'dsh-inner-browser-use-css'
    const ALIVE_MS = 20_000
    /* The ask stream belongs to the half that was serving when it opened. After
       that half reloads, the stream still looks open and reaches nothing, so the
       beat that names a new one reopens it. */
    let streamEpoch = ''
    let reopenStream = null
    const SLOT = 'sidebar.right.pane.tab'
    const TITLE_SLOT = 'sidebar.right.pane.tab.title'

    const DICT = {
      zh: {
        'type.label': '内置浏览器',
        'guide.description': '让助手在侧边栏里操作页面',
        'phase.opening': '正在打开…',
        'phase.ready': '已连接',
        'phase.closed': '已关闭',
        'error.desktopOnly': '需要在桌面版中使用',
        'error.lease': '无法打开浏览器面板',
      },
      en: {
        'type.label': 'Inner browser',
        'guide.description': 'Let the assistant drive a page in the sidebar',
        'phase.opening': 'Opening…',
        'phase.ready': 'Connected',
        'phase.closed': 'Closed',
        'error.desktopOnly': 'Requires the desktop app',
        'error.lease': 'Could not open the browser panel',
      },
    }
    const LANG = /^zh/i.test(typeof navigator === 'undefined' ? '' : navigator.language ?? '') ? 'zh' : 'en'
    const L = (key) => DICT[LANG][key] ?? key

    const CSS = [
      '.dshib-body{display:flex;flex-direction:column;min-height:0;height:100%;position:relative;background:var(--dsw-alias-bg-base)}',
      '.dshib-guest{flex:1 1 auto;min-height:0;width:100%;border:0;display:flex;background:var(--dsw-alias-bg-base)}',
      '.dshib-state{display:flex;align-items:center;gap:6px;padding:6px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-subtle)}',
      '.dshib-state[data-tone="error"]{color:var(--dsw-alias-label-danger)}',
      '.dshib-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}',
      '.dshib-state[data-tone="ready"] .dshib-dot{background:var(--dsw-alias-label-success)}',
      '.dshib-state[data-tone="error"] .dshib-dot{background:var(--dsw-alias-label-danger)}',
    ].join('')

    /**
     * The page runtime. Injected on every call, so it survives full navigations
     * without any load listener: it installs the pointer once, then answers one
     * operation.
     */
    const RUNTIME = String.raw`
      const D = document, W = window
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const SEL = 'a[href],button,input,textarea,select,summary,label,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="menuitem"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'
      const visible = (el) => {
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) return false
        const s = W.getComputedStyle(el)
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'
      }
      const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n)
      const chrome = () => {
        if (D.getElementById('__dsh_ib_css') !== null) return
        const style = D.createElement('style')
        style.id = '__dsh_ib_css'
        style.textContent = [
          '#__dsh_ib_ptr{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;',
          'transform:translate3d(-40px,-40px,0);transition:transform 200ms cubic-bezier(.2,.7,.3,1);',
          'filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}',
          '#__dsh_ib_rip{position:fixed;left:0;top:0;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;',
          'z-index:2147483646;pointer-events:none;opacity:0;background:rgba(120,160,255,.45);',
          'transform:translate3d(-60px,-60px,0) scale(.2)}',
          '#__dsh_ib_rip.on{animation:__dsh_ib_rip_a 460ms ease-out forwards}',
          '@keyframes __dsh_ib_rip_a{0%{opacity:.85;transform:translate3d(var(--x),var(--y),0) scale(.25)}',
          '100%{opacity:0;transform:translate3d(var(--x),var(--y),0) scale(1.6)}}',
          '[data-dsh-ib-ref]{outline:2px solid rgba(120,160,255,.85)!important;outline-offset:1px!important}',
        ].join('')
        ;(D.head || D.documentElement).appendChild(style)
        const ptr = D.createElement('div')
        ptr.id = '__dsh_ib_ptr'
        ptr.setAttribute('aria-hidden', 'true')
        ptr.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2l14 7.2-6.2 1.5-2.5 6.1z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>'
        D.documentElement.appendChild(ptr)
        const rip = D.createElement('div')
        rip.id = '__dsh_ib_rip'
        rip.setAttribute('aria-hidden', 'true')
        D.documentElement.appendChild(rip)
      }
      const aim = async (el) => {
        chrome()
        const r = el.getBoundingClientRect()
        const x = r.left + r.width / 2, y = r.top + r.height / 2
        const ptr = D.getElementById('__dsh_ib_ptr')
        const rip = D.getElementById('__dsh_ib_rip')
        if (ptr) ptr.style.transform = 'translate3d(' + (x - 4) + 'px,' + (y - 2) + 'px,0)'
        await sleep(210)
        if (rip) {
          rip.style.setProperty('--x', (x - 14) + 'px')
          rip.style.setProperty('--y', (y - 14) + 'px')
          rip.classList.remove('on')
          void rip.offsetWidth
          rip.classList.add('on')
        }
        await sleep(120)
      }
      const index = () => {
        const found = []
        for (const el of D.querySelectorAll(SEL)) {
          if (!visible(el) || el.disabled === true) continue
          found.push(el)
          if (found.length >= 80) break
        }
        found.forEach((el, i) => el.setAttribute('data-dsh-ib-ref', String(i + 1)))
        return found
      }
      const label = (el) => {
        const tag = el.tagName.toLowerCase()
        const kind = tag === 'a' ? 'link'
          : tag === 'button' || el.getAttribute('role') === 'button' ? 'button'
          : tag === 'input' || tag === 'textarea' || el.isContentEditable === true ? 'input'
          : tag === 'select' ? 'select'
          : tag === 'label' ? 'label'
          : (el.getAttribute('role') || tag)
        const name = el.getAttribute('aria-label') || el.getAttribute('placeholder')
          || clip(el.innerText, 40) || el.getAttribute('title') || el.getAttribute('name')
          || el.id || ''
        const value = el.tagName === 'INPUT' && el.type !== 'password' && el.value ? ' = ' + clip(el.value, 30) : ''
        return '[' + kind + '] ' + (name || '(no label)') + value
      }
      const view = () => {
        const found = index()
        const lines = []
        lines.push('URL ' + location.href)
        lines.push('Title ' + (D.title || '(none)'))
        lines.push('Controls ' + found.length)
        found.forEach((el, i) => lines.push('#' + (i + 1) + ' ' + label(el)))
        const text = clip(D.body ? D.body.innerText : '', 2400)
        if (text !== '') lines.push('Text ' + text)
        for (const el of found) el.removeAttribute('data-dsh-ib-ref')
        return lines.join('\n')
      }
      const find = (ref) => {
        const el = D.querySelector('[data-dsh-ib-ref="' + ref + '"]')
        if (el !== null) return el
        const found = index()
        const hit = found[Number(ref) - 1]
        if (hit === undefined) throw new Error('no control #' + ref + ' on this page')
        return hit
      }
      const setValue = (el, text) => {
        const proto = el.tagName === 'TEXTAREA' ? W.HTMLTextAreaElement.prototype
          : el.tagName === 'SELECT' ? W.HTMLSelectElement.prototype : W.HTMLInputElement.prototype
        const desc = Object.getOwnPropertyDescriptor(proto, 'value')
        if (desc && desc.set) desc.set.call(el, text)
        else el.value = text
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }
      const press = (el, key) => {
        const init = { key, code: key, keyCode: key === 'Enter' ? 13 : 0, which: key === 'Enter' ? 13 : 0, bubbles: true }
        el.dispatchEvent(new KeyboardEvent('keydown', init))
        el.dispatchEvent(new KeyboardEvent('keypress', init))
        el.dispatchEvent(new KeyboardEvent('keyup', init))
      }
      const run = async (op, a) => {
        chrome()
        if (op === 'view') return view()
        if (op === 'click') {
          const el = find(a.ref)
          el.scrollIntoView({ block: 'center', inline: 'center' })
          await aim(el)
          el.click()
          await sleep(420)
          return 'Clicked #' + a.ref + ' ' + label(el) + '\n' + view()
        }
        if (op === 'type') {
          const el = find(a.ref)
          el.scrollIntoView({ block: 'center', inline: 'center' })
          await aim(el)
          el.focus()
          if (el.isContentEditable === true) {
            el.textContent = a.text
            el.dispatchEvent(new Event('input', { bubbles: true }))
          } else {
            setValue(el, a.text)
          }
          if (a.submit === true) {
            press(el, 'Enter')
            await sleep(520)
          } else {
            await sleep(120)
          }
          return 'Typed into #' + a.ref + ' ' + label(el) + '\n' + view()
        }
        if (op === 'upload') {
          const el = find(a.ref)
          if (el.tagName !== 'INPUT' || el.type !== 'file') throw new Error('#' + a.ref + ' is not a file field')
          const binary = atob(a.base64)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
          const file = new File([bytes], a.name, { type: a.type || 'application/octet-stream' })
          const tray = new DataTransfer()
          tray.items.add(file)
          el.files = tray.files
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          el.scrollIntoView({ block: 'center' })
          await aim(el)
          await sleep(320)
          return 'Attached ' + a.name + ' to #' + a.ref + '\n' + view()
        }
        throw new Error('unknown operation ' + op)
      }
    `

    /** @param {HTMLWebViewElement} el - guest. @param {string} op - operation name. @param {Record<string, unknown>} args - arguments. @returns {Promise<string>} guest answer. */
    function runIn(el, op, args) {
      const code = `(async function(){ ${RUNTIME}\n return await run(${JSON.stringify(op)}, ${JSON.stringify(args ?? {})}) })()`
      return el.executeJavaScript(code, true)
    }

    /**
     * Read the guest as a PNG, base64-encoded.
     *
     * The panel's own capture hands back an image object whose conversion runs
     * outside this page and fails there, so the debugger answers in base64
     * directly; the panel's capture stays as the fallback.
     * @param {HTMLWebViewElement} el - guest.
     * @returns {Promise<string>} base64 PNG.
     */
    async function grab(el) {
      const notes = []
      let bug = null
      try {
        bug = el.debugger ?? null
      } catch (error) {
        notes.push('debugger: ' + String(error?.message ?? error))
        bug = null
      }
      if (bug === null) notes.push('debugger: absent')
      if (bug !== null) {
        let attached = false
        try {
          await bug.attach('1.3')
          attached = true
          const shot = await bug.sendCommand('Page.captureScreenshot', { format: 'png' })
          const data = shot?.data
          if (typeof data === 'string' && data !== '') return data
          notes.push('debugger: no data')
        } catch (error) {
          notes.push('debugger: ' + String(error?.message ?? error))
        } finally {
          if (attached) {
            try {
              await bug.detach()
            } catch {
              /* already gone */
            }
          }
        }
      }
      try {
        let image
        try {
          image = await el.capturePage()
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 250))
          image = await el.capturePage()
        }
        return image.toPNG().toString('base64')
      } catch (error) {
        throw new Error(String(error?.message ?? error) + ' (' + notes.join('; ') + ')')
      }
    }

    /**
     * Tell the Host this half is alive, and later what it managed to register. // ui-copy-ignore
     * Nothing else in the Client runs until a tab opens, so this is the only
     * proof the module itself executed.
     * @param {Record<string, unknown>} frame - what to report.
     */
    function beat(frame) {
      void fetch(`${ROUTE}/uplink?session=`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-alive', at: new Date().toISOString(), ...frame }),
      }).then(async (response) => {
        if (response?.ok !== true) return
        const seen = (await response.json().catch(() => null))?.epoch
        if (typeof seen !== 'string' || seen === '' || seen === streamEpoch) return
        const known = streamEpoch !== ''
        streamEpoch = seen
        if (known) reopenStream?.()
      }).catch(() => {})
    }

    /**
     * Resolve the workspace that owns a chat, the same key the built-in browser
     * leases its guest with: one partition per canonical CWD.
     * @param {any} source - workspace controller face. @param {string} sessionId - chat. @returns {Promise<string>} lease key.
     */
    function workspaceKey(source, sessionId) {
      return new Promise((resolve, reject) => {
        const store = source?.list ?? source
        const read = () => {
          const snapshot = store?.getSnapshot?.()
          if (snapshot === undefined || snapshot.phase !== 'ready') return undefined
          const workspace = snapshot.items.find((item) => item.sessionIds.some((id) => id === sessionId))
          return workspace === undefined ? `session:${sessionId}` : `cwd:${workspace.path}`
        }
        const settled = read()
        if (settled !== undefined) {
          resolve(settled)
          return
        }
        const stop = store.subscribe(() => {
          const value = read()
          if (value === undefined) return
          stop()
          resolve(value)
        })
        setTimeout(() => {
          stop()
          reject(new Error(L('error.lease')))
        }, 10_000)
      })
    }

    /** @param {HTMLWebViewElement} el - guest. @param {string} name - event. @param {number} ms - budget. @returns {Promise<boolean>} whether it fired. */
    function waitEvent(el, name, ms) {
      return new Promise((resolve) => {
        let done = false
        const finish = (hit) => {
          if (done) return
          done = true
          el.removeEventListener(name, onHit)
          resolve(hit)
        }
        const onHit = () => finish(true)
        el.addEventListener(name, onHit)
        setTimeout(() => finish(false), ms)
      })
    }

    /**
     * Frame reader for one downlink stream.
     * @param {ReadableStream<Uint8Array>} body - response body. @param {(frame: any) => void} onFrame - frame sink. @returns {() => void} cancel.
     */
    function readFrames(body, onFrame) {
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let stopped = false
      void (async () => {
        while (stopped === false) {
          const { value, done } = await reader.read().catch(() => ({ done: true }))
          if (done) return
          buffer += decoder.decode(value, { stream: true })
          let cut
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, cut)
            buffer = buffer.slice(cut + 2)
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data:') === false) continue
              try {
                onFrame(JSON.parse(line.slice(5).trim()))
              } catch {
                /* a frame this version does not understand */
              }
            }
          }
        }
      })()
      return () => {
        stopped = true
        void reader.cancel().catch(() => {})
      }
    }

    /**
     * Own one guest for one tab.
     * @param {{host: HTMLElement, sessionId: string, key: () => Promise<string>, onPhase: (phase: string, error?: string) => void}} options - mount options. // ui-copy-ignore
     * @returns {{dispose: () => void}} handle.
     */
    function mountGuest(options) {
      const carrier = globalThis.dshDesktop
      const bridge = carrier?.protocolVersion === 1 ? carrier.browser : undefined
      let disposed = false
      let lease
      let webview
      let cancel = () => {}

      const dispose = () => {
        disposed = true
        cancel()
        if (webview !== undefined) webview.remove()
        if (bridge !== undefined && lease !== undefined) bridge.release(lease)
        options.onPhase('closed')
      }

      void (async () => {
        if (bridge === undefined) {
          options.onPhase('error', L('error.desktopOnly'))
          return
        }
        options.onPhase('opening')
        try {
          lease = await bridge.acquire(await options.key())
          if (disposed) return
          webview = document.createElement('webview')
          webview.className = 'dshib-guest'
          webview.setAttribute('name', lease.lease)
          webview.setAttribute('partition', lease.partition)
          webview.setAttribute('allowpopups', '')
          webview.setAttribute('src', `about:blank#${lease.lease}`)
          const ready = waitEvent(webview, 'dom-ready', 20_000)
          options.host.appendChild(webview) // ui-copy-ignore
          if ((await ready) === false) throw new Error(L('error.lease'))
          if (disposed) return
          options.onPhase('ready')

          cancel = readFrames(
            (await fetch(`${ROUTE}/downlink?session=${encodeURIComponent(options.sessionId)}`, { cache: 'no-store' })).body,
            (frame) => {
              if (frame?.type !== 'call') return
              const reply = (payload) => {
                void fetch(`${ROUTE}/uplink?session=${encodeURIComponent(options.sessionId)}`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ id: frame.id, ...payload }),
                })
              }
              void (async () => {
                try {
                  if (frame.tool === 'navigate') {
                    let failed = ''
                    const stop = new Promise((resolve) => {
                      webview.addEventListener('did-fail-load', (event) => {
                        if (event.errorCode === -3) return
                        failed = event.errorDescription || 'load failed'
                        resolve()
                      }, { once: true })
                      webview.addEventListener('did-stop-loading', () => resolve(), { once: true })
                      setTimeout(resolve, 45_000)
                    })
                    webview.loadURL(String(frame.args?.url ?? ''))
                    await stop
                    if (failed !== '') throw new Error(failed)
                    reply({ ok: true, value: await runIn(webview, 'view', {}) })
                    return
                  }
                  if (frame.tool === 'shot') {
                    reply({ ok: true, value: { png: await grab(webview) } })
                    return
                  }
                  if (frame.tool === 'script') {
                    const result = await webview.executeJavaScript(String(frame.args?.code ?? ''), true)
                    const text = typeof result === 'string' ? result : JSON.stringify(result ?? null)
                    reply({ ok: true, value: text.slice(0, 8000) })
                    return
                  }
                  reply({ ok: true, value: await runIn(webview, frame.tool, frame.args ?? {}) })
                } catch (error) {
                  reply({ ok: false, error: String(error?.message ?? error) })
                }
              })()
            },
          )
        } catch (error) {
          if (disposed) return
          options.onPhase('error', String(error?.message ?? error))
        }
      })()

      return { dispose }
    }

    /** @param {{sessionId: string, key: () => Promise<string>}} props - slot props. @returns {any} element. */
    function Body(props) {
      const host = React.useRef(null) // ui-copy-ignore
      const [phase, setPhase] = React.useState('opening')
      const [error, setError] = React.useState('')
      React.useEffect(() => {
        if (host.current === null) return undefined // ui-copy-ignore
        const guest = mountGuest({
          host: host.current, // ui-copy-ignore
          sessionId: props.sessionId,
          key: props.workspace, // ui-copy-ignore
          onPhase: (next, message) => { // ui-copy-ignore
            setPhase(next)
            setError(message ?? '')
            beat({ tabType: true, phase: `guest-${next}`, session: props.sessionId, error: message ?? '' })
          },
        })
        return () => guest.dispose()
      }, [props.sessionId])
      const tone = phase === 'error' ? 'error' : phase === 'ready' ? 'ready' : 'opening'
      return h('div', { className: 'dshib-body' }, [
        h('div', { key: 'state', className: 'dshib-state', 'data-tone': tone }, [
          h('span', { key: 'dot', className: 'dshib-dot' }),
          h('span', { key: 'text' }, error !== '' ? error : L(`phase.${phase}`)),
        ]),
        h('div', { key: 'host', ref: host, className: 'dshib-guest', style: { display: 'flex' } }), // ui-copy-ignore
      ])
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Register the tab type, its body, and its title.
       * @param {any} ctx - client plugin context.
       */
      apply(ctx) {
        let registered = false
        beat({ tabType: false, phase: 'loaded' })
        setTimeout(() => beat({ tabType: registered, phase: registered ? 'ready' : 'idle' }), 3_000)
        ctx.effect(() => {
          const tick = setInterval(() => beat({ tabType: registered, phase: 'alive' }), ALIVE_MS)
          return () => clearInterval(tick)
        }, 'dsh-inner-browser-use: alive')
        try {
          ctx.locale.register(NS, { zh: DICT.zh, 'zh-CN': DICT.zh, en: DICT.en })
        } catch {
          /* one locale service or none */
        }
        ctx.effect(() => {
          const style = document.createElement('style')
          style.id = STYLE_ID
          style.dataset.pluginCss = ID
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-inner-browser-use: styles')

        /* The strip is a service provided by the sidebar plugin; a page that was
           not injected with it can only read it as undefined, and the ask is lost. */
        ctx.inject(['layout', 'sidebarRight'], (scope) => scope.effect(() => {
          beat({ tabType: registered, phase: 'wired' })
          let source
          const onWanted = (event) => {
            let frame
            try {
              frame = JSON.parse(event.data)
            } catch {
              return
            }
            if (frame?.type !== 'wanted') return
            const sessionId = String(frame.session ?? '')
            if (sessionId === '') return
            try {
              scope.layout?.openRightbar?.(true, false) // ui-copy-ignore
            } catch (error) {
              beat({ tabType: registered, phase: 'open', step: 'rightbar', error: String(error?.message ?? error) })
            }
            /* The current chat is the one place a page may open a tab without an id;
               the id path is the fallback for a page showing another chat. */
            let opened = ''
            try {
              const strip = scope.sidebarRight
              if (typeof strip?.openTab === 'function') {
                strip.openTab(KIND, {}) // ui-copy-ignore
                opened = 'current'
              }
            } catch (error) {
              opened = `failed: ${String(error?.message ?? error)}`
            }
            if (opened === '' || opened.startsWith('failed')) {
              try {
                scope.sidebarRight?.openTabIn?.(sessionId, KIND, {}) // ui-copy-ignore
                opened = 'session'
              } catch (error) {
                opened = `failed: ${String(error?.message ?? error)}`
              }
            }
            beat({ tabType: registered, phase: 'open', opened, session: sessionId })
          }
          const open = () => {
            source?.close()
            source = new EventSource(`${ROUTE}/watch`) // ui-copy-ignore
            source.addEventListener('message', onWanted)
          }
          reopenStream = open
          open()
          return () => {
            reopenStream = null
            source?.close()
          }
        }, 'dsh-inner-browser-use: tab on demand'))

        ctx.inject(['sidebarRightTabs', 'workspaces'], (scope) => {
          const tabs = scope.sidebarRightTabs
          const workspaces = scope.workspaces
          scope.effect(() => tabs.register({
            id: ID, // ui-copy-ignore
            kind: KIND, // ui-copy-ignore
            multiple: true, // ui-copy-ignore
            keepMounted: true,
            title: () => L('type.label'),
          }), 'dsh-inner-browser-use: tab type')
          registered = true
          beat({ tabType: true, phase: 'registered' })

          scope.slots.inject(SLOT, () => scope.slots.register({
            name: SLOT, // ui-copy-ignore
            key: ID, // ui-copy-ignore
            locale: NS, // ui-copy-ignore
            /* `key` is reserved by React and never reaches the body; the slot
               passes the workspace under its own name. */
            inject: (sessionId) => ({
              sessionId,
              workspace: () => workspaceKey(workspaces, sessionId),
            }),
          }, Body))

          scope.slots.inject(TITLE_SLOT, () => scope.slots.register({
            name: TITLE_SLOT, // ui-copy-ignore
            key: ID, // ui-copy-ignore
            locale: NS, // ui-copy-ignore
          }, () => h('span', { className: 'dshib-title' }, L('type.label'))))
        })
      },
    }
  },
})
