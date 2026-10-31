import test from 'node:test'
import assert from 'node:assert/strict'

import { adLike, coreScore, coreRows, isMedia, kindOf, parseMaster, pickVariant, parsePlaylist, playlistKind, planOf, gather } from '../media.js?m=1'
import { SidecarPage } from '../sidecar.js?v=1'

const master = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
  '720/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1920x1080',
  '1080/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=120000,RESOLUTION=640x360',
  'https://cdn.example.com/360/index.m3u8',
].join('\n')

test('a master playlist is read as sizes of the same movie, best first', () => {
  const variants = parseMaster(master, 'https://cdn.example.com/show/master.m3u8')
  assert.deepEqual(variants.map((each) => each.height), [1080, 720, 360])
  assert.equal(variants[0].url, 'https://cdn.example.com/show/1080/index.m3u8')
  assert.equal(variants[2].url, 'https://cdn.example.com/360/index.m3u8')
  assert.equal(variants[1].codecs, 'avc1.4d401f,mp4a.40.2')
})

test('saving a stream takes the tallest version under the cap, never the largest', () => {
  const variants = parseMaster(master, 'https://cdn.example.com/show/master.m3u8')
  assert.equal(pickVariant(variants, { height: 720 }).height, 720)
  assert.equal(pickVariant(variants, { height: 2000 }).height, 1080)
  /* Nobody under the cap: the smallest is still the sensible answer. */
  assert.equal(pickVariant(variants, { height: 100 }).height, 360)
  assert.equal(pickVariant([], {}), null)
})

test('a media playlist names its pieces, in order, plus the header piece', () => {
  const body = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:4.0,',
    'seg-1.m4s',
    '#EXTINF:3.5,',
    'https://cdn.example.com/seg-2.m4s',
    '#EXT-X-ENDLIST',
  ].join('\n')
  const list = parsePlaylist(body, 'https://cdn.example.com/path/stream.m3u8')
  assert.deepEqual(list.segments, ['https://cdn.example.com/path/seg-1.m4s', 'https://cdn.example.com/seg-2.m4s'])
  assert.equal(list.init, 'https://cdn.example.com/path/init.mp4')
  assert.equal(list.duration, 8)
  assert.equal(list.encrypted, false)
  assert.equal(playlistKind(body), 'media')
  assert.equal(playlistKind(master), 'master')
  assert.equal(playlistKind('<html>'), null)
})

test('an encrypted playlist is planned but flagged, so nothing is saved half a movie', () => {
  const body = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\na.ts\n'
  const plan = planOf('https://cdn.example.com/a.m3u8', body, {})
  assert.equal(plan.kind, 'hls')
  assert.equal(plan.encrypted, true)
  assert.deepEqual(plan.parts, ['https://cdn.example.com/a.ts'])
})

test('a master playlist is followed to the version, and a plain file is its own plan', () => {
  const plan = planOf('https://cdn.example.com/show/master.m3u8', master, { height: 720 })
  assert.equal(plan.kind, 'hls')
  assert.equal(plan.variant.height, 720)
  const file = planOf('https://cdn.example.com/movie.mp4', '', {})
  assert.equal(file.kind, 'file')
  assert.deepEqual(file.parts, ['https://cdn.example.com/movie.mp4'])
})

test('only a movie request is media, and its kind says which', () => {
  assert.equal(isMedia('https://a/x.m3u8', '', ''), true)
  assert.equal(isMedia('https://a/x.mp4', 'video/mp4', 'Media'), true)
  assert.equal(isMedia('https://a/track', 'audio/mpeg', 'Media'), true)
  assert.equal(isMedia('https://a/page', 'text/html', 'Document'), false)
  assert.equal(isMedia('https://a/logo.png', 'image/png', ''), false)
  assert.equal(isMedia('https://a/app.js', 'application/javascript', 'Script'), false)
  assert.equal(isMedia('blob:https://a/123', 'video/mp4', 'Media'), false)
  assert.equal(kindOf('https://a/x.m3u8', ''), 'stream')
  assert.equal(kindOf('https://a/x.mp3', ''), 'audio')
  assert.equal(kindOf('https://a/x.webm', ''), 'video')
})

