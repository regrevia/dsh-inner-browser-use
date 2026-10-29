/**
 * A PDF is a document the mirror cannot draw. This proves the plugin still
 * notices one and puts its bytes somewhere a reader can open them.
 */
import { readFileSync } from 'node:fs'
import { Sidecar } from '../sidecar.js'

const URL = 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const sidecar = new Sidecar({ profile: 'check-pdf' })
let result = { ok: false }
try {
  await sidecar.ensure({ url: URL })
  await wait(2000)
  const started = Date.now()
  const file = await sidecar.page.documentFile()
  const head = file.path === '' ? '' : readFileSync(file.path).subarray(0, 4).toString()
  result = {
    ok: head === '%PDF' && file.bytes > 1000,
    recognised: sidecar.page.pdf !== null && sidecar.page.pdf !== undefined,
    ms: Date.now() - started,
    kb: Math.round(file.bytes / 1024),
    head,
  }
} catch (error) {
  result = { ok: false, error: String(error?.message ?? error) }
} finally {
  await sidecar.shutdown().catch(() => {})
}
console.log(JSON.stringify(result))
process.exitCode = result.ok === true ? 0 : 1
