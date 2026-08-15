/**
 * Ad regex-pattern defaults + parser/validator.
 *
 * The patterns below are the *fallback* defaults: settings.ts loads the active
 * base patterns from config/ad.json (the single source of truth) and uses these
 * only when the config file is missing or corrupt. rules.ts unions the active
 * base with the `[patterns]` section of the remote rules file. This module is
 * pure data + parsing — the active state and loading live in settings.ts /
 * rules.ts.
 *
 * There are two pattern families:
 *
 * - `BUILTIN_AD_PATTERNS` (config `patterns`) — *offer* structures (a concrete
 *   discount, a group-buy push, a cloud-server price). A single match hard-flags
 *   the message regardless of length or keywords: these are the pitch itself.
 * - `BUILTIN_CONTACT_AD_PATTERNS` (config `contactPatterns`) — *contact* /
 *   hook patterns (加微信:xxx, QQ号, 电话, 扫码领…). These only hard-flag when
 *   the message is short (too little text to be anything but the hook) or two
 *   or more of them co-occur; a lone one inside a long message adds weak
 *   evidence instead (see detector.ts), because a long post mentioning a WeChat
 *   id is usually a discussion, not an ad.
 *
 * SECURITY: patterns run against every message and Node's RegExp has no
 * timeout, so a catastrophically-backtracking pattern (ReDoS) would hang the
 * bot. The remote file is operator-authored (lives in this repo), but
 * parsePatternList still validates each pattern: it rejects invalid or
 * over-long patterns, drops the stateful `g`/`y` flags, and runs a best-effort
 * timing screen that skips patterns which are pathologically slow on short
 * adversarial inputs. Not a hard guarantee — avoid nested quantifiers like
 * `(a+)+`.
 */

/** What the parser returns: valid items plus descriptions of rejected lines. */
export interface ParseResult<T> {
  items: T[]
  skipped: string[]
}

/** High-signal *offer* patterns — a single match flags the message as an ad. */
export const BUILTIN_AD_PATTERNS: readonly RegExp[] = [
  /[0-9一二三四五六七八九十百]+[%％].*?折扣/,
  /还差\d{1,2}人.{0,10}(拼团|团购|满减)/,
  // Cloud-server / VPS reselling ads (京东云/阿里云/腾讯云 低价秒杀). The recurring
  // "N核NG…,X元/N年" price structure is the high-signal part — requiring the
  // `元/年|月` period avoids flagging normal talk about server specs or prices.
  /\d+\s*核\s*\d+\s*[GgＧ].{0,10}?\d+\s*元\s*\/\s*\d+\s*[年月]/,
  /(阿里云|腾讯云|京东云|华为云|百度云|天翼云|优刻得|轻量应用服务器|云服务器).{0,14}?\d+\s*元\s*\/\s*\d+\s*[年月]/,
]

/** Contact/hook patterns — length-gated (see module doc + detector.ts). */
export const BUILTIN_CONTACT_AD_PATTERNS: readonly RegExp[] = [
  /加[V微]信?[:：]?\s*([a-zA-Z0-9_-]{4,20})/,
  /微信[号码]?[:：]?\s*([a-zA-Z0-9_-]{4,20})/,
  /([Qq]{2}|扣扣)[:：]?\s*([0-9]{5,11})/,
  /电话[:：]?\s*(1[3-9]\d{9})/,
  /([加关]注|扫码).{0,5}领.{0,5}(红包|优惠)/,
  /[加关]我.{0,8}发你/,
  /[找要]人.{0,5}一起.{0,5}(考研|调剂|保研)/,
  /本人.{0,20}(专业|精通).{0,20}(辅导|指导)/,
  /(免费|赠送|折扣).{0,15}(咨询|了解|获取)/,
]

/** Reject patterns longer than this (junk / accidental paste guard). */
const MAX_PATTERN_LENGTH = 200
/** Flags we accept; `g`/`y` are stripped (stateful lastIndex breaks .test()). */
const ALLOWED_FLAGS = /^[imsu]*$/
/** Per-pattern load-time timing budget; catastrophic patterns blow past it. */
const PROBE_BUDGET_MS = 25

/** Short adversarial strings to expose catastrophic backtracking at load time. */
const PROBES: readonly string[] = [
  'a'.repeat(24) + '!',
  '1'.repeat(24) + '!',
  ' '.repeat(24) + '!',
  'a1'.repeat(12) + '!',
  'aA'.repeat(12) + '!',
  '微'.repeat(24) + '!',
]

/** Best-effort ReDoS screen: true if `re` is dangerously slow on any probe. */
function isSlowRegex(re: RegExp): boolean {
  for (const probe of PROBES) {
    const start = performance.now()
    try {
      re.test(probe)
    } catch {
      return true
    }
    if (performance.now() - start > PROBE_BUDGET_MS) return true
  }
  return false
}

/**
 * Parse pattern lines: one regex per line, as either a bare source or the
 * delimited `/source/flags` form; `#` starts a comment. Invalid, over-long, or
 * catastrophically-slow patterns are skipped (with a described reason).
 */
export function parsePatternList(raw: string): ParseResult<RegExp> {
  const items: RegExp[] = []
  const skipped: string[] = []

  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    if (s.length > MAX_PATTERN_LENGTH) {
      skipped.push(`${s.slice(0, 40)}… (too long)`)
      continue
    }

    let source = s
    let flags = ''
    const delim = /^\/(.+)\/([a-zA-Z]*)$/.exec(s)
    if (delim) {
      source = delim[1]
      flags = delim[2]
    }
    flags = flags.replace(/[gy]/g, '') // strip stateful flags
    if (!ALLOWED_FLAGS.test(flags)) {
      skipped.push(`${s} (unsupported flags)`)
      continue
    }

    let re: RegExp
    try {
      re = new RegExp(source, flags)
    } catch (err) {
      skipped.push(`${s} (invalid: ${err instanceof Error ? err.message : String(err)})`)
      continue
    }
    if (isSlowRegex(re)) {
      skipped.push(`${s} (too slow — possible ReDoS)`)
      continue
    }
    items.push(re)
  }

  return { items, skipped }
}
