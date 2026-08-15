/**
 * Fetch loop for a single remote text file: conditional GET (`ETag` /
 * `If-None-Match`), timeout, a non-text-body guard, and periodic refresh.
 *
 * It owns no data. On a successful fetch it hands the body to `apply`, which
 * parses it and swaps the caller's state. Any failure (network error, non-2xx,
 * non-text body) leaves the caller's state untouched, so the effective rules
 * never drop below the bundled baselines.
 */

import { readBodyText } from '../read-body'

/** Minimal logger shape (satisfied by qq-official-bot's `bot.logger`). */
export interface RemoteLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Outcome of a single refresh attempt. */
export interface RefreshResult {
  status: 'updated' | 'unchanged' | 'failed'
  /** Items successfully parsed from the body (0 for an empty/all-comment file). */
  parsed: number
  /** Lines the parser rejected. */
  skipped: number
  error?: string
}

export class RemoteFile {
  private etag?: string

  constructor(
    private readonly opts: {
      /** Short name used in log lines, e.g. `ad-rules`. */
      name: string
      /** Parse a fetched body and swap the caller's state; return counts. */
      apply: (body: string) => { parsed: number; skipped: number }
    },
  ) {}

  /**
   * Fetch `url` and, on success, hand the body to `apply`. A 304 (via
   * `If-None-Match`) is reported as "unchanged"; failures leave state untouched.
   */
  async refresh(url: string, opts: { timeoutMs?: number } = {}): Promise<RefreshResult> {
    const { timeoutMs = 10_000 } = opts
    const failed = (error: string): RefreshResult => ({ status: 'failed', parsed: 0, skipped: 0, error })

    try {
      const headers: Record<string, string> = { Accept: 'text/plain' }
      if (this.etag) headers['If-None-Match'] = this.etag

      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
      if (res.status === 304) return { status: 'unchanged', parsed: 0, skipped: 0 }
      if (!res.ok) return failed(`HTTP ${res.status}`)

      const body = await readBodyText(res)
      // Guard against an HTML/JSON error page served with 200 wiping the rules.
      // `[` is allowed — the rules file's section headers start with it.
      const head = body.replace(/^﻿/, '').trimStart()
      if (!head || /^[<{]/.test(head)) return failed('non-text body')

      const { parsed, skipped } = this.opts.apply(body)
      const etag = res.headers.get('etag')
      if (etag) this.etag = etag
      return { status: 'updated', parsed, skipped }
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Start periodic refresh from `url`: an immediate (non-blocking) fetch, then
   * every `intervalMs`. The interval is unref'd so it never keeps the process
   * alive on its own. Returns a stop function.
   */
  startRefresh(params: { url: string; intervalMs: number; logger: RemoteLogger }): () => void {
    const { url, intervalMs, logger } = params
    const run = (): void => {
      this.refresh(url)
        .then((r) => {
          if (r.status === 'updated') {
            const extra = r.skipped ? `, ${r.skipped} skipped` : ''
            logger.info(`[${this.opts.name}] loaded ${r.parsed} remote items${extra} from ${url}`)
          } else if (r.status === 'failed') {
            logger.warn(`[${this.opts.name}] refresh failed (${r.error}); keeping current rules`)
          }
        })
        .catch((err) => logger.error(`[${this.opts.name}] unexpected refresh error:`, err))
    }
    run() // initial fetch, does not block startup
    const timer = setInterval(run, intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }
}
