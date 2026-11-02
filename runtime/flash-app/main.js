/* The one job of this app: open a window Chromium will render, and let the
   sidecar drive it over the debugging port. The Flash plugin arrives from the
   sidecar's environment and is appended to the command line here, because
   Electron only honours these switches when they are set before Chromium
   starts. */
const { app, BrowserWindow, Menu } = require('electron')
const http = require('http')
const env = process.env

/* How many device pixels one CSS pixel of the game becomes. The pane is drawn
   on a high-density screen, so one-to-one arrives already enlarged and soft. */
function flashQuality() {
  const asked = Number(env.DSH_FLASH_JPEG_QUALITY ?? 84)
  if (!Number.isFinite(asked) || asked < 40 || asked > 100) return 84
  return Math.round(asked)
}

function flashScale() {
  const asked = Number(env.DSH_FLASH_SCALE ?? 2)
  if (!Number.isFinite(asked) || asked < 1 || asked > 3) return 2
  return asked
}

app.commandLine.appendSwitch('use-mock-keychain')
app.commandLine.appendSwitch('lang', 'zh-CN')
app.commandLine.appendSwitch('password-store', 'basic')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
/* A plugin paints on its own surface, and a GPU-composited surface does not
   reach the screencast; software compositing puts it back in the page bitmap. */
if (env.DSH_FLASH_SOFTWARE === '1') {
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('in-process-gpu')
}
if (env.DSH_FLASH_PORT) app.commandLine.appendSwitch('remote-debugging-port', env.DSH_FLASH_PORT)
if (env.DSH_FLASH_UDD) app.commandLine.appendSwitch('user-data-dir', env.DSH_FLASH_UDD)
if (env.DSH_FLASH_PLUGIN) {
  app.commandLine.appendSwitch('ppapi-flash-path', env.DSH_FLASH_PLUGIN)
  app.commandLine.appendSwitch('ppapi-flash-version', env.DSH_FLASH_VERSION || '32.0.0.371')
  app.commandLine.appendSwitch('allow-outdated-plugins')
  /* The plugin process is sandboxed in a way that cannot open a plugin living
     outside the app bundle: it fails with "file system sandbox blocked open()"
     and the page then reports no usable Flash. This app renders one page we
     name ourselves, so it does not need that sandbox. */
  app.commandLine.appendSwitch('no-sandbox')
}

app.on('window-all-closed', () => {
  /* A closed window is the person closing the mirror, not the app's business. */
})

/* A plugin paints on a surface the debugging protocol's screencast does not
   see, so the app hands out its own frames over a loopback port. */
let capture = null
let latest = null
/* A plugin surface cannot be screencast, so this app is the capture source.
   Capturing inside the request would make the picture cost the poll interval
   plus the capture itself; a pump keeps one JPEG ready and requests return it. */
let latestJpeg = null
let latestAt = 0
let pumping = false
let pumpTimer = 0
let painted = 0

/* A game is rarely the size of the page: it is one fixed box on a page that
   leaves the rest white. Framing the window to the column therefore puts the
   game in a corner of an empty canvas, and whatever lies below the page's own
   height comes back as black padding. The picture to hand out is the box the
   game actually occupies, so measure it and frame that. */
const BOX_SCRIPT = `(() => {
  let best = { width: 0, height: 0 }
  for (const node of document.querySelectorAll('embed,object,iframe,canvas,video')) {
    const box = node.getBoundingClientRect()
    if (box.width * box.height > best.width * best.height) best = { width: box.width, height: box.height }
  }
  if (!(best.width >= 120) || !(best.height >= 120)) return null
  return { width: Math.round(best.width), height: Math.round(best.height) }
})()`

let debugAttached = false

/* Resizing an offscreen window does not relayout the page inside it: the page
   keeps the size it was created with. Emulating the viewport is the one way to
   tell it how big the column is, and a page that cannot be told keeps its own
   layout, which the box measurement still frames correctly. */
async function emulate(width, height) {
  if (alive(capture) !== true) return false
  try {
    if (debugAttached !== true) {
      capture.webContents.debugger.attach('1.3')
      debugAttached = true
    }
    await capture.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: flashScale(),
      mobile: false, // ui-copy-ignore
    })
    return true
  } catch {
    debugAttached = false
    return false
  }
}

