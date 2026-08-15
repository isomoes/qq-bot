/**
 * Ad config: loads the forbidden-word lists (违禁词 / 违禁强度) and the
 * statistical probability params from one JSON config file (config/ad.json by
 * default), so they can be tuned without touching source code.
 *
 * The config file is the single source of truth for the base keyword, strong
 * keyword and pattern lists plus the naive-Bayes parameters. A missing or
 * corrupt file (or a field that fails validation) falls back to the bundled
 * defaults in keywords.ts / patterns.ts / bayes.ts. The remote rules file
 * (rules.ts) still unions its `[keywords]` / `[strong]` / `[patterns]`
 * sections on top as an optional live-update layer.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_AD_BAYES, type AdBayesParams } from './bayes'
import { BUILTIN_AD_KEYWORDS, BUILTIN_STRONG_AD_KEYWORDS, parseKeywordList } from './keywords'
import { BUILTIN_AD_PATTERNS, BUILTIN_CONTACT_AD_PATTERNS, parsePatternList } from './patterns'
import { DEFAULT_SAFE_URL_DOMAINS, DEFAULT_SUSPICIOUS_TLDS } from './urls'

/** Combined tunable settings the detector/moderator read on every message. */
export interface AdSettings {
  /** Minimum distinct keyword hits to even consider the keyword path. */
  minKeywordHits: number
  /** Naive-Bayes prior/threshold/likelihood-ratio parameters. */
  bayes: AdBayesParams
  /** Per-keyword likelihood-ratio overrides (违禁强度), by canonical keyword. */
  keywordLrs: ReadonlyMap<string, number>
  /** Domains (registrable, e.g. `jd.com`) treated as benign sharing; URLs on
   *  these never count as ad evidence. */
  safeUrlDomains: readonly string[]
  /** Spam-prone TLDs (`.top`, `.xyz`, …); a non-whitelisted URL on one of
   *  these adds a little extra evidence. */
  suspiciousTlds: readonly string[]
}

/** Fully resolved config: the keyword lists plus the probability settings. */
export interface LoadedAdConfig {
  keywords: string[]
  strongKeywords: string[]
  patterns: RegExp[]
  contactPatterns: RegExp[]
  settings: AdSettings
  /** `file` when config/ad.json was read, `defaults` when it fell back. */
  source: 'file' | 'defaults'
  /** Human-readable notes about dropped/invalid entries. */
  notes: string[]
}

/** Path of the ad config file; override with AD_CONFIG_PATH. */
export const adConfigPath = (): string =>
  process.env.AD_CONFIG_PATH ?? path.resolve(process.cwd(), 'config', 'ad.json')

/** Accepted ranges for the probability params; out-of-range values are dropped. */
const PRIOR_RANGE: readonly [number, number] = [0.0001, 0.5]
const THRESHOLD_RANGE: readonly [number, number] = [0.5, 1]
const LR_MIN = 1
const MIN_HITS_MIN = 1
/** Non-negative coefficient fields (length growth, repetition boost, caps). */
const COEFF_MIN = 0

function inRange(v: number, [min, max]: readonly [number, number]): boolean {
  return Number.isFinite(v) && v >= min && v <= max
}

/**
 * Parse a JSON ad-config body into resolved lists + settings. Invalid JSON or
 * invalid fields fall back to the bundled defaults; notes describe what was
 * dropped so an operator can fix the file.
 */
