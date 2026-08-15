/**
 * Naive-Bayes ad scoring.
 *
 * Every keyword hit is evidence for the message being an ad, combined with a
 * prior base rate. Each keyword has a likelihood ratio
 *   LR = P(hit | ad) / P(hit | not-ad)
 * — strong (high-signal) keywords are almost never present in innocent chat and
 * get a high LR; generic keywords get a low one. Under the naive-Bayes
 * independence assumption the posterior log-odds are
 *   logit(P(ad | text)) = log(P(ad)/(1-P(ad))) + Σ log(LR_k)
 * and a message is flagged when the resulting probability clears a threshold.
 *
 * The model is calibrated around the group's actual chat habits and keeps
 * legitimate chatter (product recommendations, casual talk) off the recall
 * path:
 *
 * 1. Per-keyword intensity (违禁强度). Every keyword's LR comes from its class
 *    (strongLr / weakLr) unless config/ad.json gives it a dedicated override
 *    (`keywordLrs`), so operators can mark e.g. `代开发票` as far stronger than
 *    a generic `促销`.
 * 2. Diminishing returns on generic hits. Distinct generic words are highly
 *    correlated (they all sit in the same ad templates), so the independence
 *    assumption over-counts them — the classic `客服 咨询 QQ 关注 考试…` false
 *    positive. The n-th distinct generic hit therefore counts for only
 *    `weakDiminish/n` of its weight, so a pile of generic words saturates
 *    instead of adding up to a flag.
 * 3. Repetition is *discounted*, not boosted. Group chat is conversational:
 *    a member who repeats one sensitive word several times is almost always
 *    trying to get attention (or pasted it by accident) — a real ad wouldn't
 *    be that low-effort. So a keyword occurring `count` times weighs only
 *    `repeatDiminish^(count-1)` of a single occurrence: `加V 加V 加V 咨询` is
 *    treated as weaker evidence than a one-off `加V` + `咨询` ad.
 * 4. Chat-length-aware evidence, continuous and capped. No single metric ever
 *    decides a flag on its own: a message is an ad only when several ad
 *    features co-occur (see detector.ts). Length is just a mild tip — normal
 *    chat messages are short, so suspicion grows smoothly from the shortest
 *    messages onward by `lengthLr·ln(1 + len/chatLength)` (with `chatLength`
 *    the reference length of everyday chat, not a cliff), but the term is
 *    capped at `maxLengthLr` so no amount of length can flag by itself. A long
 *    message with one stray keyword — a member writing a long post — stays
 *    under the threshold. The short-message dampening of keyword evidence
 *    (ramping from `shortKeywordFactor` up to `chatLength` via
 *    `shortRampPower`, superlinear) mirrors this: very short messages are
 *    nearly powerless, because an ad is a structured pitch — hook + contact +
 *    call-to-action — that cannot fit in four characters.
 * 5. Suspicious URLs are ad evidence. Ads almost always carry a link to a
 *    domain that is neither an official site nor a major platform; a URL on
 *    the `safeUrlDomains` whitelist (jd.com, bilibili.com, …) is normal
 *    sharing and adds nothing. A non-whitelisted URL contributes
 *    `ln(suspiciousUrlLr)` to the log-odds — and if it also sits on a
 *    spam-prone TLD (`.top`, `.xyz`, `.icu`, …; `suspiciousTlds`) it adds
 *    another `ln(suspiciousTldLr)`, a small extra doubt. Either way a URL only
 *    tips messages that already carry keyword evidence — a lone
 *    recommendation link never flags.
 *
 * All knobs are overridable via config/ad.json at runtime (see settings.ts).
 */