async function contentBox() {
  if (alive(capture) !== true) return null
  try {
    const box = await capture.webContents.executeJavaScript(BOX_SCRIPT, true)
    if (box === null || box === undefined) return null
    return { width: Number(box.width), height: Number(box.height) }
  } catch {
    return null
  }
}

function alive(win) {
  try {
    return win !== null && win !== undefined && win.isDestroyed() !== true
  } catch {
    return false
  }
}

/* A timer is its own fault domain: a window that closed between ticks must end
   the pump, not throw into the app's process. */
function pump() {
  /* Offscreen rendering already hands every frame over in its paint callback;
     a screenshot pump on top of it could only write a staler picture back. */
  if (painted > 0) {
    if (pumpTimer !== 0) clearInterval(pumpTimer)
    pumpTimer = 0
    return
  }
  if (pumping === true) return
  if (alive(capture) !== true) {
    if (pumpTimer !== 0) clearInterval(pumpTimer)
    pumpTimer = 0
    return
  }
  pumping = true
  try {
    capture.webContents.capturePage()
      .then((image) => {
        if (alive(capture) !== true) return
        latest = image
        latestJpeg = image.toJPEG(flashQuality())
        latestAt = Date.now()
      })
      .catch(() => {})
      .finally(() => { pumping = false })
  } catch {
    pumping = false
  }
}

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    x: -3000,
    y: -3000,
    /* Never a window on anybody's screen: the picture belongs in the column
       that asked for it, and a game window parked off to the side is exactly
       what this must not add to the desktop. */
    show: false,
    /* Without this macOS pulls a window placed past the edge of the screen back
       onto it; the window is meant to stay where nobody can see it. */
    enableLargerThanScreen: true,
    frame: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      plugins: true,
      backgroundThrottling: false,
      contextIsolation: true,
      /* macOS does not paint a window nobody can see, which used to force this
         app to put a real game window on the desktop. Offscreen rendering
         paints into a bitmap instead, so the page exists only in the column. */
      offscreen: true,
      useSharedTexture: false,
      paintWhenInitiallyHidden: true,
    },
  })
  capture = window
  /* The Dock wanted to show this as a running app; the only thing it runs is
     the picture in someone's column. */
  if (app.dock !== undefined && app.dock !== null) app.dock.hide()
  /* A running app with a menu puts its name in the menu bar the moment macOS
     activates it, which is a second way for this to appear on someone's
     desktop. No menu, and an accessory app: only the picture in the column. */
  Menu.setApplicationMenu(null)
  if (typeof app.setActivationPolicy === 'function') app.setActivationPolicy('accessory')
  /* Offscreen frames arrive here; nothing is ever shown on a display. A paint
     callback is its own fault domain: one failed frame must not end the app. */
  try {
    window.webContents.setFrameRate(Number(env.DSH_FLASH_FRAME_RATE || 30))
    window.webContents.on('paint', (event, dirty, image) => {
      try {
        latest = image
        latestJpeg = image.toJPEG(flashQuality())
        latestAt = Date.now()
        painted += 1
      } catch {
        /* a frame that cannot be encoded is skipped; the next one may work */
      }
    })
  } catch {
    /* an Electron without offscreen painting falls back to the capture pump */
  }
  window.loadURL(env.DSH_FLASH_URL || 'about:blank')
  /* Faster than the sidecar asks: it then always finds a fresh picture. */
  pumpTimer = setInterval(pump, Number(env.DSH_FLASH_PUMP_MS || 40))

  let windowScale = flashScale()
  const port = Number(env.DSH_FLASH_BRIDGE_PORT || 0)
  if (port > 0) {
    http.createServer(async (request, response) => {
      if (capture === null || !request.url) {
        response.writeHead(404).end()
        return
      }
      if (request.url.startsWith('/info')) {
        const size = latest === null ? null : latest.getSize()
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ size, age: latestAt === 0 ? null : Date.now() - latestAt, visible: capture.isVisible(), opacity: capture.getOpacity(), painted, bounds: capture.getBounds(), url: capture.webContents.getURL(), title: capture.webContents.getTitle() }))
        return
      }
      if (request.url.startsWith('/resize')) {
        /* The column asked for a shape; the game has one of its own. Lay the
           page out at the column, then hand back a window framed on the game,
           so the picture has the game's proportions and no empty canvas. */
        try {
          const size = new URL(request.url, 'http://x').searchParams
          const want = {
            width: Math.max(200, Math.min(2560, Number(size.get('w') || 0))),
            height: Math.max(200, Math.min(2560, Number(size.get('h') || 0))),
          }
          if (!Number.isFinite(want.width) || !Number.isFinite(want.height)) { response.writeHead(400).end(); return }
          if (alive(capture) !== true) { response.writeHead(503).end(); return }
          await emulate(want.width, want.height)
          const box = await contentBox()
          const frame = box === null ? want : box
          const width = Math.max(200, Math.min(2560, Math.round(frame.width)))
          const height = Math.max(200, Math.min(2560, Math.round(frame.height)))
          /* The window owns the pixels, the page owns the layout: give the
             window `scale` times the game's shape so the picture the pane gets
             is crisp, and keep the game laid out at its own size. */
          windowScale = flashScale()
          capture.setBounds({ x: -3000, y: -3000, width: Math.round(width * windowScale), height: Math.round(height * windowScale) })
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ bounds: { x: -3000, y: -3000, width, height }, window: capture.getBounds(), scale: windowScale, viewport: want, content: box }))
        } catch {
          response.writeHead(500).end()
        }
        return
      }
      if (request.url.startsWith('/shutdown')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ closing: true }))
        /* Let the reply leave before the app goes down. */
        setTimeout(() => app.quit(), 60).unref?.()
        return
      }
      if (request.url.startsWith('/input')) {
        /* Input goes straight into the page instead of round-tripping through
           the debugging protocol: a press arrives in a few milliseconds, and a
           game that reads its mouse every frame is not left behind. */
        try {
          if (request.method !== 'POST') { response.writeHead(405).end(); return }
          const chunks = []
          let bytes = 0
          for await (const chunk of request) {
            bytes += chunk.length
            if (bytes > 8192) { response.writeHead(413).end(); return }
            chunks.push(chunk)
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          if (alive(capture) !== true) { response.writeHead(503).end(); return }
          const event = {}
          for (const field of ['type', 'x', 'y', 'button', 'clickCount', 'deltaX', 'deltaY', 'keyCode', 'modifiers']) {
            if (body[field] !== undefined && body[field] !== null) event[field] = body[field]
          }
          if (typeof event.type !== 'string' || event.type === '') { response.writeHead(400).end(); return }
          /* Points arrive in the game's own pixels; the window holds `scale`
             times as many. */
          for (const axis of ['x', 'y']) {
            if (typeof event[axis] === 'number') event[axis] = Math.round(event[axis] * windowScale)
          }
          capture.webContents.sendInputEvent(event)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{"ok":true}')
        } catch {
          response.writeHead(500).end()
        }
        return
      }
      if (request.url.startsWith('/sound')) {
        /* The column's sound button: a game's music belongs to whoever asked
           for it, and it starts off. */
        try {
          let body = ''
          for await (const chunk of request) body += chunk
          const on = JSON.parse(body === '' ? '{}' : body).on === true
          for (const win of [capture, window]) {
            if (win !== null && win !== undefined) win.webContents.setAudioMuted(on !== true)
          }
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: true, muted: on !== true }))
        } catch {
          response.writeHead(500).end()
        }
        return
      }
      if (!request.url.startsWith('/frame')) {
        response.writeHead(404).end()
        return
      }
      try {
        const asked = Number(new URL(request.url, 'http://x').searchParams.get('q') || 0) // ui-copy-ignore
        let jpeg = latestJpeg
        if (jpeg === null || (asked > 0 && asked !== flashQuality())) {
          const image = latest !== null ? latest : alive(capture) === true ? await capture.webContents.capturePage() : null
          if (image === null) { response.writeHead(503); response.end(); return }
          jpeg = image.toJPEG(asked > 0 ? asked : flashQuality())
        }
        response.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpeg.length }) // ui-copy-ignore
        response.end(jpeg)
      } catch {
        response.writeHead(503).end()
      }
    }).listen(port, '127.0.0.1')
  }
})
