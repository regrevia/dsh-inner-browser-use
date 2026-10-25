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
        'pane.drag': '拖到聊天',
        'pane.dragHint': '把这一页的选中文字拖进聊天',
      },
      en: {
        'type.label': 'Inner browser',
        'guide.description': 'Let the assistant drive a page in the sidebar',
        'phase.opening': 'Opening…',
        'phase.ready': 'Connected',
        'phase.closed': 'Closed',
        'error.desktopOnly': 'Requires the desktop app',
        'error.lease': 'Could not open the browser panel',
        'pane.drag': 'Drag to chat',
        'pane.dragHint': 'Drag the selected text of this page into the chat',
      },
    }
    const LANG = /^zh/i.test(typeof navigator === 'undefined' ? '' : navigator.language ?? '') ? 'zh' : 'en'
    const L = (key) => DICT[LANG][key] ?? key

    const CSS = [
      '.dshib-body{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;height:100%;position:relative;background:var(--dsw-alias-bg-base)}',
      '.dshib-viewport{display:flex;flex:1 1 auto;min-width:0;min-height:0;position:relative}',
      /* Kept off screen rather than display:none: an unrendered guest cannot
         answer, and this one has to answer while another chat is on screen. */
      '.dshib-stash{position:fixed;left:-20000px;top:0;width:1100px;height:820px;visibility:hidden;pointer-events:none}',
      '.dshib-guest{flex:1 1 auto;min-width:0;min-height:0;width:100%;height:100%;border:0;display:flex;background:var(--dsw-alias-bg-base)}',
      '.dshib-state{flex:none;display:flex;align-items:center;gap:6px;padding:6px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-subtle)}',
      '.dshib-state[data-tone="error"]{color:var(--dsw-alias-label-danger)}',
      '.dshib-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}',
      '.dshib-state[data-tone="ready"] .dshib-dot{background:var(--dsw-alias-label-success)}',
      '.dshib-state[data-tone="error"] .dshib-dot{background:var(--dsw-alias-label-danger)}',
      '.dshib-href{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;direction:rtl;background:transparent;border:0;padding:0;font:inherit;color:var(--dsh-text-2,inherit)}',
      '.dshib-href:focus{outline:none;text-align:left;direction:ltr;color:var(--dsh-text-1,inherit)}',
      '.dshib-drag{flex:none;display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;',
      'border:1px solid var(--dsw-alias-border-subtle);color:var(--dsw-alias-label-secondary);cursor:grab;',
      'user-select:none;white-space:nowrap}',
      '.dshib-drag:active{cursor:grabbing}',
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
          'transform:translate3d(-40px,-40px,0);opacity:1;transition:transform 200ms cubic-bezier(.2,.7,.3,1),opacity 600ms ease;',
          'filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}',
          '#__dsh_ib_ptr.away{opacity:0}',
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
      let away = 0
      const aim = async (el) => {
        chrome()
        const r = el.getBoundingClientRect()
        const x = r.left + r.width / 2, y = r.top + r.height / 2
        const ptr = D.getElementById('__dsh_ib_ptr')
        const rip = D.getElementById('__dsh_ib_rip')
        clearTimeout(away)
        if (ptr) {
          ptr.classList.remove('away')
          ptr.style.transform = 'translate3d(' + (x - 4) + 'px,' + (y - 2) + 'px,0)'
          /* The pointer stays where it acted long enough to be seen, then leaves. */
          away = setTimeout(() => ptr.classList.add('away'), 8000)
        }
        await sleep(210)
        if (rip) {
          rip.style.setProperty('--x', (x - 14) + 'px')
          rip.style.setProperty('--y', (y - 14) + 'px')
          rip.classList.remove('on')
          void rip.offsetWidth
          rip.classList.add('on')
        }
        await sleep(120)
        return { x: Math.round(x), y: Math.round(y) }
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
      const keep = () => (W.__dshib_dl = W.__dshib_dl || {})
      const join64 = (parts) => {
        let size = 0
        for (const part of parts) size += part.length
        const all = new Uint8Array(size)
        let at = 0
        for (const part of parts) { all.set(part, at); at += part.length }
        let s = ''
        for (let i = 0; i < all.length; i += 8192) s += String.fromCharCode.apply(null, all.subarray(i, i + 8192))
        return W.btoa(s)
      }
      const fileUrl = (a) => {
        if (typeof a.url === 'string' && a.url !== '') return a.url
        if (a.ref === undefined) throw new Error('give a url, or the control that links to the file')
        const el = find(a.ref)
        const holder = el.closest('a[href]') || el
        const href = holder.getAttribute('href') || holder.getAttribute('src') || holder.src || ''
        if (href === '' || href.startsWith('javascript:')) throw new Error('#' + a.ref + ' carries no file address')
        return new URL(href, location.href).href
      }
      const fileName = (a, url, res) => {
        if (typeof a.name === 'string' && a.name !== '') return a.name
        const sent = res.headers.get('content-disposition') || ''
        const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(sent)
        if (named !== null) return decodeURIComponent(named[1])
        const tail = new URL(url).pathname.split('/').filter(Boolean).pop() || ''
        if (tail !== '') return decodeURIComponent(tail)
        /* A page with no name in its address is still worth a file: its type
           gives it one the desktop knows how to open. */
        const kind = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
        const ext = {
          'text/html': 'html', 'application/xhtml+xml': 'html', 'text/plain': 'txt', 'text/markdown': 'md',
          'application/json': 'json', 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg',
          'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'application/zip': 'zip',
        }[kind]
        return 'page.' + (ext ?? 'bin')
      }
      const run = async (op, a) => {
        chrome()
        if (op === 'view') return view()
        if (op === 'click') {
          const el = find(a.ref)
          el.scrollIntoView({ block: 'center', inline: 'center' })
          const at = await aim(el)
          el.click()
          await sleep(420)
          return 'Clicked #' + a.ref + ' ' + label(el) + ' at ' + at.x + ',' + at.y + '\n' + view()
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
        if (op === 'selection') {
          const picked = String(W.getSelection ? W.getSelection().toString() : '')
          const active = D.activeElement
          const field = active !== null && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
            && typeof active.value === 'string' && active.type !== 'password' ? String(active.value) : ''
          const lines = ['URL ' + location.href]
          if (picked.trim() !== '') lines.push('Selected ' + clip(picked, 4000))
          else if (field !== '') lines.push('Field ' + clip(field, 4000))
          else lines.push('Selected (none)')
          return lines.join('\n')
        }
        if (op === 'copy') {
          let text = String(W.getSelection ? W.getSelection().toString() : '')
          if (text.trim() === '' && a.ref !== undefined) {
            const el = find(a.ref)
            text = typeof el.value === 'string' ? String(el.value) : String(el.innerText || el.textContent || '')
          }
          if (text.trim() === '') throw new Error('nothing selected on this page')
          const area = D.createElement('textarea')
          area.value = text
          area.setAttribute('readonly', '')
          area.style.position = 'fixed'
          area.style.left = '-9999px'
          D.documentElement.appendChild(area)
          area.select()
          let ok = false
          try {
            ok = D.execCommand('copy')
          } finally {
            area.remove()
          }
          if (ok !== true) throw new Error('this page refuses the clipboard')
          return 'Copied ' + text.length + ' characters'
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
        if (op === 'href') {
          return fileUrl({ ref: a.ref })
        }
        if (op === 'dl-open') {
          const url = fileUrl(a)
          const res = await fetch(url, { credentials: 'include', redirect: 'follow' })
          if (res.ok !== true) throw new Error('the page answered ' + res.status + ' for ' + url.slice(0, 160))
          if (res.body === null) throw new Error('this page cannot stream ' + url.slice(0, 160))
          const name = fileName(a, url, res)
          const type = res.headers.get('content-type') || ''
          keep()[String(a.id || 'dl')] = { reader: res.body.getReader() }
          return { name, type, size: Number(res.headers.get('content-length') || 0) }
        }
        if (op === 'dl-next') {
          const id = String(a.id || 'dl')
          const entry = (W.__dshib_dl || {})[id]
          if (entry === undefined) throw new Error('no transfer ' + id)
          const parts = []
          let size = 0
          while (size < 512 * 1024) {
            const step = await entry.reader.read()
            if (step.done === true) {
              delete W.__dshib_dl[id]
              return { data: join64(parts), done: true }
            }
            parts.push(step.value)
            size += step.value.length
          }
          return { data: join64(parts), done: false }
        }
        throw new Error('unknown operation ' + op)
      }
    `

    /** @param {string} base64 - bytes as base64. @returns {Uint8Array} the bytes. */
    function bytesOf(base64) {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return bytes
    }

    /** @param {Uint8Array} bytes - raw bytes. @returns {string} the same bytes as base64. */
    function encode64(bytes) {
      let binary = ''
      for (let index = 0; index < bytes.length; index += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 8192))
      }
      return btoa(binary)
    }

    /**
     * A page can forbid its own network (a strict connect-src) and still show the
     * address of the file. This half has its own network rules, so it takes over.
     * @param {string} url - absolute address.
     * @param {string} wanted - name the caller asked for, if any.
     * @returns {Promise<{name: string, next: () => Promise<{data: string, done: boolean}>}>} a stream.
     */
    async function fetchHere(url, wanted) {
      const res = await fetch(url, { credentials: 'omit', redirect: 'follow' })
      if (res.ok !== true) throw new Error('this machine answered ' + res.status + ' for the address')
      if (res.body === null) throw new Error('this machine cannot stream the address')
      const reader = res.body.getReader()
      const tail = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
      const asked = wanted !== '' ? wanted : decodeURIComponent(tail)
      return {
        name: asked === '' ? 'download' : asked,
        next: async () => {
          const parts = []
          let size = 0
          while (size < 512 * 1024) {
            const step = await reader.read()
            if (step.done === true) return { data: encode64(parts.reduce((all, part) => {
              const next = new Uint8Array(all.length + part.length)
              next.set(all, 0)
              next.set(part, all.length)
              return next
            }, new Uint8Array(0))), done: true }
            parts.push(step.value)
            size += step.value.length
          }
          const merged = parts.reduce((all, part) => {
            const next = new Uint8Array(all.length + part.length)
            next.set(all, 0)
            next.set(part, all.length)
            return next
          }, new Uint8Array(0))
          return { data: encode64(merged), done: false }
        },
      }
    }

    /** @param {HTMLWebViewElement} el - guest. @param {string} op - operation name. @param {Record<string, unknown>} args - arguments. @returns {Promise<string>} guest answer. */
    function runIn(el, op, args) {
      const code = `(async function(){ ${RUNTIME}\n return await run(${JSON.stringify(op)}, ${JSON.stringify(args ?? {})}) })()`
      return el.executeJavaScript(code, true)
    }

    /**
     * Give up on a step that never settles.
     * @param {Promise<unknown>} work - pending step. @param {number} ms - budget. @param {string} label - stage name.
     * @returns {Promise<unknown>} the step's value.
     */
    function tick(work, ms, label) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(label + ' timed out')), ms)
        work.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
      })
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
    /** Where the driven guest sits, and what covers it. */
    function surface(driven) {
      try {
        const r = driven.getBoundingClientRect()
        let wcid = 0
        try {
          wcid = typeof driven.getWebContentsId === 'function' ? (driven.getWebContentsId() ?? 0) : 0
        } catch {
          wcid = 0
        }
        const cx = Math.round(r.left + r.width / 2)
        const cy = Math.round(Math.min(r.top + r.height / 2, window.innerHeight - 4))
        const inside = cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight
        const hit = inside ? document.elementFromPoint(cx, cy) : null
        const guests = []
        for (const each of document.querySelectorAll('webview')) {
          const b = each.getBoundingClientRect()
          guests.push([Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)].join(','))
        }
        return {
          wcid,
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(','),
          view: window.innerWidth + 'x' + window.innerHeight,
          covers: hit === null ? 'none' : String(hit.tagName) + '.' + String(hit.className || '').slice(0, 20),
          guests,
          seen: document.visibilityState,
        }
      } catch (error) {
        return { surface: String(error?.message ?? error).slice(0, 60) }
      }
    }

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
        /* A page the compositor is not drawing still answers a capture asked
           for from the page itself, so the capture that needs no surface is
           tried after the plain one instead of giving up with it. */
        const shapes = [
          { format: 'png' },
          { format: 'png', fromSurface: false },
          { format: 'png', fromSurface: false, captureBeyondViewport: true },
        ]
        try {
          await tick(bug.attach('1.3'), 3000, 'attach')
          attached = true
          try {
            await tick(bug.sendCommand('Page.enable'), 2000, 'enable')
          } catch (error) {
            notes.push('enable: ' + String(error?.message ?? error).slice(0, 60))
          }
          for (const shape of shapes) {
            try {
              const shot = await tick(bug.sendCommand('Page.captureScreenshot', shape), 8000, 'capture')
              const data = shot?.data
              if (typeof data === 'string' && data !== '') return data
              notes.push('debugger: no data ' + JSON.stringify(shape))
            } catch (error) {
              notes.push('debugger: ' + String(error?.message ?? error).slice(0, 70) + ' ' + JSON.stringify(shape))
            }
          }
        } catch (error) {
          notes.push('debugger: ' + String(error?.message ?? error).slice(0, 70))
        } finally {
          if (attached) bug.detach().catch(() => {})
        }
      }
      /* The window owns the view, so it can be read even when the app draws
         nothing there: ask the half that owns it before giving up. */
      try {
        el.scrollIntoView?.({ block: 'center', inline: 'nearest' }) // ui-copy-ignore
      } catch {
        /* a guest outside the scroller answers through its own capture */
      }
      const tries = []
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const image = await tick(el.capturePage(), 1200, 'panel')
          const empty = typeof image?.isEmpty === 'function' ? image.isEmpty() : false
          /* A data URL crosses the desktop bridge as a plain string; the PNG
             Buffer does not cross it at all. */
          const dataUrl = typeof image?.toDataURL === 'function' ? image.toDataURL() : ''
          const png = dataUrl.startsWith('data:') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : ''
          tries.push(attempt + ':' + (empty === true ? 'empty' : png.length + 'B'))
          if (empty !== true && png !== '') return png
        } catch (error) {
          tries.push(attempt + ':' + String(error?.message ?? error))
        }
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
      try {
        const chain = []
        let node = el
        for (let up = 0; up < 16 && node !== null; up += 1) {
          const box2 = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : { width: 0, height: 0 }
          const style = getComputedStyle(node)
          chain.push(String(node.tagName) + '.' + String(node.dataset?.open ?? '') + '.' + String(node.className ?? '').slice(0, 28) + ' '
            + Math.round(box2.width) + 'x' + Math.round(box2.height) + ' ' + style.display + '/' + style.visibility)
          node = node.parentElement
        }
        probe?.({ why: 'capture-empty', tries: tries.join(' '), chain, page: document.visibilityState })
      } catch {
        /* the error below still reports the geometry */
      }
      const box = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : {}
      throw new Error('no pixels (' + tries.join(' ') + '; rect=' + Math.round(box.width ?? 0) + 'x' + Math.round(box.height ?? 0)
        + ' offset=' + (el.offsetWidth ?? 0) + 'x' + (el.offsetHeight ?? 0) + ' connected=' + String(el.isConnected)
        + '; ' + notes.join('; ') + ')')
    }

    /**
     * Tell the Host this half is alive, and later what it managed to register. // ui-copy-ignore
     * Nothing else in the Client runs until a tab opens, so this is the only
     * proof the module itself executed.
     * @param {Record<string, unknown>} frame - what to report.
     */
    /**
     * Keep a chat's view laid out while it is not the one on screen.
     *
     * The app hides a view it is not showing, and a hidden guest paints nothing,
     * so a capture finds white there. This parks such a view out of sight at a
     * real size, which keeps the page painted and its state intact.
     */
    function parkHiddenViews() {
      if (document.getElementById('dshib-park') !== null) return
      const style = document.createElement('style')
      style.id = 'dshib-park'
      /* Inside the window, because a painter given no place inside it is never
         drawn: parked at a negative offset the page keeps its state but has no
         picture. Nearly clear, out of the way of clicks, and under the app's
         own surface, it paints without being seen. */
      const park = '{display:block !important;position:fixed !important;'
        + 'left:0 !important;top:0 !important;z-index:-1 !important;opacity:0.02 !important;'
        + 'pointer-events:none !important;width:var(--dshib-park-w,575px) !important;'
        + 'height:var(--dshib-park-h,1080px) !important;visibility:visible !important}'
      style.textContent = '[hidden]:has(.dshib-guest), .dshib-guest[hidden], .dshib-stash [hidden]' + park
      document.head.appendChild(style)
    }

    /**
     * Take that surface back.
     *
     * It is borrowed for one call and returned at the end of it: left in place,
     * it holds another chat's hidden view laid out in front of the app, which
     * grows a column that belongs to nobody.
     */
    function unparkHiddenViews() {
      document.getElementById('dshib-park')?.remove()
    }

    /** The injected pane face, reached from the capture path as well.
     *  @type {() => any} */
    let faceOf = () => undefined
    /** The pane's own way into its guest, for an address typed by hand. @type {Map<string, (url: string) => void>} */
    const steer = new Map()
    /** The page each chat last asked for; a reload leaves its guest at about:blank. @type {Map<string, string>} */
    const lastUrl = new Map()
    const pageKey = (session) => 'dshib:url:' + String(session ?? '')
    /** The page this chat was last told to open, remembered past a remount. */
    function rememberedPage(session) {
      const key = pageKey(session)
      try {
        const kept = window.localStorage.getItem(key)
        if (kept !== null && kept !== '') return kept
      } catch {
        /* storage is not always reachable; the in-memory map is enough */
      }
      return lastUrl.get(String(session ?? '')) ?? ''
    }
    function rememberPage(session, url) {
      lastUrl.set(String(session ?? ''), url)
      try {
        window.localStorage.setItem(pageKey(session), url)
      } catch {
        /* see rememberedPage */
      }
    }
    /** Puts this chat's pane on screen.
     *  @type {null | ((asking: string) => void)} */
    let reveal = null
    /* Re-asserting the pane is what survives another tab closing it. */
    let raise = null
    /* The log, not the error, carries why a capture found no pixels. */
    let probe = null
    let probed = false

    /** The chat whose sidebar pane is mounted here: a broadcast ask may only
     *  fall back to "the current chat" when this is the chat asking.
     *  @type {string} */
    let currentSession = ''

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
    /* The strip only mounts the tab it shows, so a chat that is not on screen has
       no page at all. This keeps one stashed guest per such chat, which is what
       lets a call work with nobody looking. */
    let keyForSession = null
    const residents = new Map()
    /* Chats whose own pane is open. Their pane owns the wire, so no stashed
       guest is made for them: two guests on one chat leave the wire pointing at
       whichever opened last, which is the one nobody can see. */
    const paneSessions = new Set()
    let stashNode = null

    /** @returns {HTMLElement} the container hidden guests live in. */
    function stashHost() {
      if (stashNode === null) {
        stashNode = document.createElement('div')
        stashNode.className = 'dshib-stash'
        stashNode.setAttribute('aria-hidden', 'true')
        document.body.appendChild(stashNode)
      }
      return stashNode
    }

    /** @param {string} sessionId - chat that has no mounted pane. @returns {void} */
    function keepResident(sessionId) {
      if (sessionId === '' || keyForSession === null || residents.has(sessionId)) return
      if (paneSessions.has(sessionId)) return
      beat({ tabType: true, phase: 'resident-open', session: sessionId })
      const guest = mountGuest({
        host: stashHost(), // ui-copy-ignore
        sessionId,
        key: () => keyForSession(sessionId),
        onPhase: (next, error) => beat({ tabType: true, phase: `resident-${next}`, session: sessionId, error: error ?? '' }),
      })
      residents.set(sessionId, guest)
    }

    /** @param {string} sessionId - chat whose pane took over. @returns {void} */
    function dropResident(sessionId) {
      const guest = residents.get(sessionId)
      if (guest === undefined) return
      residents.delete(sessionId)
      guest.dispose()
      beat({ tabType: true, phase: 'resident-drop', session: sessionId })
    }

    function mountGuest(options) {
      if (options.pane === true) paneSessions.add(options.sessionId)
      const carrier = globalThis.dshDesktop
      const bridge = carrier?.protocolVersion === 1 ? carrier.browser : undefined
      let disposed = false
      let lease
      let webview
      let cancel = () => {}

      const dispose = () => {
        disposed = true
        if (options.pane === true) paneSessions.delete(options.sessionId)
        steer.delete(options.sessionId)
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
          /* A tab that was closed on a page opens on that page again, without
             waiting for the chat to ask for anything. */
          const kept = rememberedPage(options.sessionId)
          if (kept !== '') {
            try {
              webview.loadURL(kept)
              probe?.({ why: 'reopen', url: kept })
            } catch (error) {
              probe?.({ why: 'reopen-failed', url: kept, error: String(error?.message ?? error).slice(0, 80) })
            }
          }
          steer.set(options.sessionId, (to) => {
            rememberPage(options.sessionId, to)
            try {
              webview.loadURL(to)
            } catch (error) {
              probe?.({ why: 'steer-failed', url: to, error: String(error?.message ?? error).slice(0, 80) })
            }
          })
          /* The pane shows which page it holds; the guest is the only one that
             knows, so it reports every navigation it makes. */
          const tellUrl = () => {
            try {
              const here = String(webview.getURL?.() ?? '')
              if (here !== '') options.onUrl?.(here)
            } catch { /* a guest mid-teardown has no URL */ }
          }
          webview.addEventListener('did-navigate', tellUrl)
          webview.addEventListener('did-navigate-in-page', tellUrl)
          tellUrl()

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
                  /* A view the app is not drawing has no surface, and a guest
                     without one runs no script. Give it a surface out of sight
                     first, and only bring the chat's tab forward as a second try. */
                  const room = () => webview.getBoundingClientRect()
                  const hidden = () => webview.hidden === true || webview.closest?.('[hidden]') !== null
                  if (hidden() || room().width < 2 || room().height < 2) {
                    parkHiddenViews()
                    for (let wait = 0; wait < 25; wait += 1) {
                      await new Promise((resolve) => setTimeout(resolve, 100))
                      if (room().width >= 2 && room().height >= 2) break
                      if (wait === 5) {
                        try {
                          reveal?.(String(frame.session ?? ''))
                        } catch {
                          /* the page stays where it is; the wait below reports it */
                        }
                      }
                    }
                    if (room().width < 2 || room().height < 2) {
                      reply({ ok: false, error: L('error.background') })
                      return
                    }
                  }
                  if (frame.tool !== 'navigate' && frame.tool !== 'shot') {
                    const asked = rememberedPage(frame.session)
                    let here = ''
                    let known = false
                    try {
                      here = String(webview.getURL?.() ?? '')
                      known = true
                    } catch {
                      /* a guest that cannot report its page is left alone */
                      known = false
                    }
                    /* Only a guest that says it is blank is reopened: reloading a
                       live page would throw away what the chat was looking at. */
                    const blank = known === true && (here === '' || here.startsWith('about:blank'))
                    if (blank === true && asked !== '') {
                      try {
                        await new Promise((resolve) => {
                          webview.addEventListener('did-stop-loading', () => resolve(), { once: true })
                          webview.loadURL(asked)
                          setTimeout(resolve, 20_000)
                        })
                        probe?.({ why: 'restore', url: asked })
                      } catch (error) {
                        probe?.({ why: 'restore-failed', url: asked, error: String(error?.message ?? error).slice(0, 80) })
                      }
                    }
                  }
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
                    const asked = String(frame.args?.url ?? '')
                    webview.loadURL(asked)
                    await stop
                    if (failed !== '') throw new Error(failed)
                    /* A page the chat asked for is the one the person wants to
                       watch, so it comes forward while the chat drives it. */
                    try {
                      reveal?.(String(frame.session ?? ''))
                    } catch {
                      /* the page loads behind; the answer still carries it */
                    }
                    rememberPage(frame.session, asked)
                    reply({ ok: true, value: await runIn(webview, 'view', {}) })
                    return
                  }
                  if (frame.tool === 'shot') {
                    let target = webview
                    /* The chat that asked is the only one whose page this call may
                       bring forward; anyone else keeps the view they are using. */
                    const asking = String(frame.session ?? '')
                    const mine = asking === '' || asking === currentSession || currentSession === ''
                    const colWide = () => {
                      const column = document.querySelector('[class*="rightbarCol"]')
                      if (column === null) return 'no-column'
                      const r = column.getBoundingClientRect()
                      return Math.round(r.width) + 'x' + Math.round(r.height)
                    }
                    const before = colWide()
                    const box = target.getBoundingClientRect()
                    const keepQuiet = frame.args?.offscreen === true
                    if (keepQuiet === false && (box.width < 2 || box.height < 2 || target.isConnected === false)) {
                      if (mine) {
                        try {
                          reveal?.(asking)
                        } catch {
                          /* the pane stays closed; the capture reports the geometry */
                        }
                      }
                      for (let wait = 0; wait < 12; wait += 1) {
                        await new Promise((resolve) => setTimeout(resolve, 150))
                        if (mine) raise?.(asking)
                        const live = options.host.querySelector('webview') // ui-copy-ignore
                        if (live !== null && live.getBoundingClientRect().width > 1) {
                          target = live // ui-copy-ignore
                          break
                        }
                      }
                    }
                    if (webview.hidden === true || webview.closest?.('[hidden]') !== null || webview.getBoundingClientRect().width < 2) {
                      parkHiddenViews()
                      try {
                        document.documentElement.style.setProperty('--dshib-park-w', '575px')
                        document.documentElement.style.setProperty('--dshib-park-h', '1080px')
                      } catch {
                        /* the rule keeps its own size */
                      }
                      for (let wait = 0; wait < 6; wait += 1) {
                        await new Promise((resolve) => setTimeout(resolve, 120))
                        if (webview.getBoundingClientRect().width > 1) {
                          target = webview
                          break
                        }
                      }
                      probe?.({ why: 'capture-parked', body: Math.round(target.getBoundingClientRect().width) })
                    }
                    const wide = colWide()
                    probe?.({ why: 'shot-geometry', columnBefore: before, columnAfter: wide, mine, tries: 'poll', ...surface(webview) })
                    if (target.getBoundingClientRect().width < 2 || target.getBoundingClientRect().height < 2) {
                      throw new Error("this chat's page is not on screen")
                    }
                    try {
                      reply({ ok: true, value: { png: await grab(target) } })
                      return
                    } catch (error) {
                      /* A page with a size can still produce no frames while it
                         is covered; parking it gives the surface one of its own. */
                      probe?.({ why: 'capture-retry', first: String(error?.message ?? error).slice(0, 90) })
                      const here = await webview.executeJavaScript('location.href', true).catch(() => '')
                      const remembered = rememberedPage(frame.session)
                      const href = String(here ?? '').startsWith('about:blank') === true ? remembered : String(here ?? '')
                      /* A page can keep its size and still be behind another tab of
                         this chat's pane: the app draws what it shows. Showing this
                         tab is what makes a surface, and it is what the image is of. */
                      try {
                        reveal?.(asking)
                      } catch {
                        /* the pane stays as it is; the second try reports it */
                      }
                      let shown = false
                      for (let wait = 0; wait < 10; wait += 1) {
                        await new Promise((resolve) => setTimeout(resolve, 120))
                        try {
                          raise?.(asking)
                        } catch {
                          /* keep polling */
                        }
                        if (webview.getBoundingClientRect().width > 1) shown = true
                      }
                      probe?.({ why: 'capture-show', href, shown, column: colWide() })
                      try {
                        const png = await grab(webview)
                        reply({ ok: true, value: { png } })
                        return
                      } catch (again) {
                        probe?.({ why: 'capture-covered', href, error: String(again?.message ?? again).slice(0, 400) })
                        throw new Error('this chat\'s page is not being drawn — bring its browser tab forward to take an image')
                      }
                    }
                  }
                  if (frame.tool === 'download') {
                    const id = 'dl-' + frame.id
                    const want = String(frame.args?.name ?? '')
                    let name = want
                    let next = null
                    try {
                      const opened = await runIn(webview, 'dl-open', {
                        id,
                        url: frame.args?.url, // ui-copy-ignore
                        ref: frame.args?.ref, // ui-copy-ignore
                        name: want, // ui-copy-ignore
                      })
                      name = String(opened?.name ?? (want === '' ? 'download' : want))
                      next = () => runIn(webview, 'dl-next', { id })
                    } catch (error) {
                      /* The page refused its own network; take the address and go
                         around it rather than telling the user to. */
                      const here = typeof frame.args?.url === 'string' && frame.args.url !== ''
                        ? frame.args.url
                        : await runIn(webview, 'href', { ref: frame.args?.ref })
                      const mine = await fetchHere(String(here), want)
                      name = mine.name
                      next = mine.next
                      probe?.({ why: 'download-half', href: String(here).slice(0, 120), error: String(error?.message ?? error).slice(0, 80) })
                    }
                    const ticket = String(frame.args?.ticket ?? '')
                    let offset = 0
                    let done = false
                    let landed = null
                    while (done === false) {
                      const part = await next()
                      const bytes = bytesOf(String(part?.data ?? ''))
                      done = part?.done === true
                      const answer = await fetch(
                        `${ROUTE}/grab?ticket=${encodeURIComponent(ticket)}&name=${encodeURIComponent(name)}` // ui-copy-ignore
                        + `&offset=${offset}&final=${done === true ? 1 : 0}`,
                        { method: 'POST', body: bytes },
                      )
                      landed = await answer.json().catch(() => null)
                      if (landed?.ok !== true) throw new Error(String(landed?.error ?? 'the file did not reach the folder'))
                      offset += bytes.length
                    }
                    const savedPath = String(landed?.path ?? '')
                    const savedBytes = Number(landed?.bytes ?? offset)
                    /* Both shapes travel: an older half reads the sentence, and
                       the half that saved the file reads the path. */
                    reply({
                      ok: true,
                      value: { text: `Saved ${savedPath} (${savedBytes} bytes)`, path: savedPath, bytes: savedBytes },
                    })
                    return
                  }
                  if (frame.tool === 'script') {
                    const body = String(frame.args?.code ?? '')
                    /* A bare script returns its completion value, so "1 + 1" and
                       "const a = 1; a + 1" both answer. Only code that needs a
                       function body — a top-level await or return — falls back
                       to the wrapper, because the wrapper hides completion. */
                    let result
                    try {
                      result = await webview.executeJavaScript(body, true)
                    } catch (error) {
                      /* Only a script that will not parse needs the wrapper;
                         a script that threw must keep the message it threw. */
                      const why = String(error?.message ?? error)
                      if (/SyntaxError|Unexpected (token|identifier|end)|await is only valid|Illegal return/i.test(why) !== true) throw error // ui-copy-ignore
                      result = await webview.executeJavaScript('(async () => {\n' + body + '\n})()', true)
                    }
                    const text = typeof result === 'string' ? result : JSON.stringify(result ?? null)
                    reply({ ok: true, value: text.slice(0, 8000) })
                    return
                  }
                  reply({ ok: true, value: await runIn(webview, frame.tool, frame.args ?? {}) })
                } catch (error) {
                  reply({ ok: false, error: String(error?.message ?? error) })
                } finally {
                  unparkHiddenViews()
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
      const [href, setHref] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [picked, setPicked] = React.useState('')
      React.useEffect(() => {
        if (host.current === null) return undefined // ui-copy-ignore
        currentSession = props.sessionId
        const guest = mountGuest({
          host: host.current, // ui-copy-ignore
          pane: true,
          sessionId: props.sessionId,
          key: props.workspace, // ui-copy-ignore
          onUrl: setHref,
          onPhase: (next, message) => { // ui-copy-ignore
            setPhase(next)
            if (next === 'ready') dropResident(props.sessionId)
            setError(message ?? '')
            beat({ tabType: true, phase: `guest-${next}`, session: props.sessionId, error: message ?? '' })
          },
        })
        return () => guest.dispose()
      }, [props.sessionId])
      React.useEffect(() => { setDraft(href) }, [href])
      /* A selection is read from the page while the pane is on screen, so the
         drag handle carries it without asking the page at drag time. */
      React.useEffect(() => {
        let live = true
        const tick = setInterval(() => {
          const el = host.current?.querySelector('webview') // ui-copy-ignore
          if (live !== true || !el || el.getBoundingClientRect().width < 2) return
          el.executeJavaScript('(() => String(window.getSelection() || "").slice(0, 4000))()', true)
            .then((text) => {
              if (live !== true) return
              const next = typeof text === 'string' ? text.trim() : ''
              setPicked((was) => {
                if (was !== next) probe({ phase: 'picked', len: next.length })
                return next
              })
            })
            .catch(() => {})
        }, 900)
        return () => {
          live = false
          clearInterval(tick)
        }
      }, [])
      const tone = phase === 'error' ? 'error' : phase === 'ready' ? 'ready' : 'opening'
      /* An address is only an address once it has a scheme; a bare host is a host. */ // ui-copy-ignore
      const open = () => {
        const typed = draft.trim()
        if (typed === '') return
        let to = typed
        if (/^[a-z][a-z0-9+.-]*:/i.test(typed) !== true) to = 'https://' + typed.replace(/^\/+/, '')
        try {
          new URL(to)
        } catch {
          return
        }
        steer.get(props.sessionId)?.(to)
      }
      return h('div', { className: 'dshib-body' }, [
        h('div', { key: 'state', className: 'dshib-state', 'data-tone': tone }, [
          h('span', { key: 'dot', className: 'dshib-dot' }),
          h('span', { key: 'text' }, error !== '' ? error : L(`phase.${phase}`)),
          h('input', {
            key: 'href',
            className: 'dshib-href',
            type: 'text', // ui-copy-ignore
            value: draft, // ui-copy-ignore
            title: href, // ui-copy-ignore
            placeholder: L('pane.address'), // ui-copy-ignore
            spellCheck: false, // ui-copy-ignore
            autoComplete: 'off', // ui-copy-ignore
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') open() },
          }),
          picked === '' ? null : h('span', {
            key: 'drag',
            className: 'dshib-drag',
            draggable: true,
            title: L('pane.dragHint'), // ui-copy-ignore
            onDragStart: (event) => {
              const data = event.dataTransfer
              if (data === null) return
              data.effectAllowed = 'copy'
              data.setData('text/plain', picked)
            },
          }, L('pane.drag')),
        ]),
        h('div', { key: 'host', ref: host, className: 'dshib-viewport' }), // ui-copy-ignore
      ])
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      /**
       * Register the tab type, its body, and its title.
       * @param {any} ctx - client plugin context.
       */
      apply(ctx) {
        let registered = false
        beat({ tabType: false, phase: 'loaded' })
        probe = (frame) => beat({ tabType: registered, ...frame }) // ui-copy-ignore
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
          /* The capture runs in another closure, so this lives at module scope. */
          faceOf = () => {
            try {
              return scope.sidebarRight
            } catch {
              return undefined
            }
          }
          /* A capture may be the first thing a chat asks for, so these exist from
             mount; before, only an ask could create them and a shot had nothing
             to call. */
          reveal = (asking) => {
            /* Another chat's page is never brought forward. */
            if (asking !== '' && asking !== currentSession && currentSession !== '') return
            try {
              scope.layout.openRightbar(true, false) // ui-copy-ignore
            } catch {
              /* nothing to open without a right pane */
            }
            try {
              /* A kept-mounted tab stays hidden behind the pane's active tab;
                 opening this kind brings it forward. */
              const face = faceOf()
              if (typeof face?.openTabIn === 'function') face.openTabIn(asking === '' ? currentSession : asking, KIND, {}) // ui-copy-ignore
              else if (typeof face?.openTab === 'function') face.openTab(KIND, {}) // ui-copy-ignore
            } catch {
              /* the capture reports the geometry it saw */
            }
          }
          raise = (asking) => {
            if (asking !== '' && asking !== currentSession && currentSession !== '') return
            try {
              scope.layout.openRightbar(true, false) // ui-copy-ignore
            } catch {
              /* the capture reports the geometry it saw */
            }
          }
          if (!probed) {
            probed = true
            try {
              const face = faceOf()
              beat({
                tabType: registered,
                phase: 'api',
                own: Object.keys(face ?? {}).slice(0, 16),
                proto: face === undefined ? [] : Object.getOwnPropertyNames(Object.getPrototypeOf(face)).slice(0, 24),
              })
            } catch {
              /* probed once per page load */
            }
          }
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
              /* `layout` is in this plugin's inject list; a scope that lists it
                 alone still cannot read it, which is why the pane never opened.
                 Only the chat on screen may open the pane: another chat keeps
                 whatever the person is looking at. */
              /* The pane may open for the chat that asked; a chat that is not on
                 screen still gets its own page, never someone else's. */
              if (sessionId === currentSession || currentSession === '') scope.layout.openRightbar(true, false) // ui-copy-ignore
            } catch (error) {
              beat({ tabType: registered, phase: 'open', step: 'rightbar', error: String(error?.message ?? error) })
            }
            /* The current chat is the one place a page may open a tab without an id;
               the id path is the fallback for a page showing another chat. */
            let opened = ''
            const strip = scope.sidebarRight
            if (!probed) {
              probed = true
              try {
                beat({
                  tabType: registered,
                  phase: 'api',
                  own: Object.keys(strip ?? {}).slice(0, 16),
                  proto: strip === undefined ? [] : Object.getOwnPropertyNames(Object.getPrototypeOf(strip)).slice(0, 24),
                })
              } catch {
                /* probed once per page load */
              }
            }
            /* Every open page hears this broadcast, so a page must open the
               asking chat's tab by id. Opening "the current chat" instead is how
               one chat's call used to steer a browser tab in another chat. */
            /* A chat's own pane already holds the page. Opening the tab again
               rebuilds it, which closes the page a call is about to use. */
            if (paneSessions.has(sessionId)) {
              opened = 'kept'
            } else if (typeof strip?.openTabIn === 'function') {
              try {
                strip.openTabIn(sessionId, KIND, {}) // ui-copy-ignore
                opened = 'session'
              } catch (error) {
                opened = `failed: ${String(error?.message ?? error)}`
              }
            }
            if (opened === '' && currentSession === sessionId && typeof strip?.openTab === 'function') {
              try {
                strip.openTab(KIND, {}) // ui-copy-ignore
                opened = 'current'
              } catch (error) {
                opened = `failed: ${String(error?.message ?? error)}`
              }
            }
            beat({ tabType: registered, phase: 'open', opened, session: sessionId })
            keepResident(sessionId)
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
          keyForSession = (sessionId) => workspaceKey(workspaces, sessionId)
          scope.effect(() => tabs.register({
            id: ID, // ui-copy-ignore
            kind: KIND, // ui-copy-ignore
            multiple: false, // ui-copy-ignore
            keepMounted: true,
            title: () => L('type.label'),
            description: () => L('guide.description'),
            /* The guide page lists one card per registered type; without this the
               column has no door to this tab. */
            guide: [{ id: KIND, title: () => L('type.label'), description: () => L('guide.description'), order: 60 }],
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
