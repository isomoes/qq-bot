import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractUrls,
  registrableDomain,
  hasSuspiciousUrl,
  scanUrls,
  DEFAULT_SAFE_URL_DOMAINS,
  DEFAULT_SUSPICIOUS_TLDS,
} from '../src/ad/urls'

describe('extractUrls', () => {
  it('extracts scheme-d URLs', () => {
    const urls = extractUrls('看看 https://Example.com/a?b=1 这个，还有 http://x.cn')
    assert.deepEqual(urls, ['https://example.com/a?b=1', 'http://x.cn'])
  })

  it('strips terminal English and Chinese sentence punctuation', () => {
    assert.deepEqual(extractUrls('推荐 https://jd.com。另见 https://example.com!'), [
      'https://jd.com',
      'https://example.com',
    ])
  })

  it('extracts bare domains without a scheme', () => {
    const urls = extractUrls('去 www.example.com/abc 看看，或者 example.com')
    assert.ok(urls.includes('www.example.com'))
    assert.ok(urls.includes('example.com'))
  })

it('extracts bare domains embedded directly in CJK text', () => {
    // Chinese ads paste domains straight after 汉字 with no space: 来de98.top.
    const urls = extractUrls('优惠大促销,来de98.top中转站优惠')
    assert.ok(urls.includes('de98.top'), `expected de98.top in ${JSON.stringify(urls)}`)
    assert.ok(extractUrls('欢迎访问evil-shop.xyz别错过').includes('evil-shop.xyz'))
    assert.ok(extractUrls('加我微信abc123.com等你').includes('abc123.com'))
  })

  it('does not treat plain words as URLs', () => {
    assert.deepEqual(extractUrls('今天天气不错 聊聊呗'), [])
  })

  it('does not extract the domain of an email address', () => {
    const urls = extractUrls('投简历请发 hr@ai-company.com 随时联系')
    assert.ok(!urls.includes('ai-company.com'), `email domain leaked: ${JSON.stringify(urls)}`)
  })
})

describe('registrableDomain', () => {
  it('keeps the last two labels for generic TLDs', () => {
    assert.equal(registrableDomain('sketchy.xyz'), 'sketchy.xyz')
    assert.equal(registrableDomain('a.b.sketchy.com'), 'sketchy.com')
  })

  it('keeps three labels for ccTLD subdomains (com.cn, co.jp)', () => {
    assert.equal(registrableDomain('evil.example.com.cn'), 'example.com.cn')
    assert.equal(registrableDomain('shop.example.co.jp'), 'example.co.jp')
  })

  it('normalizes case', () => {
    assert.equal(registrableDomain('WEIRD-SHOP.XYZ'), 'weird-shop.xyz')
  })
})

describe('hasSuspiciousUrl', () => {
  const safe = DEFAULT_SAFE_URL_DOMAINS

  it('flags URLs not on the whitelist', () => {
    assert.equal(hasSuspiciousUrl('点这个 https://sketchy.xyz/abc', safe), true)
    assert.equal(hasSuspiciousUrl('去 www.evil-shop.com 看看', safe), true)
  })

  it('passes whitelisted major platforms and official domains', () => {
    assert.equal(hasSuspiciousUrl('https://item.jd.com/123', safe), false)
    assert.equal(hasSuspiciousUrl('https://www.bilibili.com/video/BV12345', safe), false)
    assert.equal(hasSuspiciousUrl('https://www.gov.cn/notice', safe), false)
    assert.equal(hasSuspiciousUrl('优惠 打折 促销 https://jd.com。', safe), false)
  })

  it('passes text without any URL', () => {
    assert.equal(hasSuspiciousUrl('就是闲聊几句 今天吃什么', safe), false)
  })

  it('respects a custom whitelist', () => {
    assert.equal(hasSuspiciousUrl('https://sketchy.xyz/abc', ['jd.com']), true)
    assert.equal(hasSuspiciousUrl('https://sketchy.xyz/abc', ['jd.com', 'sketchy.xyz']), false)
  })
})

describe('scanUrls', () => {
  const safe = DEFAULT_SAFE_URL_DOMAINS
  const tlds = DEFAULT_SUSPICIOUS_TLDS

  it('flags a non-whitelisted URL, and the TLD when it is spam-prone', () => {
    assert.deepEqual(scanUrls('看这个 https://weird-shop.top/abc', safe, tlds), {
      suspiciousUrl: true,
      suspiciousTld: true,
    })
    assert.deepEqual(scanUrls('看这个 https://weird-shop.example.com/abc', safe, tlds), {
      suspiciousUrl: true,
      suspiciousTld: false,
    })
  })

  it('ignores whitelisted URLs even on spam-prone TLDs (platform-owned)', () => {
    // github.io / githubusercontent are not whitelisted here, but a URL the
    // whitelist explicitly covers (jd.com) is fine regardless of TLD.
    assert.deepEqual(scanUrls('https://jd.com/abc', safe, tlds), {
      suspiciousUrl: false,
      suspiciousTld: false,
    })
  })

  it('respects a custom TLD list', () => {
    const tld = ['cn']
    assert.deepEqual(scanUrls('https://evil.cn/abc', safe, tld), {
      suspiciousUrl: true,
      suspiciousTld: true,
    })
    assert.deepEqual(scanUrls('https://evil.com/abc', safe, tld), {
      suspiciousUrl: true,
      suspiciousTld: false,
    })
  })

  it('scans every bare domain regardless of its order', () => {
    assert.deepEqual(scanUrls('jd.com evil.xyz', safe, tlds), {
      suspiciousUrl: true,
      suspiciousTld: true,
    })
  })
})
