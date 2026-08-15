/**
 * URL extraction + safe-domain classification for ad detection.
 *
 * Ads almost always carry a URL — but so do normal messages: a member sharing
 * a product link is a recommendation, not an ad. The detector therefore treats
 * a URL as ad evidence only when its domain is NOT a major platform or an
 * official site (see safeUrlDomains); a lone link never flags by itself and
 * only interacts with the keyword evidence (see bayes.ts).
 */

/** Major-platform / official domains always treated as benign (shareable).
 *  Overridable via `safeUrlDomains` in config/ad.json. */
export const DEFAULT_SAFE_URL_DOMAINS: readonly string[] = [
  // QQ / WeChat ecosystem (official)
  'qq.com', 'weixin.qq.com', 'wechat.com', 'woa.com',
  // Major shopping platforms
  'taobao.com', 'tmall.com', 'jd.com', 'pinduoduo.com', '1688.com',
  'amazon.com', 'amazon.cn',
  // Major content / social platforms
  'bilibili.com', 'douyin.com', 'kuaishou.com', 'xiaohongshu.com',
  'weibo.com', 'zhihu.com', 'baidu.com', 'tieba.baidu.com',
  'google.com', 'google.cn', 'youtube.com', 'github.com', 'gitee.com',
  'microsoft.com', 'apple.com', 'alipay.com', 'paypal.com',
  // Major services
  'meituan.com', 'dianping.com', 'ele.me', '12306.cn', 'amap.com',
  // Official / education
  'gov.cn', 'edu.cn', 'wikipedia.org',
  // Dev / AI platforms a tech group legitimately shares
  'huggingface.co', 'kaggle.com', 'arxiv.org', 'notion.so', 'autodl.com',
  'volcengine.com', 'bytedance.com', 'aliyun.com', 'huaweicloud.com', 'qcloud.com',
  'openai.com', 'anthropic.com', 'deepseek.com', 'linux.do', 't.cn',
  'gitlab.com', 'stackoverflow.com', 'csdn.net', 'juejin.cn', 'cnblogs.com',
  'leetcode.com', 'nowcoder.com', 'vercel.com', 'npmjs.com', 'pypi.org',
  'python.org', 'docker.com', 'kubernetes.io',
]

/** Spam-prone top-level domains: cheap registrations disproportionately used
 *  by ad/loan/scam sites. A URL on one of these TLDs is a little extra
 *  evidence on top of being non-whitelisted. Overridable via `suspiciousTlds`
 *  in config/ad.json. */
export const DEFAULT_SUSPICIOUS_TLDS: readonly string[] = [
  'top', 'xyz', 'icu', 'cc',
  'vip', 'club', 'site', 'info', 'online', 'shop', 'store', 'live',
  'pro', 'tech', 'fun', 'app', 'work', 'ltd', 'group', 'ink',
  'me', 'biz', 'mobi', 'tv', 'wang', 'ren', 'red',
  'loan', 'bid', 'win', 'link', 'cloud', 'news', 'video', 'space',
  'world', 'plus', 'social', 'blog', 'design', 'games', 'media', 'network',
  'tk', 'ml', 'ga', 'cf', 'gq',
]

/** Scheme'd URLs, e.g. https://example.com/path?q=1. Trailing sentence
 *  punctuation is stripped when the token is extracted. */