export interface AdBayesParams {
  /** Prior probability that an arbitrary group message is an ad (0..1). */
  prior: number
  /** Posterior probability at/above which a message is flagged (0..1). */
  threshold: number
  /** Likelihood ratio for a strong (high-signal) keyword hit. */
  strongLr: number
  /** Likelihood ratio for a weak (generic) keyword hit. */
  weakLr: number
  /** Length-evidence growth coefficient per ln(1 + len/chatLength). */
  lengthLr: number
  /** Reference length of everyday chat (chars) in the group. The length
   *  evidence grows continuously from the shortest messages onward, reaching
   *  `lengthLr·ln2` at this length; the short-message dampening of keyword
   *  evidence also ends here. Set it to the operator's read of the group's
   *  chat habit — modern chat messages are short. */
  chatLength: number
  /** Cap on the length-evidence term (log-odds). Kept modest so length alone
   *  can never push a message over the threshold. */
  maxLengthLr: number
  /** Keyword-evidence multiplier at length 0, ramping to 1 at chatLength. The
   *  ramp is superlinear (see `shortRampPower`), so very short messages are
   *  strongly suppressed: "加我私聊" is a private-chat invitation, not an ad —
   *  a real ad needs enough text to carry hook + contact + call-to-action. */
  shortKeywordFactor: number
  /** Exponent of the short-message dampening ramp: 1 = linear, 2 = quadratic,
   *  … — higher values suppress short messages harder. The scale always
   *  reaches 1 at `chatLength`; only shorter messages are shaped. */
  shortRampPower: number
  /** Repetition discount: a keyword occurring count times weighs
   *  repeatDiminish^(count-1) of a single occurrence (0..1]. */
  repeatDiminish: number
  /** Diminishing-return constant on the n-th distinct generic keyword:
   *  the n-th generic hit weighs min(1, weakDiminish/n) of its evidence. */
  weakDiminish: number
  /** Likelihood ratio of a URL whose domain is not on the safe-whitelist
   *  (see urls.ts). Only meaningful together with keyword evidence. */
  suspiciousUrlLr: number
  /** Extra likelihood ratio when such a URL also sits on a spam-prone TLD
   *  (see `suspiciousTlds` in settings.ts) — a small additional doubt. */
  suspiciousTldLr: number
  /** Soft evidence from a single contact pattern (微信/加V/QQ…) matched inside a
   *  long message. Short messages and 2+ contact patterns hard-flag via the
   *  pattern path instead (see detector.ts); a lone pattern in a long post is
   *  just a hint that a real pitch may be present. */
  contactLr: number
  /** Likelihood ratio of a concrete promo/coupon/invite code (优惠码 AIPRO100).
   *  The hardest structural ad signal — an explicit offer, often the only
   *  proof needed. */
  codeLr: number
  /** Likelihood ratio of an explicit price-promo structure (立减500 / 满100减50
   *  / 打7折 / 原价2999). */
  priceLr: number
  /** Likelihood ratio of an enrollment funnel (报名链接 / 开课 / 训练营). */
  registerLr: number
  /** Likelihood ratio of a paid-service pitch (出租 / 代充 / 按小时计费 + 联系客服). */
  serviceLr: number
  /** Likelihood ratio of a call-to-action phrase (想上车 / 有需要联系 / 欢迎扩散). */
  ctaLr: number
  /** Likelihood ratio of a pitch+contact structure (团购/优惠券/兼职/出售 …
   *  adjacent to 联系/加我/私聊). The demoted promo/urgency words are weak on
   *  their own; paired with a hook they become the ad's call to action, and the
   *  structure earns as much as a strong keyword. */
  pitchLr: number
  /** Conversational dampening (0..1] applied to the soft keyword + contact
   *  evidence when the message reads as a question ("有没有…？"). A question is
   *  how a member actually asks the group, not how spam is written. */
  questionFactor: number
  /** Conversational dampening (0..1] applied to the soft keyword + contact
   *  evidence when the message is a reply/quote of an earlier message in the
   *  group — replying usually means continuing a discussion, not pitching. */
  replyFactor: number
  /** Conversational dampening (0..1] applied to the soft keyword + contact
   *  evidence when the message asks for help / partnership (找合伙人, 组队,
   *  内推, 求推荐…) — collaboration is how a tech group actually talks. */
  collabFactor: number
}

