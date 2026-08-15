import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadAdConfig, parseAdConfig } from '../src/ad/settings'

describe('parseAdConfig', () => {
  it('loads keywords, strong keywords, patterns and probability params', () => {
    const cfg = parseAdConfig(
      JSON.stringify({
        prior: 0.05,
        threshold: 0.7,
        strongLr: 50,
        weakLr: 3,
        lengthLr: 1,
        chatLength: 25,
        maxLengthLr: 2,
        shortKeywordFactor: 0.4,
        repeatDiminish: 0.8,
        weakDiminish: 2,
        suspiciousUrlLr: 12,
        suspiciousTldLr: 5,
        pitchLr: 35,
        minKeywordHits: 3,
        safeUrlDomains: ['jd.com', 'bilibili.com'],
        suspiciousTlds: ['.top', '.xyz'],
        keywordLrs: { 贷款: 80, 押题: 60 },
        keywords: ['促销', '代购'],
        strongKeywords: ['加V', '扫码'],
        patterns: ['/加[V微]信?\\s*\\w+/', '/拉[你您]进[群裙]/'],
      }),
    )
    assert.equal(cfg.source, 'file')
    assert.deepEqual(cfg.keywords, ['促销', '代购'])
    assert.deepEqual(cfg.strongKeywords, ['加V', '扫码'])
    assert.equal(cfg.patterns.length, 2)
    assert.equal(cfg.settings.minKeywordHits, 3)
    assert.equal(cfg.settings.bayes.prior, 0.05)
    assert.equal(cfg.settings.bayes.threshold, 0.7)
    assert.equal(cfg.settings.bayes.strongLr, 50)
    assert.equal(cfg.settings.bayes.weakLr, 3)
    assert.equal(cfg.settings.bayes.lengthLr, 1)
    assert.equal(cfg.settings.bayes.chatLength, 25)
    assert.equal(cfg.settings.bayes.maxLengthLr, 2)
    assert.equal(cfg.settings.bayes.shortKeywordFactor, 0.4)
    assert.equal(cfg.settings.bayes.repeatDiminish, 0.8)
    assert.equal(cfg.settings.bayes.weakDiminish, 2)
    assert.equal(cfg.settings.bayes.suspiciousUrlLr, 12)
    assert.equal(cfg.settings.bayes.suspiciousTldLr, 5)
    assert.equal(cfg.settings.bayes.pitchLr, 35)
    assert.deepEqual(cfg.settings.safeUrlDomains, ['jd.com', 'bilibili.com'])
    assert.deepEqual(cfg.settings.suspiciousTlds, ['top', 'xyz'])
    assert.equal(cfg.settings.keywordLrs.get('贷款'), 80)
    assert.equal(cfg.settings.keywordLrs.get('押题'), 60)
  })

  it('falls back to bundled defaults on invalid JSON', () => {
    const cfg = parseAdConfig('{not json')
    assert.equal(cfg.source, 'defaults')
    assert.ok(cfg.keywords.length > 0)
    assert.ok(cfg.notes.some((n) => n.startsWith('invalid JSON')))
  })

  it('falls back to bundled defaults when lists are not arrays of strings', () => {
    const cfg = parseAdConfig(JSON.stringify({ keywords: '促销', strongKeywords: 42, patterns: [1] }))
    assert.ok(cfg.keywords.length > 0)
    assert.ok(cfg.strongKeywords.length > 0)
    assert.ok(cfg.patterns.length > 0)
    assert.ok(cfg.notes.some((n) => n.includes('keywords')))
  })

  it('keeps defaults for out-of-range probability params', () => {
    const cfg = parseAdConfig(
      JSON.stringify({
        prior: 5,
        threshold: 0.1,
        strongLr: 0.5,
        weakLr: -1,
        minKeywordHits: 0,
        repeatDiminish: 0,
        weakDiminish: 0,
        maxLengthLr: -2,
        chatLength: 0,
        suspiciousUrlLr: 0.5,
        suspiciousTldLr: 0.1,
        safeUrlDomains: 42,
        suspiciousTlds: [7],
        keywordLrs: { 贷款: 0.5, 押题: 'high' },
      }),
    )
    assert.equal(cfg.settings.bayes.prior, 0.02)
    assert.equal(cfg.settings.bayes.threshold, 0.6)
    assert.equal(cfg.settings.bayes.strongLr, 40)
    assert.equal(cfg.settings.bayes.weakLr, 2.5)
    assert.equal(cfg.settings.minKeywordHits, 2)
    assert.equal(cfg.settings.bayes.repeatDiminish, 0.7)
    assert.equal(cfg.settings.bayes.weakDiminish, 1.5)
    assert.equal(cfg.settings.bayes.maxLengthLr, 0.5)
    assert.equal(cfg.settings.bayes.chatLength, 10)
    assert.equal(cfg.settings.bayes.suspiciousUrlLr, 8)
    assert.equal(cfg.settings.bayes.suspiciousTldLr, 2)
    assert.equal(cfg.settings.keywordLrs.size, 0)
    assert.ok(cfg.settings.safeUrlDomains.length >= 20)
    assert.ok(cfg.settings.suspiciousTlds.length >= 10)
    assert.ok(cfg.notes.length >= 14)
  })

  it('replaces the safe-domain whitelist (lowercased, deduped); a bad array falls back', () => {
    const replaced = parseAdConfig(JSON.stringify({ safeUrlDomains: ['JD.com', 'jd.com', 'weird.xyz'] }))
    assert.deepEqual(replaced.settings.safeUrlDomains, ['jd.com', 'weird.xyz'])
    const bad = parseAdConfig(JSON.stringify({ safeUrlDomains: [42, ''] }))
    assert.ok(bad.settings.safeUrlDomains.length >= 20, 'defaults kept on an invalid array')
    assert.ok(bad.notes.some((n) => n.includes('safeUrlDomains')))
  })

  it('replaces the suspicious-TLD list (lowercased, dot stripped); a bad array falls back', () => {
    const replaced = parseAdConfig(JSON.stringify({ suspiciousTlds: ['.TOP', '.xyz', 'top'] }))
    assert.deepEqual(replaced.settings.suspiciousTlds, ['top', 'xyz'])
    const bad = parseAdConfig(JSON.stringify({ suspiciousTlds: 42 }))
    assert.ok(bad.settings.suspiciousTlds.length >= 10, 'defaults kept on an invalid array')
    assert.ok(bad.notes.some((n) => n.includes('suspiciousTlds')))
  })

  it('drops invalid patterns and reports them', () => {
    const cfg = parseAdConfig(JSON.stringify({ patterns: ['(unclosed', '[z-a]'] }))
    assert.equal(cfg.patterns.length, 0)
    assert.ok(cfg.notes.some((n) => n.startsWith('pattern skipped')))
  })
})

describe('loadAdConfig', () => {
  it('reports a missing configured file as a defaults fallback', () => {
    const previous = process.env.AD_CONFIG_PATH
    process.env.AD_CONFIG_PATH = `/tmp/qq-bot-missing-ad-config-${process.pid}.json`
    try {
      const cfg = loadAdConfig()
      assert.equal(cfg.source, 'defaults')
      assert.ok(cfg.notes.some((note) => note.includes('does not exist')))
    } finally {
      if (previous === undefined) delete process.env.AD_CONFIG_PATH
      else process.env.AD_CONFIG_PATH = previous
    }
  })
})
