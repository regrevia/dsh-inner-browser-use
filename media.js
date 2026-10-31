/**
 * Media a page plays, and the way to the file behind it.
 *
 * yt-dlp solves this by teaching itself every site. The page already knows
 * better than any list: it asked for the file, and this browser saw the
 * request. So the sniffing half is free — the network log this plugin already
 * keeps says which URL is the movie — and the rest is playlist arithmetic:
 * a master playlist names its variants, a media playlist names its segments,
 * and the segments are plain HTTP with the cookies the page already has.
 *
 * Nothing here touches the disk or the network: parsing and planning are pure,
 * so they are the part that can be tested without a page.
 */

/** A mime that means "this is the movie itself", not a page about it. */
const FILE_MIME = /^(video|audio)\/|^application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|octet-stream)$/i

/** A URL that ends like a file a player would stream. */
const FILE_PATH = /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|flv|ts|m4s|mp3|m4a|aac|ogg|opus|wav)(\?|#|$)/i

/** Same-origin noise that sniffing must not report as a movie. */
const NOT_MEDIA = /\.(m3u8|mpd|mp4|webm|mov|flv|ts|m4s|mp3|m4a|aac|ogg|opus|wav)\b|^data:|^blob:/i

/**
 * Is this request something a person would call a video or a song?
 * @param {string} url - request URL.
 * @param {string} [mime] - response mime, when known.
 * @param {string} [type] - CDP resource type, when known.
 * @returns {boolean} true when it is worth listing.
 */
export function isMedia(url, mime = '', type = '') {
  const at = String(url ?? '')
  const said = String(mime ?? '').toLowerCase()
  if (at === '' || at.startsWith('data:') || at.startsWith('blob:')) return false
  if (said.startsWith('image/') || said.startsWith('font/') || said.startsWith('text/html') || said.includes('javascript') || said.includes('css')) return false
  if (said === 'application/json' || said.startsWith('application/json')) return false
  if (FILE_MIME.test(said)) return true
  if (String(type ?? '') === 'Media') return true
  return FILE_PATH.test(at) && !/\.(html?|php|aspx?)$/i.test(at)
}

/**
 * Which word a person would use for it.
 * @param {string} url - request URL.
 * @param {string} [mime] - response mime.
 * @returns {'video'|'audio'|'stream'|'file'} the kind.
 */
export function kindOf(url, mime = '') {
  const said = String(mime ?? '').toLowerCase()
  const at = String(url ?? '')
  if (/mpegurl|dash\+xml/.test(said) || /\.(m3u8|mpd)(\?|#|$)/i.test(at)) return 'stream'
  if (said.startsWith('audio/')) return 'audio'
  if (/\.(mp3|m4a|aac|ogg|opus|wav)(\?|#|$)/i.test(at)) return 'audio'
  if (said.startsWith('video/') || /\.(mp4|m4v|webm|mkv|mov|flv|ts|m4s)(\?|#|$)/i.test(at)) return 'video'
  return 'file'
}

/**
 * Turn the relative parts of a playlist into addresses that can be fetched.
 * @param {string} base - the playlist's own URL.
 * @param {string} href - a line from it.
 * @returns {string} absolute URL, or '' when it is a comment.
 */
export function absoluteUrl(base, href) {
  const line = String(href ?? '').trim()
  if (line === '' || line.startsWith('#')) return ''
  try {
    return new URL(line, base).toString()
  } catch {
    return ''
  }
}

/**
 * Read the attributes on one `#EXT-X-STREAM-INF:` line.
 * @param {string} line - the tag line.
 * @returns {{bandwidth: number, width: number, height: number, codecs: string}} what it says.
 */
export function streamInfo(line) {
  const text = String(line ?? '')
  const number = (name) => {
    const found = new RegExp(`${name}=(\\d+)`, 'i').exec(text)
    return found === null ? 0 : Number(found[1])
  }
  const size = /RESOLUTION=(\d+)x(\d+)/i.exec(text)
  const codecs = /CODECS="([^"]*)"/i.exec(text)
  return {
    bandwidth: number('BANDWIDTH') || number('AVERAGE-BANDWIDTH'),
    width: size === null ? 0 : Number(size[1]),
    height: size === null ? 0 : Number(size[2]),
    codecs: codecs === null ? '' : String(codecs[1]).slice(0, 40),
  }
}

/**
 * A master playlist is a menu of the same movie at different sizes.
 * @param {string} text - playlist body.
 * @param {string} base - playlist URL.
 * @returns {Array<{bandwidth: number, width: number, height: number, codecs: string, url: string}>} variants, best first.
 */
export function parseMaster(text, base) {
  const lines = String(text ?? '').split(/\r?\n/)
  const variants = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line.toUpperCase().startsWith('#EXT-X-STREAM-INF')) continue
    const info = streamInfo(line)
    let at = i + 1
    while (at < lines.length && (lines[at].trim() === '' || lines[at].trim().startsWith('#'))) at += 1
    const url = at < lines.length ? absoluteUrl(base, lines[at]) : ''
    if (url === '') continue
    variants.push({ ...info, url })
    i = at
  }
  variants.sort((left, right) => (right.bandwidth || right.height) - (left.bandwidth || left.height))
  return variants
}

/**
 * A media playlist is the movie cut into pieces.
 * @param {string} text - playlist body.
 * @param {string} base - playlist URL.
 * @returns {{segments: string[], init: string, duration: number, encrypted: boolean}} the pieces and what they need first.
 */
export function parsePlaylist(text, base) {
  const lines = String(text ?? '').split(/\r?\n/)
  const segments = []
  let init = ''
  let duration = 0
  let encrypted = false
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('#EXTINF:')) duration += Number.parseFloat(line.slice(8)) || 0
    else if (line.toUpperCase().startsWith('#EXT-X-MAP')) {
      const found = /URI="([^"]+)"/i.exec(line)
      if (found !== null) init = absoluteUrl(base, found[1])
    } else if (line.toUpperCase().startsWith('#EXT-X-KEY')) {
      if (!/METHOD=NONE/i.test(line)) encrypted = true
    } else if (!line.startsWith('#')) {
      const url = absoluteUrl(base, line)
      if (url !== '') segments.push(url)
    }
  }
  return { segments, init, duration: Math.round(duration), encrypted }
}