export const DEFAULT_AD_BAYES: AdBayesParams = {
  prior: 0.02,
  threshold: 0.6,
  strongLr: 40,
  weakLr: 2.5,
  lengthLr: 0.35,
  chatLength: 10,
  maxLengthLr: 0.5,
  shortKeywordFactor: 0.3,
  shortRampPower: 2,
  repeatDiminish: 0.7,
  weakDiminish: 1.5,
  suspiciousUrlLr: 8,
  suspiciousTldLr: 2,
  contactLr: 4,
  codeLr: 30,
  priceLr: 10,
  registerLr: 6,
  serviceLr: 8,
  ctaLr: 5,
  pitchLr: 40,
  questionFactor: 0.55,
  replyFactor: 0.6,
  collabFactor: 0.7,
}

/** One distinct keyword's evidence contribution. */
export interface AdHit {
  /** True when the keyword is in the high-signal (strong) list. */
  strong: boolean
  /** Number of occurrences in the message (repetition is discounted). */
  count: number
  /** Per-keyword likelihood-ratio override from config/ad.json, if any. */
  lr?: number
}

/**
 * Keyword-evidence multiplier for a message of `length` chars: 1 at
 * `chatLength` and above, and a superlinear ramp down to `shortKeywordFactor`
 * at length 0. Very short messages therefore keep almost none of their
 * keyword evidence — a 4-char "加我私聊" is a private-chat invitation, not a
 * structured ad. Shared by adLogOdds() and the analysis/test tool.
 */
export function adShortScale(length: number, params: AdBayesParams): number {
  if (length >= params.chatLength) return 1
  const t = length / params.chatLength
  return params.shortKeywordFactor + (1 - params.shortKeywordFactor) * Math.pow(t, params.shortRampPower)
}

/**
 * Log-odds of a message being an ad given the keyword hits and length.
 *
 * Hits are ranked by evidence so the diminishing-return penalty lands on the
 * weakest generic terms first.
 *
 * @param hits one entry per distinct keyword hit (with occurrence count and
 *   optional per-keyword LR override)
 * @param length message length in chars; shapes the length evidence and the
 *   short-message dampening. When omitted the message is treated as
 *   neutral-length (no dampening, no length boost).
 * @param suspiciousUrl true when the message contains a URL whose domain is
 *   not on the safe whitelist (see urls.ts). Contributes
 *   `ln(suspiciousUrlLr)` to the log-odds.
 * @param suspiciousTld true when such a URL also uses a spam-prone TLD
 *   (.top/.xyz/.icu/…). Contributes `ln(suspiciousTldLr)`.
 * @returns the posterior log-odds log(P(ad)/P(not-ad))
 */
export function adLogOdds(
  hits: readonly AdHit[],
  params: AdBayesParams,
  length?: number,
  suspiciousUrl = false,
  suspiciousTld = false,
): number {
  const priorLogit = Math.log(params.prior / (1 - params.prior))
  const known = length !== undefined

  const lrOf = (h: AdHit): number => h.lr ?? (h.strong ? params.strongLr : params.weakLr)
  const ordered = [...hits].sort((a, b) => lrOf(b) - lrOf(a))

  let evidence = 0
  let genericSeen = 0
  for (const h of ordered) {
    // Repeated single keyword -> attention-seeking, not an ad: geometric decay.
    const repetition = Math.pow(params.repeatDiminish, Math.max(0, h.count - 1))
    let weight = repetition
    if (!h.strong) {
      // The n-th distinct generic keyword: diminishing returns.
      genericSeen++
      weight *= Math.min(1, params.weakDiminish / genericSeen)
    }
    evidence += Math.log(lrOf(h)) * weight
  }

  if (known) {
    evidence *= adShortScale(length, params)
    evidence += Math.min(params.maxLengthLr, params.lengthLr * Math.log(1 + length / params.chatLength))
  }

  if (suspiciousUrl) evidence += Math.log(params.suspiciousUrlLr)
  if (suspiciousTld) evidence += Math.log(params.suspiciousTldLr)

  return priorLogit + evidence
}

/** Posterior probability P(ad | text) from the log-odds. */
export function adProbability(logOdds: number): number {
  return 1 / (1 + Math.exp(-logOdds))
}