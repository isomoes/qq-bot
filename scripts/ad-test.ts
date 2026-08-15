/**
 * Ad-detection test tool.
 *
 * Paste or pass a message and see the full scoring breakdown: matched
 * keywords with their likelihood-ratio weights, URL evidence, length evidence
 * and the final ad confidence (0..1) against the configured threshold.
 *
 * Usage:
 *   pnpm ad-test "加V 咨询 客服 http://sketchy.xyz/abc"
 *   pnpm ad-test                          # interactive loop; Ctrl+C to exit
 *   pnpm ad-test --threshold=0.8 "..."    # test against a different threshold
 *
 * `--threshold` only overrides the flag threshold for this run; it does not
 * touch config/ad.json.
 */

import { createInterface } from 'node:readline'
import { analyzeAd, type AdAnalysis } from '../src/ad/detector'
import { getAdSettings, type AdSettings } from '../src/ad/settings'

function parseThreshold(raw: string): number | undefined {
  if (!raw.startsWith('--threshold=')) return undefined
  const n = Number.parseFloat(raw.slice('--threshold='.length))
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : undefined
}

function withThreshold(settings: AdSettings, threshold: number | undefined): AdSettings {
  if (threshold === undefined || threshold === settings.bayes.threshold) return settings
  return {
    ...settings,
    bayes: { ...settings.bayes, threshold },
  }
}

const W = 10
const pad = (s: string, w: number): string => s.padEnd(w)
const sign = (n: number): string => (n >= 0 ? '+' : '')

function keywordTable(a: AdAnalysis): string[] {
  const lines: string[] = []
  lines.push(`  ${pad('匹配词', 12)}${pad('次数', 4)}${pad('strong', 8)}${pad('LR', W)}${pad('权重', W)}${pad('贡献log-odds', 14)}`)
  for (const k of a.keywords) {
    lines.push(
      `  ${pad(k.keyword, 12)}${pad(String(k.count), 4)}${pad(k.strong ? '是' : '否', 8)}` +
        `${pad(k.lr.toFixed(1), W)}${pad(k.weight.toFixed(4), W)}${sign(k.logOdds)}${k.logOdds.toFixed(4)}`,
    )
  }
  lines.push(`  小计(缩放前): ${sign(a.keywordLogOdds)}${a.keywordLogOdds.toFixed(4)}`)
  if (a.shortScale !== 1)
    lines.push(`  长度短消息衰减 shortScale=${a.shortScale.toFixed(4)} → 缩放后 ${sign(a.keywordLogOdds * a.shortScale)}${(a.keywordLogOdds * a.shortScale).toFixed(4)}`)
  return lines
}

function urlSection(a: AdAnalysis): string[] {
  const lines: string[] = []
  if (a.urls.length === 0) {
    lines.push('  (无 URL)')
    return lines
  }
  for (const u of a.urls) {
    lines.push(`  ${pad(u.url, 30)} 域名:${u.host}  白名单:${u.benign ? '是' : '否'}  可疑TLD:${u.suspiciousTld ? '是' : '否'}`)
  }
  lines.push(`  可疑URL: ${a.urls.some((u) => !u.benign) ? '是' : '否'}  可疑TLD: ${a.urls.some((u) => u.suspiciousTld) ? '是' : '否'}`)
  return lines
}

