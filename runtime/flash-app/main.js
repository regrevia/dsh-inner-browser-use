/* The one job of this app: open a window Chromium will render, and let the
   sidecar drive it over the debugging port. The Flash plugin arrives from the
   sidecar's environment and is appended to the command line here, because
   Electron only honours these switches when they are set before Chromium
   starts. */
const { app, BrowserWindow, Menu } = require('electron')
const http = require('http')
const env = process.env

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
        latestJpeg = image.toJPEG(Number(env.DSH_FLASH_JPEG_QUALITY || 72))
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
        latestJpeg = image.toJPEG(Number(env.DSH_FLASH_JPEG_QUALITY || 72))
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
        /* The column is a tall, narrow pane: a 16:10 window letterboxes the
           game into a strip. Resizing the window to the pane makes the picture
           fill it and the JPEG smaller, since capture is window-sized. */
        try {
          const size = new URL(request.url, 'http://x').searchParams
          const width = Math.max(200, Math.min(2560, Number(size.get('w') || 0)))
          const height = Math.max(200, Math.min(2560, Number(size.get('h') || 0)))
          if (Number.isFinite(width) && Number.isFinite(height)) {
            if (alive(capture) !== true) { response.writeHead(503); response.end(); return }
            capture.setBounds({ x: -3000, y: -3000, width: Math.round(width), height: Math.round(height) })
          }
          const bounds = capture.getBounds()
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ bounds }))
        } catch {
          response.writeHead(500).end()
        }
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
          capture.webContents.sendInputEvent(event)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{"ok":true}')
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
        if (jpeg === null || (asked > 0 && asked !== Number(env.DSH_FLASH_JPEG_QUALITY || 72))) {
          const image = latest !== null ? latest : alive(capture) === true ? await capture.webContents.capturePage() : null
          if (image === null) { response.writeHead(503); response.end(); return }
          jpeg = image.toJPEG(asked > 0 ? asked : Number(env.DSH_FLASH_JPEG_QUALITY || 72))
        }
        response.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpeg.length }) // ui-copy-ignore
        response.end(jpeg)
      } catch {
        response.writeHead(503).end()
      }
    }).listen(port, '127.0.0.1')
  }
})