test('a hundred pieces are fetched a few at a time and come back in order', async () => {
  let live = 0
  let most = 0
  const urls = Array.from({ length: 40 }, (_, at) => `p${String(at)}`)
  const out = await gather(urls, async (url) => {
    live += 1
    most = Math.max(most, live)
    await new Promise((done) => setTimeout(done, 2))
    live -= 1
    return url.toUpperCase()
  }, 5)
  assert.deepEqual(out, urls.map((each) => each.toUpperCase()))
  assert.ok(most <= 5, `never more than five at once, saw ${String(most)}`)
})

test('the browser remembers what a page played, once per address, newest first', () => {
  const fake = Object.create(SidecarPage.prototype)
  fake.media = new Map()
  fake.troubleSeq = 1
  const say = (id, url, mime, type = 'Media') => fake.noteMedia({
    requestId: id,
    type,
    response: { url, mimeType: mime, status: 200, headers: { 'content-length': '4242' }, encodedDataLength: 0 },
  })
  say('1', 'https://a/movie.mp4', 'video/mp4')
  say('2', 'https://a/song.mp3', 'audio/mpeg')
  say('3', 'https://a/logo.png', 'image/png')
  say('4', 'https://a/movie.mp4?again', 'video/mp4')
  say('5', 'https://a/movie.mp4', 'video/mp4')
  const rows = fake.mediaList()
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((each) => each.url).sort(), [
    'https://a/movie.mp4',
    'https://a/movie.mp4?again',
    'https://a/song.mp3',
  ])
  assert.equal(rows.find((each) => each.url === 'https://a/movie.mp4').bytes, 4242)
  assert.equal(rows.find((each) => each.url === 'https://a/song.mp3').kind, 'audio')
  assert.equal(rows.some((each) => each.url.endsWith('.png')), false)
})

test('an ad is recognised by its own address, not by being big', async () => {
  const { adLike } = await import('../media.js?m=2')
  assert.equal(adLike('https://ads.example.com/preroll.mp4'), true)
  assert.equal(adLike('https://example.com/ads/house.mp4'), true)
  assert.equal(adLike('https://example.com/px/tracking.gif'), true)
  assert.equal(adLike('https://securepubads.g.doubleclick.net/gampad/ads?x=1'), true)
  assert.equal(adLike('https://example.com/v/adventure-final.mp4'), false)
  assert.equal(adLike('https://example.com/media/movie.mp4'), false)
  assert.equal(adLike('https://example.com/render/adam.mp4'), false)
})

test('the player on the page comes first, ads and beacons last', async () => {
  const { coreRows } = await import('../media.js?m=2')
  const rows = [
    { url: 'https://example.com/ads/pre.mp4', kind: 'video', mime: 'video/mp4', bytes: 9_000_000, seq: 1 },
    { url: 'https://example.com/px/beacon.mp4', kind: 'video', mime: 'video/mp4', bytes: 800, seq: 2 },
    { url: 'https://example.com/poster-loop.mp4', kind: 'video', mime: 'video/mp4', bytes: 40_000, seq: 3 },
    { url: 'https://example.com/feature.mp4', kind: 'video', mime: 'video/mp4', bytes: 3_000_000, seq: 4 },
  ]
  const players = [{ url: 'https://example.com/feature.mp4' }]
  const kept = coreRows(rows, players)
  assert.deepEqual(kept.map((one) => one.url), ['https://example.com/feature.mp4', 'https://example.com/poster-loop.mp4'])
  const everything = coreRows(rows, players, true)
  assert.equal(everything.length, 4)
  assert.equal(everything[0].url, 'https://example.com/feature.mp4')
  assert.deepEqual(everything.slice(2).map((one) => new URL(one.url).pathname).sort(), ['/ads/pre.mp4', '/px/beacon.mp4'])
})

test('a score keeps the movie even when an ad is larger', async () => {
  const { coreScore } = await import('../media.js?m=2')
  const movie = coreScore({ url: 'https://example.com/a.mp4', mime: 'video/mp4', kind: 'video', bytes: 2_000_000 }, [{ url: 'https://example.com/a.mp4' }])
  const ad = coreScore({ url: 'https://example.com/ads/b.mp4', mime: 'video/mp4', kind: 'video', bytes: 20_000_000 }, [{ url: 'https://example.com/a.mp4' }])
  assert.ok(movie > ad)
})