const URL_RE = /https?:\/\/[^\s<>"'（）()，。！？；：、…）》【】〔〕「」『』“”‘’]+/gi
/** Bare domains, e.g. www.example.com or example.com/abc (no scheme). A host
 *  is a label-dotted domain with an alphabetic TLD; it counts wherever it
 *  starts — including directly after CJK text ("来de98.top" must match). We
 *  only require that the char before is not itself a domain character (letter,
 *  digit, dot, dash, @), so we don't match inside a longer host and don't grab
 *  the domain of an email address. */
const BARE_HOST_RE = /(?<![a-zA-Z0-9.\-@])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?::\d+)?/gi
const BARE_HOST_TOKEN_RE = /^((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?::\d+)?/i
/** Punctuation commonly attached to a URL at the end of a sentence. */
const TRAILING_URL_PUNCTUATION_RE = /[.,!?;:，。！？；：、…）》】〕」』”’]+$/u

/** Extract the host of a URL token (drops scheme, port and path). */
function hostOf(url: string): string {
  const scheme = /^https?:\/\/([^\/:?#\s]+)/i.exec(url)
  if (scheme) return scheme[1].toLowerCase()
  // Use a non-global expression here: BARE_HOST_RE is stateful and is reserved
  // for walking the complete message in extractUrls().
  const bare = BARE_HOST_TOKEN_RE.exec(url)
  return bare ? bare[1].toLowerCase() : ''
}

/**
 * Extract all URLs in `text` (scheme'd URLs and bare domains), lowercased.
 * Scheme'd spans are masked out before the bare-host scan so the domain inside
 * `https://example.com/x` isn't reported twice.
 */
export function extractUrls(text: string): string[] {
  const out = new Set<string>()
  const masked = text.split('')
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(text)) !== null) {
    const url = m[0].replace(TRAILING_URL_PUNCTUATION_RE, '').toLowerCase()
    if (url) out.add(url)
    if (m[0].length === 0) {
      URL_RE.lastIndex++
      continue
    }
    for (let i = m.index; i < m.index + m[0].length; i++) masked[i] = ' '
  }
  BARE_HOST_RE.lastIndex = 0
  while ((m = BARE_HOST_RE.exec(masked.join(''))) !== null) {
    out.add(m[1].toLowerCase())
  }
  return [...out]
}

/**
 * The registrable domain of a host: the last two labels, or three for
 * two-letter ccTLDs with a two/three-letter second level (com.cn, co.jp, …).
 */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split('.').filter(Boolean)
  if (labels.length < 2) return host.toLowerCase()
  const tld = labels[labels.length - 1]
  const second = labels[labels.length - 2]
  if (tld.length === 2 && second.length <= 3) return labels.slice(-3).join('.')
  return labels.slice(-2).join('.')
}

/**
 * True when `text` contains at least one URL whose domain is not in
 * `safeDomains` (i.e. not an official or major-platform site).
 */
export function hasSuspiciousUrl(text: string, safeDomains: readonly string[]): boolean {
  return scanUrls(text, safeDomains, DEFAULT_SUSPICIOUS_TLDS).suspiciousUrl
}

/** Result of scanning a message for URL-based ad evidence. */
export interface UrlScan {
  /** At least one URL whose domain is not on the safe whitelist. */
  suspiciousUrl: boolean
  /** Among those, at least one uses a spam-prone TLD (`.top`/`.xyz`/`.icu`…). */
  suspiciousTld: boolean
}

/** Per-URL ad-evidence classification (for the analysis/test tool). */
export interface UrlEvidence {
  /** The URL token found in the text (scheme'd URL or bare host). */
  url: string
  /** The extracted host, lowercased. */
  host: string
  /** True when the host is benign (a label suffix is on the safe whitelist). */
  benign: boolean
  /** True when the host is not benign and uses a spam-prone TLD. */
  suspiciousTld: boolean
}

/**
 * Classify every URL in `text` for ad evidence. A host is benign when any of
 * its label suffixes (e.g. `jd.com` of `item.jd.com`, or `gov.cn` of
 * `www.gov.cn`) is on the safe list; non-benign hosts on a spam-prone TLD are
 * additionally marked.
 */
export function classifyUrls(
  text: string,
  safeDomains: readonly string[],
  suspiciousTlds: readonly string[],
): UrlEvidence[] {
  const safe = new Set(safeDomains.map((d) => d.toLowerCase()))
  const tlds = new Set(suspiciousTlds.map((t) => t.toLowerCase().replace(/^\./, '')))
  const out: UrlEvidence[] = []
  for (const url of extractUrls(text)) {
    const host = hostOf(url)
    if (!host) continue
    const labels = host.split('.')
    let benign = false
    for (let i = 1; i <= labels.length; i++) {
      if (safe.has(labels.slice(-i).join('.'))) {
        benign = true
        break
      }
    }
    out.push({ url, host, benign, suspiciousTld: !benign && tlds.has(labels[labels.length - 1]) })
  }
  return out
}

/**
 * Scan `text` for URL evidence: whether it carries a non-whitelisted URL, and
 * whether such a URL sits on a spam-prone TLD.
 */
export function scanUrls(
  text: string,
  safeDomains: readonly string[],
  suspiciousTlds: readonly string[],
): UrlScan {
  let suspiciousUrl = false
  let suspiciousTld = false
  for (const e of classifyUrls(text, safeDomains, suspiciousTlds)) {
    if (e.benign) continue
    suspiciousUrl = true
    if (e.suspiciousTld) suspiciousTld = true
  }
  return { suspiciousUrl, suspiciousTld }
}
