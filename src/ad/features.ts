/**
 * Structural ad-feature extraction (lightweight NLP, no AI models).
 *
 * Beyond keyword hits, real Chinese ads follow predictable *structures* that
 * ordinary chat does not: a concrete offer code (优惠码 AIPRO100), an explicit
 * price pitch (立减500 / 满100减50 / 打7折), an enrollment funnel (报名链接,
 * 训练营), a paid-service pitch (出租 / 代充 / 按小时计费 + 联系客服), a call to
 * action (想上车 / 有需要联系), and the pitch+contact cluster (团购/优惠券/先到先得
 * next to 联系/加我/私聊 — the demoted promo words *with* a hook). Detecting the
 * structure is far more discriminative than the individual words: "报名链接" in a
 * question thread is chatter, in an enrollment post it is the funnel.
 *
 * The flip side is the conversational signals: questions, replies to another
 * member, and collaboration requests (找合伙人 / 组队 / 内推 / 求推荐) are how a
 * tech group actually talks. When one is present the detector dampens the *soft*
 * keyword/contact evidence (never the hard structural signals).
 */

/** Regexes grouped by the structural ad feature they signal. */
export const PROMO_CODE_RE = /(优惠码|折扣码|优惠券码|兑换码|邀请码|体验码|福利码)\s*[:：=]?\s*([a-zA-Z0-9][a-zA-Z0-9_-]{3,})/
export const PRICE_PROMO_RE =
  /(立减|直降|秒杀价|原价)\s*[￥¥$]?\s*\d+|满\d+\s*减\s*\d+|第\d+件半价|[0-9一二三四五六七八九十]+\s*折(?!的|[0-9]折)/
export const REGISTER_RE = /(报名|开课|训练营|集训营)[^。\n]{0,20}(链接|官网|通道|参加|名额|报名|免费|即可)|(训练营|集训营|开课)/
export const SERVICE_RE =
  /(出租|代充|代充值|代挂|代做|按小时计费|包月|合作价|首月|企业折扣|内部价)[^。\n]{0,24}(联系|客服|微信|加|价格|价|元|%|[％]|优惠|便宜)|(代充|代充值|按小时计费|出租)/
export const CTA_RE = /(想上车|欢迎扩散|有需要联系|有需要的?联系|需要的?联系|联系我|私信我|私我|滴滴我|扫我|赶紧来|立即加入|马上报名|手慢无|快上车|趁早)/
export const QUESTION_RE = /[?？]\s*$|(有没有|谁知道|请问|求推荐|求问|有人用|大家推荐|有推荐|值得|靠谱吗|怎么样|怎么选|如何选|好不好|了解过|用过的|推荐一个|有.{0,6}吗)/
export const COLLAB_RE =
  /(找|招).{0,12}(合伙人|队友|搭子|伙伴|组员)|(一起|组队|组个队).{0,10}(做|创业|搞|合伙)|(帮忙|帮改|求助|内推|求内推|求个|求推荐|拼单|求.{0,6}(指点|推荐|内推|指教)|合伙)/

/** Promo/urgency/job/selling words — the *pitch* half of a pitch+contact ad
 *  (团购/优惠券/先到先得 on one side, 兼职/日薪/出售 on the other). These are
 *  the demoted strong keywords plus selling/job terms: individually they are
 *  ordinary chat, but next to a contact hook they form the ad's call to action. */
const PITCH_WORDS =
  '团购|优惠券|折扣|优惠|促销|特惠|秒杀|特价|低价|清仓|甩卖|半价|返利|返现|免费送|包邮|立减|满减|充值|' +
  '出售|转让|出号|低价出|' +
  '兼职|日结|高薪|日薪|周薪|月薪|年薪|提成|佣金|招聘|急招|刷单|' +
  '限时|仅剩|先到先得|名额有限|机不可失|速来|趁早|限量|抢购'

/** Contact/action hooks — the other half of a pitch+contact ad. `链接` is
 *  deliberately absent: sharing a link is a recommendation, not a hook. */
const HOOK_WORDS =
  '加我|加V|加微信|微信|QQ|扣扣|私聊|私信|联系|客服|咨询|扫码|领取|报名|入手|发你|找我|戳我|私我|购买|下单|订阅|获取'

/** A pitch word adjacent to a contact hook, in either order: 优惠券…联系客服,
 *  兼职日薪…加我私聊, 低价优惠…私我. The short window never crosses 。！？\n, so a
 *  multi-sentence "分享个优惠…加我微信" or a pitch sitting a sentence away from a
 *  hook stays chat; a compact "团购优惠券，联系客服" is a pitch. A lone pitch word
 *  (名额有限 in an event notice) or a lone hook (扫码进群) is not. */
export const PITCH_RE = new RegExp(
  `(${PITCH_WORDS})[^。！？\\n]{0,20}(${HOOK_WORDS})|(${HOOK_WORDS})[^。！？\\n]{0,20}(${PITCH_WORDS})`,
)

/** Which structural ad signals were found, and which conversational dampeners
 *  apply. */
export interface AdFeatures {
  /** Concrete promo/coupon/invite code present (优惠码 AIPRO100). Hard signal. */
  code: boolean
  /** Explicit price-promo structure present (立减500 / 满100减50 / 打7折). */
  price: boolean
  /** Enrollment funnel present (报名链接 / 训练营 / 开课). */
  register: boolean
  /** Paid-service pitch present (出租 / 代充 / 按小时计费 + contact). */
  service: boolean
  /** Call-to-action present (想上车 / 有需要联系 / 欢迎扩散). */
  cta: boolean
  /** Pitch+contact structure present (团购/优惠券/兼职/出售 … 联系/加我/私聊).
   *  The demoted promo/urgency words plus a hook — the ad's actual structure. */
  pitch: boolean
  /** Reads like a question — dampen soft keyword/contact evidence. */
  question: boolean
  /** Reads like collaboration / help-seeking — dampen soft evidence. */
  collab: boolean
}

export const NO_FEATURES: AdFeatures = {
  code: false,
  price: false,
  register: false,
  service: false,
  cta: false,
  pitch: false,
  question: false,
  collab: false,
}

/** Extract the ad features of a message. */
export function analyzeFeatures(text: string): AdFeatures {
  return {
    code: PROMO_CODE_RE.test(text),
    price: PRICE_PROMO_RE.test(text),
    register: REGISTER_RE.test(text),
    service: SERVICE_RE.test(text),
    cta: CTA_RE.test(text),
    pitch: PITCH_RE.test(text),
    question: QUESTION_RE.test(text),
    collab: COLLAB_RE.test(text),
  }
}
