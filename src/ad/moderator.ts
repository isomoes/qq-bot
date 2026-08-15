import type { Bot, GroupMessageEvent } from 'qq-official-bot'
import { config } from '../config'
import { detectAd } from './detector'
import { getAdSettings } from './settings'

/**
 * Ad moderation for group messages.
 *
 * On each detected ad it recalls the message and records a strike against the
 * sender. Once a sender reaches the configured strike limit, a normal reply
 * message is sent once in the group. The QQ official group API cannot mute or
 * kick members, so removing the member remains a manual admin action.
 *
 * State is in-memory and resets on restart.
 */
export class AntiAd {
  /** Strike count + last-strike time keyed by `${group_id}:${user_id}`. The
   *  timestamp feeds the lazy pruning below, which keeps this map (and the
   *  `alerted` set derived from it) bounded across a long-running bot. */
  private readonly strikes = new Map<string, { count: number; time: number }>()
  /** Keys already alerted, to avoid duplicate messages. */
  private readonly alerted = new Set<string>()
  /** Recent messages per group keyed by message_id, so a reply to a recent
   *  message can be recognised (the QQ API only gives us the referenced
   *  message_id, not its content). Capped and pruned by age. */
  private readonly recent = new Map<string, Map<string, { time: number }>>()
  /** How long a message stays relevant as a reply target. */
  private static readonly RECENT_TTL_MS = 10 * 60_000
  /** Max cached messages per group. */
  private static readonly RECENT_MAX_PER_GROUP = 200
  /** How long a strike stays relevant before it is pruned. */
  private static readonly STRIKE_TTL_MS = 30 * 24 * 60 * 60_000
  /** Cap on retained strike entries; beyond it the oldest age out first. */
  private static readonly MAX_STRIKE_ENTRIES = 10_000
  /** Minimum gap between strike sweeps, so a busy group doesn't O(n) every msg. */
  private static readonly PRUNE_INTERVAL_MS = 60_000

  /** Last time the strike sweep ran (0 = never; forces a first sweep). */
  private lastPrunedAt = 0

  constructor(private readonly bot: Bot) {}

  /** Lazily prune expired strikes (and alerts derived from them). Runs at most
   *  once per PRUNE_INTERVAL_MS; entries older than STRIKE_TTL_MS are dropped,
   *  and the newest MAX_STRIKE_ENTRIES are kept when the map outgrows the cap. */
  private pruneStrikes(now: number): void {
    if (now - this.lastPrunedAt < AntiAd.PRUNE_INTERVAL_MS) return
    this.lastPrunedAt = now
    for (const [key, rec] of this.strikes) {
      if (now - rec.time > AntiAd.STRIKE_TTL_MS) this.strikes.delete(key)
    }
    if (this.strikes.size > AntiAd.MAX_STRIKE_ENTRIES) {
      const sorted = [...this.strikes.entries()].sort((a, b) => a[1].time - b[1].time)
      const drop = sorted.length - AntiAd.MAX_STRIKE_ENTRIES
      for (const [key] of sorted.slice(0, drop)) this.strikes.delete(key)
    }
    for (const key of this.alerted) {
      if (!this.strikes.has(key)) this.alerted.delete(key)
    }
  }

  /** Remember a message as a potential reply target, pruning stale entries. */
  private remember(e: GroupMessageEvent): void {
    const now = Date.now()
    let group = this.recent.get(String(e.group_id))
    if (!group) {
      group = new Map()
      this.recent.set(String(e.group_id), group)
    }
    if (group.size >= AntiAd.RECENT_MAX_PER_GROUP) {
      const oldest = [...group.entries()].sort((a, b) => a[1].time - b[1].time)[0]
      if (oldest) group.delete(oldest[0])
    }
    group.set(String(e.message_id), { time: now })
    for (const [id, rec] of group) {
      if (now - rec.time > AntiAd.RECENT_TTL_MS) group.delete(id)
    }
  }

  /** True when `e` is a reply to a message the bot has seen recently. */
  private isReply(e: GroupMessageEvent): boolean {
    const ref = e.source?.message_id ?? e.source?.id
    if (ref === undefined) return false
    const group = this.recent.get(String(e.group_id))
    return group?.has(String(ref)) === true
  }

  /**
   * Inspect a group message. If it is an ad: recall it, add a strike, and send
   * an alert message once the strike limit is reached.
   *
   * @returns true if the message was handled as an ad
   */
  async inspect(e: GroupMessageEvent): Promise<boolean> {
    const now = Date.now()
    // Remember every message as a potential reply target before judging, so
    // follow-ups can be recognised as replies.
    this.remember(e)
    const match = detectAd(e.raw_message, getAdSettings(), { reply: this.isReply(e) })
    if (!match) return false

    const key = `${e.group_id}:${e.user_id}`
    this.pruneStrikes(now)
    const prev = this.strikes.get(key)
    const count = (prev?.count ?? 0) + 1
    this.strikes.set(key, { count, time: now })

    // Control characters in a user-chosen name could forge log lines or break
    // the alert message; collapse them to a space before logging or replying.
    const name = e.sender.user_name.replace(/[\u0000-\u001f\u007f]+/g, ' ')
    const detail = match.keywords.length ? ` [${match.keywords.join(', ')}]` : ''
    this.bot.logger.warn(
      `[anti-ad] ad from ${name}(${e.user_id}) in group ${e.group_id} ` +
        `— ${match.reason}${detail} — strike ${count}/${config.adStrikeLimit}`,
    )

    // At the strike limit, send a normal reply message once. Do this before the
    // recall so the passive reply still references the triggering message.
    if (count >= config.adStrikeLimit && !this.alerted.has(key)) {
      this.alerted.add(key)
      try {
        await e.reply(
          `Ad alert: "${name}" (${e.user_id}) has posted ${count} ads. ` +
            `Please have an admin remove this member.`,
        )
      } catch (err) {
        this.bot.logger.error('[anti-ad] failed to send alert message:', err)
      }
    }

    // Recall the offending message (best-effort; may require permission).
    try {
      await this.bot.recallGroupMessage(e.group_id, e.message_id)
    } catch (err) {
      this.bot.logger.error(`[anti-ad] failed to recall message ${e.message_id}:`, err)
    }

    return true
  }
}
