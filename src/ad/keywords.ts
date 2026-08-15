/**
 * Ad keyword defaults + parser.
 *
 * The lists below are the *fallback* defaults: settings.ts loads the active
 * base lists from config/ad.json (the single source of truth) and uses these
 * only when the config file is missing or corrupt. rules.ts unions the active
 * base with the `[keywords]` section of the remote rules file. This module is
 * pure data + parsing — the active state and loading live in settings.ts /
 * rules.ts.
 */

/** Bundled fallback keywords, grouped by category. Used when config/ad.json
 *  is missing or has no keywords field. */
export const BUILTIN_AD_KEYWORDS: readonly string[] = [
  // Shopping / promotions
  '促销', '打折', '优惠', '特价', '折扣', '团购', '秒杀', '限时', '抢购', '特惠',
  '包邮', '免费送', '礼品', '限量', '降价', '甩卖', '一折', '二折', '半价',
  // Contact methods
  '微信', 'QQ', '加V', '私聊', '私发', '电话', '联系', '咨询', '热线', '客服',
  '扫码', '关注', '添加', '群号', '入群', '加我',
  // Education
  '考研', '考证', '培训', '辅导', '补习', '指导', '提分', '保过', '调剂', '考试',
  '备考', '押题', '真题', '模拟题', '特训', '保录', '神器', '包过',
  // Money / investment
  '赚钱', '投资', '理财', '收益', '回报', '股票', '基金', '保险', '贷款', '融资',
  '借钱', '零息', '放贷', '担保', '信用', '资金', '合伙', '项目',
  // Urgency
  '抓紧', '速来', '仅剩', '最后', '错过', '机不可失', '立即', '马上', '赶快',
  '趁早', '今日', '剩余', '名额有限', '先到先得',
  // Gaming / gambling
  '棋牌', '博彩', '赌博', '游戏', '充值', '代练', '刷单', '陪玩', '代打', '金币',
  // Health / beauty
  '减肥', '丰胸', '美容', '祛斑', '增高', '壮阳', '养生', '保健', '延时',
  // Jobs
  '招聘', '求职', '简历', '应聘', '兼职', '全职', '高薪', '待遇', '薪资', '日结',
  '日薪', '周薪', '月薪', '年薪', '提成', '佣金', '返利',
]

/**
 * High-signal keywords that are almost never used in benign conversation.
 *
 * These are the words that constitute the ad's *pitch* — what is being
 * promoted: promo/deal words (秒杀, 包邮, 免费送), money/loan hooks (贷款, 刷单),
 * education-scam promises (押题, 保过), urgency pushes (仅剩, 先到先得), job
 * hooks (日结, 高薪), gambling/gaming (棋牌, 博彩), health/scam (丰胸, 壮阳).
 *
 * Contact-method words (加V, 私聊, 扫码, 群号, 微信…) deliberately do NOT belong
 * here: "加我私聊" alone is a normal private-chat invitation, not an ad. They
 * live in the general keyword list and only *reinforce* a real promo signal.
 * The detector only flags a message when it contains at least one *strong*
 * keyword (the pitch) or a suspicious URL; generic words — contact or otherwise
 * — never decide on their own.
 *
 * This list is deliberately conservative: too generous and the false positives
 * come back. Prefer moving specific promo terms to the remote `[strong]`
 * section.
 */
export const BUILTIN_STRONG_AD_KEYWORDS: readonly string[] = [
  // Shopping / promotions (the hook)
  '秒杀', '代购', '包邮', '免费送', '返利', '半价', '一折', '二折', '甩卖', '特价', '抢购',
  // Money / loans
  '贷款', '放贷', '提现', '刷单',
  // Education scams
  '押题', '保过', '保录', '包过', '提分', '特训',
  // Jobs
  '日结', '高薪',
  // Gaming / gambling
  '棋牌', '博彩', '赌博', '代练', '陪玩', '代打',
  // Health / beauty (the surgical/anabolic ones)
  '丰胸', '祛斑', '壮阳', '增高', '延时',
]

/** Ignore keywords shorter/longer than these to avoid over-matching and junk. */
const MIN_KEYWORD_LENGTH = 2
const MAX_KEYWORD_LENGTH = 64
/** Hard cap on how many remote keywords we accept, as a sanity guard. */
const MAX_KEYWORDS = 100_000

/** Escape a keyword so it is treated as a literal inside a regex. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Short pure-ASCII tokens (QQ, BT, SM, 3P, …) get \b…\b so they don't false
 *  match inside unrelated words like `BTW` or `JS开发`. CJK and mixed keywords
 *  keep substring matching (there are no word boundaries in Chinese). */
const SHORT_ASCII = /^[a-zA-Z0-9]{1,3}$/

/** Compiled form of the active keyword lists, rebuilt only on refresh. */
export interface CompiledKeywords {
  /** Single case-insensitive alternation regex over all unique keywords.
   *  Alternatives are sorted longest-first so the most specific phrase wins at
   *  any position. Callers must clone it before using exec()/lastIndex. */
  readonly regex: RegExp
  /** Lowercase matched text → canonical keyword (for logs). */
  readonly canonical: ReadonlyMap<string, string>
  /** Lowercase high-signal keywords; a flag requires at least one of these. */
  readonly strong: ReadonlySet<string>
  /** Total unique keywords compiled. */
  readonly size: number
}

/**
 * Merge the general and strong keyword lists into one matcher: deduped,
 * longest-first alternation with case-insensitive matching and word boundaries
 * around short ASCII tokens.
 */
export function compileKeywords(
  general: readonly string[],
  strong: readonly string[],
): CompiledKeywords {
  const strongKeys = new Set(strong.map((k) => k.toLowerCase()))
  const canonical = new Map<string, string>()
  const parts: string[] = []
  // Strong terms are also general keywords, so count them toward the hit total.
  const all = [...new Set([...strong, ...general])].sort((a, b) => b.length - a.length)

  for (const kw of all) {
    const key = kw.toLowerCase()
    if (canonical.has(key)) continue
    canonical.set(key, kw)
    const escaped = escapeRegExp(kw)
    parts.push(SHORT_ASCII.test(kw) ? `\\b${escaped}\\b` : escaped)
  }

  return {
    regex: new RegExp(parts.join('|'), 'gi'),
    canonical,
    strong: strongKeys,
    size: canonical.size,
  }
}

/**
 * Parse keyword lines: one term per line, `#` starts a comment, blank lines and
 * out-of-range terms are dropped.
 */
export function parseKeywordList(raw: string): string[] {
  const out: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const word = line.trim()
    if (!word || word.startsWith('#')) continue
    if (word.length < MIN_KEYWORD_LENGTH || word.length > MAX_KEYWORD_LENGTH) continue
    out.push(word)
    if (out.length >= MAX_KEYWORDS) break
  }
  return out
}