export function parseAdConfig(body: string): LoadedAdConfig {
  const notes: string[] = []
  const keywords: string[] = [...BUILTIN_AD_KEYWORDS]
  const strongKeywords: string[] = [...BUILTIN_STRONG_AD_KEYWORDS]
  const patterns: RegExp[] = [...BUILTIN_AD_PATTERNS]
  const contactPatterns: RegExp[] = [...BUILTIN_CONTACT_AD_PATTERNS]
  const settings: AdSettings = {
    minKeywordHits: 2,
    bayes: { ...DEFAULT_AD_BAYES },
    keywordLrs: new Map(),
    safeUrlDomains: [...DEFAULT_SAFE_URL_DOMAINS],
    suspiciousTlds: [...DEFAULT_SUSPICIOUS_TLDS],
  }
  const keywordLrs = new Map<string, number>()

  let data: unknown
  try {
    data = JSON.parse(body)
  } catch (err) {
    notes.push(`invalid JSON (${err instanceof Error ? err.message : String(err)}); using defaults`)
    return { keywords, strongKeywords, patterns, contactPatterns, settings, source: 'defaults', notes }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    notes.push('config root must be a JSON object; using defaults')
    return { keywords, strongKeywords, patterns, contactPatterns, settings, source: 'defaults', notes }
  }
  const obj = data as Record<string, unknown>

  // Keyword lists: a present array replaces the bundled baseline.
  const rawKeywords = obj.keywords
  if (rawKeywords !== undefined) {
    if (Array.isArray(rawKeywords) && rawKeywords.every((v) => typeof v === 'string')) {
      const parsed = parseKeywordList(rawKeywords.join('\n'))
      if (parsed.length === 0) notes.push('keywords: no valid terms (need 2..64 chars); using defaults')
      else {
        keywords.length = 0
        keywords.push(...parsed)
      }
    } else notes.push('keywords: must be an array of strings; using defaults')
  }

  const rawStrong = obj.strongKeywords
  if (rawStrong !== undefined) {
    if (Array.isArray(rawStrong) && rawStrong.every((v) => typeof v === 'string')) {
      const parsed = parseKeywordList(rawStrong.join('\n'))
      if (parsed.length === 0) notes.push('strongKeywords: no valid terms (need 2..64 chars); using defaults')
      else {
        strongKeywords.length = 0
        strongKeywords.push(...parsed)
      }
    } else notes.push('strongKeywords: must be an array of strings; using defaults')
  }

  const rawPatterns = obj.patterns
  if (rawPatterns !== undefined) {
    if (Array.isArray(rawPatterns) && rawPatterns.every((v) => typeof v === 'string')) {
      const parsed = parsePatternList(rawPatterns.join('\n'))
      patterns.length = 0
      patterns.push(...parsed.items)
      for (const s of parsed.skipped) notes.push(`pattern skipped: ${s}`)
    } else notes.push('patterns: must be an array of strings; using defaults')
  }

  const rawContactPatterns = obj.contactPatterns
  if (rawContactPatterns !== undefined) {
    if (Array.isArray(rawContactPatterns) && rawContactPatterns.every((v) => typeof v === 'string')) {
      const parsed = parsePatternList(rawContactPatterns.join('\n'))
      contactPatterns.length = 0
      contactPatterns.push(...parsed.items)
      for (const s of parsed.skipped) notes.push(`contactPattern skipped: ${s}`)
    } else notes.push('contactPatterns: must be an array of strings; using defaults')
  }

  // Probability params: each is independently validated, dropping bad values.
  const num = (name: string): number | undefined => {
    const v = obj[name]
    if (v === undefined) return undefined
    if (typeof v === 'number' && Number.isFinite(v)) return v
    notes.push(`${name}: not a finite number; keeping default`)
    return undefined
  }

  const prior = num('prior')
  if (prior !== undefined && !inRange(prior, PRIOR_RANGE)) notes.push(`prior: ${prior} out of range ${PRIOR_RANGE.join('..')}; keeping default`)
  else if (prior !== undefined) settings.bayes.prior = prior

  const threshold = num('threshold')
  if (threshold !== undefined && !inRange(threshold, THRESHOLD_RANGE))
    notes.push(`threshold: ${threshold} out of range ${THRESHOLD_RANGE.join('..')}; keeping default`)
  else if (threshold !== undefined) settings.bayes.threshold = threshold

  const strongLr = num('strongLr')
  if (strongLr !== undefined && strongLr < LR_MIN) notes.push(`strongLr: ${strongLr} < ${LR_MIN}; keeping default`)
  else if (strongLr !== undefined) settings.bayes.strongLr = strongLr

  const weakLr = num('weakLr')
  if (weakLr !== undefined && weakLr < LR_MIN) notes.push(`weakLr: ${weakLr} < ${LR_MIN}; keeping default`)
  else if (weakLr !== undefined) settings.bayes.weakLr = weakLr

  // Per-keyword intensity (违禁强度): keyword -> likelihood-ratio override.
  const rawLrs = obj.keywordLrs
  if (rawLrs !== undefined) {
    if (typeof rawLrs === 'object' && rawLrs !== null && !Array.isArray(rawLrs)) {
      let kept = 0
      for (const [word, lr] of Object.entries(rawLrs as Record<string, unknown>)) {
        if (typeof lr === 'number' && Number.isFinite(lr) && lr >= LR_MIN) {
          keywordLrs.set(word, lr)
          kept++
        } else notes.push(`keywordLrs[${word}]: must be a number >= ${LR_MIN}; dropped`)
      }
      if (kept === 0) notes.push('keywordLrs: no valid entries; ignoring')
    } else notes.push('keywordLrs: must be an object { keyword: LR }; ignoring')
  }

  const lengthLr = num('lengthLr')
  if (lengthLr !== undefined && lengthLr < COEFF_MIN) notes.push(`lengthLr: ${lengthLr} < ${COEFF_MIN}; keeping default`)
  else if (lengthLr !== undefined) settings.bayes.lengthLr = lengthLr

  const chatLength = num('chatLength')
  if (chatLength !== undefined && (!Number.isInteger(chatLength) || chatLength < 1))
    notes.push(`chatLength: ${chatLength} must be an integer >= 1; keeping default`)
  else if (chatLength !== undefined) settings.bayes.chatLength = chatLength

  const maxLengthLr = num('maxLengthLr')
  if (maxLengthLr !== undefined && maxLengthLr < COEFF_MIN)
    notes.push(`maxLengthLr: ${maxLengthLr} < ${COEFF_MIN}; keeping default`)
  else if (maxLengthLr !== undefined) settings.bayes.maxLengthLr = maxLengthLr

  const shortFactor = num('shortKeywordFactor')
  if (shortFactor !== undefined && (shortFactor <= 0 || shortFactor > 1))
    notes.push(`shortKeywordFactor: ${shortFactor} must be in (0..1]; keeping default`)
  else if (shortFactor !== undefined) settings.bayes.shortKeywordFactor = shortFactor

  const shortPower = num('shortRampPower')
  if (shortPower !== undefined && shortPower <= 0)
    notes.push(`shortRampPower: ${shortPower} must be > 0; keeping default`)
  else if (shortPower !== undefined) settings.bayes.shortRampPower = shortPower

  const repeatDiminish = num('repeatDiminish')
  if (repeatDiminish !== undefined && (repeatDiminish <= 0 || repeatDiminish > 1))
    notes.push(`repeatDiminish: ${repeatDiminish} must be in (0..1]; keeping default`)
  else if (repeatDiminish !== undefined) settings.bayes.repeatDiminish = repeatDiminish

  const weakDiminish = num('weakDiminish')
  if (weakDiminish !== undefined && weakDiminish <= 0)
    notes.push(`weakDiminish: ${weakDiminish} must be > 0; keeping default`)
  else if (weakDiminish !== undefined) settings.bayes.weakDiminish = weakDiminish

  const urlLr = num('suspiciousUrlLr')
  if (urlLr !== undefined && urlLr < LR_MIN)
    notes.push(`suspiciousUrlLr: ${urlLr} < ${LR_MIN}; keeping default`)
  else if (urlLr !== undefined) settings.bayes.suspiciousUrlLr = urlLr

  const tldLr = num('suspiciousTldLr')
  if (tldLr !== undefined && tldLr < LR_MIN)
    notes.push(`suspiciousTldLr: ${tldLr} < ${LR_MIN}; keeping default`)
  else if (tldLr !== undefined) settings.bayes.suspiciousTldLr = tldLr

  // Structural-feature likelihood ratios (>= LR_MIN) and conversational
  // dampening factors (0..1). All optional; bad values keep the defaults.
  const lrParam = (name: keyof AdBayesParams): void => {
    const v = num(String(name))
    if (v !== undefined && v < LR_MIN) notes.push(`${String(name)}: ${v} < ${LR_MIN}; keeping default`)
    else if (v !== undefined) settings.bayes[name] = v as never
  }
  lrParam('contactLr')
  lrParam('codeLr')
  lrParam('priceLr')
  lrParam('registerLr')
  lrParam('serviceLr')
  lrParam('ctaLr')
  lrParam('pitchLr')

  const factorParam = (name: 'questionFactor' | 'replyFactor' | 'collabFactor'): void => {
    const v = num(name)
    if (v !== undefined && (v <= 0 || v > 1)) notes.push(`${name}: ${v} must be in (0..1]; keeping default`)
    else if (v !== undefined) settings.bayes[name] = v
  }
  factorParam('questionFactor')
  factorParam('replyFactor')
  factorParam('collabFactor')

  // Safe-URL whitelist: a present array replaces the bundled platform list.
  const rawSafe = obj.safeUrlDomains
  if (rawSafe !== undefined) {
    if (Array.isArray(rawSafe) && rawSafe.every((v) => typeof v === 'string' && v.trim().length > 0)) {
      settings.safeUrlDomains = [...new Set(rawSafe.map((v) => v.trim().toLowerCase()))]
    } else notes.push('safeUrlDomains: must be an array of non-empty strings; using defaults')
  }

  // Suspicious-TLD list: a present array replaces the bundled list.
  const rawTlds = obj.suspiciousTlds
  if (rawTlds !== undefined) {
    if (Array.isArray(rawTlds) && rawTlds.every((v) => typeof v === 'string' && v.trim().length > 0)) {
      settings.suspiciousTlds = [...new Set(rawTlds.map((v) => v.trim().toLowerCase().replace(/^\./, '')))]
    } else notes.push('suspiciousTlds: must be an array of non-empty strings; using defaults')
  }

  const minHits = num('minKeywordHits')
  if (minHits !== undefined && (!Number.isInteger(minHits) || minHits < MIN_HITS_MIN))
    notes.push(`minKeywordHits: ${minHits} must be an integer >= ${MIN_HITS_MIN}; keeping default`)
  else if (minHits !== undefined) settings.minKeywordHits = minHits

  settings.keywordLrs = keywordLrs

  return { keywords, strongKeywords, patterns, contactPatterns, settings, source: 'file', notes }
}

/** Load config/ad.json if present; otherwise return the bundled defaults. */
export function loadAdConfig(): LoadedAdConfig {
  const filePath = adConfigPath()
  if (existsSync(filePath)) {
    try {
      return parseAdConfig(readFileSync(filePath, 'utf8'))
    } catch (err) {
      return {
        ...parseAdConfig('{}'),
        source: 'defaults',
        notes: [`failed to read ${filePath} (${err instanceof Error ? err.message : String(err)}); using defaults`],
      }
    }
  }
  return {
    ...parseAdConfig('{}'),
    source: 'defaults',
    notes: [`config file ${filePath} does not exist; using defaults`],
  }
}

let cached: LoadedAdConfig | null = null

/** The active config, loaded once on first use and cached afterwards. */
export function getAdConfig(): LoadedAdConfig {
  if (!cached) cached = loadAdConfig()
  return cached
}

/** The active tunable settings (probability params) from the config. */
export function getAdSettings(): AdSettings {
  return getAdConfig().settings
}
