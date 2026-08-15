// Resolve the RSS/Atom feed list from a remote OPML file (the iread feed
// subscriptions), with a bundled fallback. The daily summary job calls this
// once per run so the feed set tracks the OPML without a redeploy.

import { readBodyText } from '../read-body'

const OPML_FETCH_TIMEOUT_MS = 15_000
/** Cap on the OPML body; a legit file is a few KB, so 5 MB is generous. */
const OPML_MAX_BYTES = 5 * 1024 * 1024

/** Minimal logger shape (satisfied by qq-official-bot's bot.logger). */
export interface FeedListLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10)
      // Guard the valid Unicode range: String.fromCodePoint throws (not returns
      // NaN) above U+10FFFF, and a throw here would drop the whole OPML.
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return NAMED_ENTITIES[ent] ?? m
  })
}

/** Rewrite a github.com `/blob/` URL to its raw.githubusercontent.com form. */
function toRawUrl(url: string): string {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url)
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : url
}

/** Extract feed URLs (`xmlUrl` attributes) from an OPML document, in document
 *  order, deduped. Regex-based: OPML outlines are flat and simple. */
export function parseOpml(xml: string): string[] {
  const urls: string[] = []
  const seen = new Set<string>()
  const re = /<outline\b[^>]*?\bxmlUrl\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const raw = (m[1] ?? m[2] ?? '').trim()
    if (!raw) continue
    const url = decodeEntities(raw)
    if (!/^https?:\/\//i.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }
  return urls
}

/**
 * Fetch and parse the OPML at `opmlUrl`, returning its feed URLs. On any
 * failure (network error, non-2xx, unparseable/empty OPML) the bundled
 * `fallback` list is returned instead, so a bad OPML never leaves the job
 * with zero feeds.
 */
export async function resolveFeeds(
  opmlUrl: string,
  fallback: readonly string[],
  logger: FeedListLogger,
): Promise<string[]> {
  const target = toRawUrl(opmlUrl)
  try {
    const res = await fetch(target, {
      headers: { Accept: 'application/xml, text/xml, text/plain, */*' },
      signal: AbortSignal.timeout(OPML_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const urls = parseOpml(await readBodyText(res, OPML_MAX_BYTES))
    if (urls.length === 0) throw new Error('no feeds parsed from OPML')
    logger.info(`[news] loaded ${urls.length} feeds from OPML ${target}`)
    return urls
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`[news] OPML fetch failed (${message}); using ${fallback.length} fallback feeds`)
    return [...fallback]
  }
}
