import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectAd } from '../src/ad/detector'
import { getAdSettings } from '../src/ad/settings'
import { getAdContactPatterns, getAdKeywordMatcher, getAdPatterns, resetAdRules } from '../src/ad/rules'

describe('detectAd (driven by config/ad.json)', () => {
  const settings = getAdSettings()

  it('loads the config file as the active base', () => {
    const matcher = getAdKeywordMatcher()
    assert.ok(matcher.size >= 100, `expected the config keyword list, got ${matcher.size}`)
    assert.ok(getAdPatterns().length >= 4)
    assert.ok(getAdContactPatterns().length >= 8)
  })

  it('a pattern match flags regardless of keywords', () => {
    const hit = detectAd('加微信 abc12345', settings)
    assert.ok(hit && hit.reason.startsWith('pattern:'), `expected pattern match, got ${hit?.reason}`)
  })

  it('a strong keyword plus a generic one in a normal-length message flags', () => {
    const longText = '本店代购正品 加我微信 优惠促销 数量有限 先到先得 欢迎咨询 长期有效'
    const hit = detectAd(longText, settings)
    assert.ok(hit && hit.reason.startsWith('keywords='), `expected keyword match, got ${hit?.reason}`)
    assert.ok(hit.keywords.length >= 2)
  })

  it('a short message with one strong keyword stays below the threshold (dampened)', () => {
    // 秒杀 + 咨询 is strong+weak; a <10-char message leaves almost none of
    // its keyword evidence (superlinear dampening), so it does not clear.
    assert.equal(detectAd('秒杀 咨询', settings), null)
  })

  it('a very short contact-only message is NOT an ad (no pitch, no URL)', () => {
    // "加我私聊" / "加我微信私聊" are private-chat invitations — bare contact
    // words with no promotional pitch and no link. Contact words are general
    // hits; without a strong promo keyword or a suspicious URL they never flag.
    assert.equal(detectAd('加我私聊', settings), null)
    assert.equal(detectAd('加我微信私聊', settings), null)
    assert.equal(detectAd('加我qq私聊', settings), null)
    // Contact words paired with a promo/urgency pitch form the ad's structure:
    // "加我私聊 优惠 先到先得 名额有限" is the same pitch+hook shape as
    // "团购优惠券，联系客服" and now flags.
    assert.ok(detectAd('加我私聊 优惠 先到先得 名额有限', settings))
    // A concrete promo code is a structural offer, so the same contact words DO flag.
    const hit = detectAd('加我微信 优惠码 ABC123 立减100', settings)
    assert.ok(hit, 'a structured message with a promo code should flag')
  })

  it('contact-only messages never flag, no matter the length (no pitch to ad)', () => {
    assert.equal(detectAd(`加我私聊 ${'的'.repeat(500)}`, settings), null)
    assert.equal(detectAd(`加V 咨询 ${'的'.repeat(500)}`, settings), null)
    // Adding a promo pitch flips it.
    const hit = detectAd(`加V 咨询 免费送 ${'的'.repeat(500)}`, settings)
    assert.ok(hit, 'a promo pitch plus contact words should flag')
  })

  it('a long message with the same hits flags (length evidence)', () => {
    const pad = '这是一段非常长的正常聊天内容'.repeat(20)
    const hit = detectAd(`秒杀 咨询${pad}`, settings)
    assert.ok(hit, 'length evidence should push the strong+weak pair over the threshold')
  })

  it('a few generic words alone never flag, no matter the length', () => {
    assert.equal(detectAd('客服 咨询 QQ', settings), null)
    assert.equal(detectAd(`客服 咨询 QQ ${'水'.repeat(300)}`, settings), null)
  })

  it('a long message with a lone keyword never flags (ad features must co-occur)', () => {
    // One strong keyword (贷款 even has an LR override) in a 500-char post:
    // a member writing a long article, not an ad.
    assert.equal(detectAd(`贷款 ${'水'.repeat(500)}`, settings), null)
    assert.equal(detectAd(`加V ${'水'.repeat(500)}`, settings), null)
  })

  it('a lone suspicious URL never flags (sharing a link is a recommendation)', () => {
    assert.equal(detectAd('大家看看这个 http://example.com/product/123', settings), null)
    assert.equal(detectAd('这家店不错 https://weird-shop.xyz/item', settings), null)
  })

  it('a safe platform URL with weak words never flags', () => {
    // jd.com is on the safe-URL whitelist: link sharing + generic promo words.
    assert.equal(detectAd('https://item.jd.com/123456789 有优惠 打折', settings), null)
  })

  it('a suspicious URL plus keyword hits flags', () => {
    const hit = detectAd('加V 咨询 点击 http://sketchy.xyz/abc', settings)
    assert.ok(hit, 'suspicious URL should tip the strong+weak pair')
    assert.ok(hit.keywords.length >= 2)
  })

  it('weak words in a long message with a suspicious URL flag', () => {
    const hit = detectAd(`优惠 打折 促销 限时 ${'水'.repeat(300)} http://x-tutorials.top/course`, settings)
    assert.ok(hit, 'URL + generic hits + length co-occur as ad evidence')
  })

  it('a bare suspicious domain embedded after CJK text flags (URL must not be missed)', () => {
    // No whitespace before the domain: "来de98.top中转站". The bare-host scan
    // must find it; promo words + suspicious .top URL co-occur as an ad.
    const hit = detectAd('优惠大促销,来de98.top中转站优惠', settings)
    assert.ok(hit, `expected the de98.top ad to flag, got ${hit?.reason ?? 'null'}`)
  })

  it('a single keyword repeated as 刷屏 is NOT an ad (attention-seeking, not low-effort spam)', () => {
    // Repeated single sensitive word: discounted repetition, stays below threshold.
    assert.equal(detectAd('加V 加V 加V 加V 加V 加V 咨询', settings), null)
    assert.equal(detectAd('促销促销促销促销促销促销促销', settings), null)
    // The same keywords used once each with a strong pitch in a normal-length
    // message DO flag (免费送/秒杀 are strong; urgency words are general only).
    const hit = detectAd('加V 咨询 促销 优惠 免费送 秒杀', settings)
    assert.ok(hit, 'multiple distinct ad keywords should flag')
  })

  it('a lone per-keyword-overridden strong hit (刷单) outweighs the class default', () => {
    // 刷单 has a keywordLrs override (LR 100 > strongLr 40) in config/ad.json;
    // both messages are identical in structure and length.
    const pad = '的'.repeat(settings.bayes.chatLength)
    const scored = detectAd(`刷单 咨询 客服 培训 ${pad}`, settings)
    const baseline = detectAd(`代购 咨询 客服 培训 ${pad}`, settings)
    assert.ok(scored && baseline, 'both messages should be flagged')
    const pOf = (hit: NonNullable<typeof scored>): number =>
      Number.parseFloat(hit.reason.split('p(ad)=')[1])
    assert.ok(pOf(scored) > pOf(baseline), 'the overridden keyword should score higher')
  })

  it('a lone contact pattern in a long message is soft, not a hard flag', () => {
    // A short "扣扣：987654321" is clearly the hook -> hard flag. The same
    // contact info buried inside a long post is a discussion, not an ad.
    assert.ok(detectAd('扣扣：987654321', settings))
    assert.equal(detectAd(`扣扣：987654321 ${'水'.repeat(50)}`, settings), null)
  })

  it('two contact patterns co-occur as a hard flag even when long', () => {
    const hit = detectAd(`加微信 abc12345 加QQ 987654321 ${'水'.repeat(50)}`, settings)
    assert.ok(hit, 'two contact hooks in one message are ad-like regardless of length')
  })

  it('a reply to an earlier message is dampened (conversational, not a pitch)', () => {
    // 优惠券 is a general word now; a reply sharing one stays off the recall path.
    assert.equal(detectAd('这个优惠券可以用', settings, { reply: true }), null)
    // A concrete promo code in a reply is still an offer and still flags.
    assert.ok(detectAd('用这个优惠码 BLACKFRIDAY30 吧', settings, { reply: true }))
  })

  it('empty and keyword-free text is not flagged', () => {
    assert.equal(detectAd('', settings), null)
    assert.equal(detectAd('今天天气不错', settings), null)
  })

  it('multi-line messages are analyzed as a single message', () => {
    // A promo spread over several lines still co-occurs and flags.
    assert.ok(detectAd('秒杀半价！\n优惠券领取：\n链接在下面，先到先得', settings))
    // A multi-line discussion keeps the dampened / no-pitch behavior.
    assert.equal(detectAd('请问有人推荐训练营吗\n报名链接发我一下\n谢谢', settings), null)
    assert.equal(detectAd('有H100出租\n按小时计费\n欢迎联系客服', settings), null)
  })

  it('demoted promo words paired with a hook are a pitch again', () => {
    // 团购/优惠券/先到先得 were demoted from strong, so alone they are weak
    // hits — but next to a contact hook (联系客服/加我私聊) they form the ad's
    // structure and must flag again.
    assert.ok(detectAd('限时团购，优惠券先到先得，联系客服', settings))
    assert.ok(detectAd('兼职日薪300，加我私聊', settings))
    assert.ok(detectAd('出售账号，低价优惠，加我私聊', settings))
  })

  it('price/register/cta structures can trigger detection on their own', () => {
    // An explicit price promo + call-to-action is a pitch even without a strong
    // keyword or a suspicious URL.
    assert.ok(detectAd('限时优惠 满100减50 马上报名', settings))
  })

  it('a lone pitch word or a lone hook is not a pitch', () => {
    // 名额有限/先到先得 in an event notice — no hook — stays chat.
    assert.equal(detectAd('名额有限 先到先得', settings), null)
    // A lone contact hook without any pitch word is a private invitation.
    assert.equal(detectAd('扫码进群', settings), null)
  })

  it('resetAdRules restores the config base', () => {
    resetAdRules()
    const matcher = getAdKeywordMatcher()
    assert.ok(matcher.size >= 100)
  })
})