/**
 * Which playlist this body is.
 * @param {string} text - playlist body.
 * @returns {'master'|'media'|null} the kind.
 */
export function playlistKind(text) {
  const body = String(text ?? '')
  if (!body.trimStart().startsWith('#EXTM3U')) return null
  if (/#EXT-X-STREAM-INF/i.test(body)) return 'master'
  return 'media'
}

/**
 * The one variant a person would want: tall enough to be worth watching,
 * cheap enough to fetch. A high one is never the answer to "save this".
 * @param {Array<{bandwidth: number, width: number, height: number, url: string}>} variants - from parseMaster.
 * @param {{height?: number, bandwidth?: number}} [wanted] - caps.
 * @returns {{bandwidth: number, width: number, height: number, url: string}|null} the pick.
 */
export function pickVariant(variants, wanted = {}) {
  const list = (variants ?? []).filter((each) => each !== null && typeof each === 'object' && String(each.url ?? '') !== '')
  if (list.length === 0) return null
  const capHeight = Number(wanted.height ?? 0)
  const capBandwidth = Number(wanted.bandwidth ?? 0)
  let allowed = list
  if (capHeight > 0) allowed = list.filter((each) => (each.height || 0) <= capHeight)
  if (capBandwidth > 0) allowed = allowed.filter((each) => (each.bandwidth || 0) <= capBandwidth)
  /* A cap nobody fits is not an empty answer: the smallest is still better
     than nothing. */
  if (allowed.length === 0) allowed = [...list].sort((left, right) => (left.bandwidth || left.height) - (right.bandwidth || right.height)).slice(0, 1)
  return allowed.slice().sort((left, right) => (right.bandwidth || right.height) - (left.bandwidth || left.height))[0]
}

/**
 * Follow a manifest down to the URLs that hold bytes.
 * @param {string} url - what the page asked for.
 * @param {string} body - what came back.
 * @param {{height?: number, bandwidth?: number}} [wanted] - size cap.
 * @returns {{kind: 'file'|'hls', parts: string[], init: string, duration: number, variant: object|null, encrypted: boolean}} what to fetch.
 */
export function planOf(url, body, wanted = {}) {
  const kind = playlistKind(body)
  if (kind === 'master') {
    const variant = pickVariant(parseMaster(body, url), wanted)
    return { kind: 'hls', parts: [], init: '', duration: 0, variant, encrypted: false }
  }
  if (kind === 'media') {
    const list = parsePlaylist(body, url)
    return { kind: 'hls', parts: list.segments, init: list.init, duration: list.duration, variant: null, encrypted: list.encrypted }
  }
  return { kind: 'file', parts: [url], init: '', duration: 0, variant: null, encrypted: false }
}

/**
 * Fetch many URLs, but only a few at a time: a hundred segments asked for at
 * once is a hundred sockets and a server that starts refusing.
 * @template T
 * @param {string[]} urls - in order.
 * @param {(url: string) => Promise<T>} get - one URL.
 * @param {number} [width] - how many at once.
 * @returns {Promise<T[]>} in the same order as the input.
 */
export async function gather(urls, get, width = 6) {
  const out = new Array(urls.length)
  let next = 0
  const take = async () => {
    for (;;) {
      const at = next
      next += 1
      if (at >= urls.length) return
      out[at] = await get(urls[at])
    }
  }
  const taking = []
  for (let i = 0; i < Math.max(1, Math.min(width, urls.length)); i += 1) taking.push(take())
  await Promise.all(taking)
  return out
}

/**
 * How a person would see the size of a pile of bytes.
 * @param {number} bytes - byte count.
 * @returns {string} "12 MB" and the like.
 */
export function sizeText(bytes) {
  const n = Number(bytes ?? 0)
  if (!(n > 0)) return '?'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)} GB`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`
  if (n >= 1000) return `${Math.round(n / 1000)} kB`
  return `${String(n)} B`
}