function render(text: string, settings: AdSettings): void {
  const a = analyzeAd(text, settings)
  const bar = '─'.repeat(58)
  const done = a.flagged ? '★ 判定为广告 → 撤回' : '· 非广告 → 不撤回'

  console.log(`\n${bar}`)
  console.log(`输入: ${a.text.replace(/\r?\n/g, '\\n')}`)
  console.log(`长度: ${a.length} `)

  const feat = a.features
  const feats = [
    feat.code ? '优惠码' : '',
    feat.price ? '价格结构' : '',
    feat.register ? '报名漏斗' : '',
    feat.service ? '服务兜售' : '',
    feat.cta ? '行动号召' : '',
    feat.pitch ? '推销话术' : '',
    feat.question ? '提问语气' : '',
    feat.collab ? '协作/求助' : '',
  ].filter(Boolean)
  console.log(`\n[结构特征] ${feats.length ? feats.join(', ') : '(无)'}${a.reply ? '  回复上一条' : ''}`)

  if (a.trigger === 'pattern') {
    console.log(`\n[模式命中] (强信号正则, 直接判定)`)
    for (const p of a.patterns) console.log(`  /${p}/`)
    for (const p of a.contactPatterns) console.log(`  /${p}/ (contact${a.contactHard ? '' : ', 软证据'})`)
  } else {
    console.log(`\n[关键词命中] ${a.keywordHits} 个不同词 (minKeywordHits=${a.minKeywordHits})`)
    if (a.keywords.length > 0) {
      console.log(keywordTable(a).join('\n'))
      console.log(`  强信号词(strong/高LR): ${a.hardKeyword ? '是' : '否'}`)
      const softOnly =
        !a.hardKeyword && !a.urls.some((u) => !u.benign) && !a.features.code && !a.features.service &&
        !a.features.price && !a.features.register && !a.features.cta && !a.features.pitch
      if (softOnly) console.log('  无 strong 词/可疑URL/促销结构 → 广告特征未共现, 不进关键词评分')
    } else {
      console.log(`  未达到评分门槛, 跳过关键词评分`)
    }
  }

  console.log(`\n[URL]`)
  console.log(urlSection(a).join('\n'))

  console.log(`\n[score]`)
  const damp =
    a.dampeningFactor !== 1 ? ` (语气衰减 ×${a.dampeningFactor.toFixed(2)}${a.reply ? ', 回复' : ''}${a.features.question ? ', 提问' : ''}${a.features.collab ? ', 协作' : ''})` : ''
  console.log(`  logit         : ${sign(a.priorLogit)}${a.priorLogit.toFixed(4)}`)
  console.log(`  keyword       : ${sign(a.keywordLogOdds)}${a.keywordLogOdds.toFixed(4)}${damp}`)
  if (a.contactLogOdds !== 0) console.log(`  contact    : ${sign(a.contactLogOdds)}${a.contactLogOdds.toFixed(4)}`)
  if (a.pitchLogOdds !== 0) console.log(`  pitch         : ${sign(a.pitchLogOdds)}${a.pitchLogOdds.toFixed(4)}${damp}`)
  if (a.structureLogOdds !== 0) console.log(`  construct     : ${sign(a.structureLogOdds)}${a.structureLogOdds.toFixed(4)}`)
  console.log(`  length        : ${sign(a.lengthLogOdds)}${a.lengthLogOdds.toFixed(4)}`)
  console.log(`  URL           : ${sign(a.urlLogOdds)}${a.urlLogOdds.toFixed(4)}`)
  console.log(`  log-odds      : ${sign(a.logOdds)}${a.logOdds.toFixed(4)}`)
  console.log(`  置信度 P(ad)  : ${a.probability.toFixed(4)}`)
  console.log(`  阈值          : ${a.threshold}`)
  console.log(`  结论          : ${done}`)
  console.log(bar)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const thresholdRaw = args.find((s) => s.startsWith('--threshold='))
  const threshold = thresholdRaw ? parseThreshold(thresholdRaw) : undefined
  const settings = withThreshold(getAdSettings(), threshold)
  const inputs = args.filter((s) => !s.startsWith('--'))

  if (threshold !== undefined) console.log(`(阈值覆盖: 0.60 → ${threshold}, 仅本次运行)`)

  if (inputs.length > 0) {
    for (const t of inputs) render(t, settings)
    return
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log('交互模式: 输入消息回车即可看到评分; 输入 exit/quit 或 Ctrl+C 退出')
  for await (const line of rl) {
    const t = line.trim()
    if (t === 'exit' || t === 'quit' || t === 'q') break
    if (t) render(t, settings)
  }
  rl.close()
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})