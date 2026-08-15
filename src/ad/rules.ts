/**
 * Ad rules: the active lists the detector reads on every message.
 *
 * The base lists come from config/ad.json (settings.ts — the single source of
 * truth for forbidden words, intensity and probability params, with the bundled
 * keywords.ts / patterns.ts as fallback). On top of that, one remote rules file
 * can add terms live. The file has an INI-like format with two sections:
 *
 *   [keywords]
 *   促销
 *   代购
 *
 *   [strong]
 *   加V
 *   扫码
 *
 *   [patterns]
 *   拉[你您]进[群裙]
 *   /加\s*薇/i
 *
 * `[keywords]` are general terms and never flag on their own; the detector only
 * flags a message that also contains at least one `[strong]` term (high-signal
 * contact/promo/spam words, see keywords.ts). Lines before any section, and `#`
 * lines, are ignored. A single fetch updates all lists atomically; any failure
 * keeps the current lists (see RemoteFile).
 */

import { RemoteFile, type RefreshResult, type RemoteLogger } from './remote-file'
import { compileKeywords, type CompiledKeywords, parseKeywordList } from './keywords'
import { parsePatternList } from './patterns'
import { getAdConfig } from './settings'

const patternKey = (re: RegExp): string => `${re.source} ${re.flags}`

/**
 * Base lists: the single source of truth is config/ad.json (settings.ts), which
 * falls back to the bundled defaults when the file is missing or corrupt. The
 * remote rules file is unioned on top of these as an optional live-update layer.
 */
const base = getAdConfig()
const baseKeywords: readonly string[] = base.keywords
const baseStrongKeywords: readonly string[] = base.strongKeywords
const basePatterns: readonly RegExp[] = base.patterns
const baseContactPatterns: readonly RegExp[] = base.contactPatterns

/** Active lists (config/ad.json ∪ last good remote). Swapped atomically on refresh. */
let activeKeywords: readonly string[] = baseKeywords
let activeStrongKeywords: readonly string[] = baseStrongKeywords
let activePatterns: readonly RegExp[] = basePatterns
let activeContactPatterns: readonly RegExp[] = baseContactPatterns
let activeMatcher: CompiledKeywords = compileKeywords(activeKeywords, activeStrongKeywords)

/** The general keyword list (weak terms; never flag alone). */
export const getAdKeywords = (): readonly string[] => activeKeywords
/** The high-signal keyword list (a flag requires at least one hit here). */
export const getAdStrongKeywords = (): readonly string[] => activeStrongKeywords
/** Precompiled keyword matcher the detector scans messages with. */
export const getAdKeywordMatcher = (): CompiledKeywords => activeMatcher
/** The *offer* patterns the detector hard-flags on (config `patterns`). */
export const getAdPatterns = (): readonly RegExp[] => activePatterns
/** The contact/hook patterns the detector length-gates (config `contactPatterns`). */
export const getAdContactPatterns = (): readonly RegExp[] => activeContactPatterns

/** Reset all lists to the config/ad.json baseline (used by tests). */
export function resetAdRules(): void {
  activeKeywords = baseKeywords
  activeStrongKeywords = baseStrongKeywords
  activePatterns = basePatterns
  activeContactPatterns = baseContactPatterns
  activeMatcher = compileKeywords(activeKeywords, activeStrongKeywords)
}

/**
 * Parse the merged rules file into keyword/strong/pattern lists. Section
 * headers `[keywords]` / `[strong]` / `[patterns]` (case-insensitive) route the
 * lines that follow; lines outside a known section are reported as skipped.
 */
export function parseAdRules(body: string): {
  keywords: string[]
  strongKeywords: string[]
  patterns: RegExp[]
  skipped: string[]
} {
  const keywordLines: string[] = []
  const strongLines: string[] = []
  const patternLines: string[] = []
  const skipped: string[] = []
  let section: 'keywords' | 'strong' | 'patterns' | null = null

  for (const line of body.replace(/^﻿/, '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const header = /^\[([a-zA-Z]+)\]$/.exec(trimmed)
    if (header) {
      const name = header[1].toLowerCase()
      if (name === 'keywords' || name === 'strong' || name === 'patterns') section = name
      else {
        section = null
        skipped.push(`[${header[1]}] (unknown section)`)
      }
      continue
    }

    if (section === 'keywords') keywordLines.push(trimmed)
    else if (section === 'strong') strongLines.push(trimmed)
    else if (section === 'patterns') patternLines.push(trimmed)
    else skipped.push(`${trimmed} (outside a [keywords]/[strong]/[patterns] section)`)
  }

  const keywords = parseKeywordList(keywordLines.join('\n'))
  const strongKeywords = parseKeywordList(strongLines.join('\n'))
  const patterns = parsePatternList(patternLines.join('\n'))
  return {
    keywords,
    strongKeywords,
    patterns: patterns.items,
    skipped: [...skipped, ...patterns.skipped],
  }
}

const file = new RemoteFile({
  name: 'ad-rules',
  apply: (body) => {
    const { keywords, strongKeywords, patterns, skipped } = parseAdRules(body)
    // Union each remote slice with the config/ad.json baseline, deduped; swap
    // in one assignment. Strong terms are also general keywords, so they count
    // toward the hit total.
    activeKeywords = [...new Set([...baseKeywords, ...keywords, ...strongKeywords])]
    activeStrongKeywords = [...new Set([...baseStrongKeywords, ...strongKeywords])]
    const merged = new Map<string, RegExp>()
    for (const re of basePatterns) merged.set(patternKey(re), re)
    for (const re of patterns) merged.set(patternKey(re), re)
    activePatterns = [...merged.values()]
    activeMatcher = compileKeywords(activeKeywords, activeStrongKeywords)
    return { parsed: keywords.length + strongKeywords.length + patterns.length, skipped: skipped.length }
  },
})

/** Fetch the rules file from `url` and union it with the baselines. */
export const refreshAdRules = (url: string, opts?: { timeoutMs?: number }): Promise<RefreshResult> =>
  file.refresh(url, opts)

/** Start periodic rules refresh; returns a stop function. */
export const startAdRulesRefresh = (params: {
  url: string
  intervalMs: number
  logger: RemoteLogger
}): (() => void) => file.startRefresh(params)
