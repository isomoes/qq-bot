/**
 * Shared response-body reader: decodes a fetch `Response` as UTF-8 text while
 * capping how many bytes it will buffer. Guards the spots that fetch an
 * operator-configured URL (remote ad rules, OPML) against a server that serves
 * a huge or mislabeled body — the same hardening news/fetch-feed.ts applies to
 * RSS bodies (with its own 10 MB cap). Content-Length is checked first as a
 * cheap reject; the streamed read enforces the cap regardless.
 */

const DECODER = new TextDecoder('utf-8')

export const DEFAULT_MAX_BYTES = 1024 * 1024 // 1 MB

export async function readBodyText(
  res: Response,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<string> {
  // Fast reject on an advertised Content-Length (untrusted but cheap).
  const cl = Number(res.headers.get('content-length'))
  if (Number.isFinite(cl) && cl > maxBytes) throw new Error(`body too large (${cl} bytes)`)

  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(`body too large (> ${maxBytes} bytes)`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return DECODER.decode(out)
}
