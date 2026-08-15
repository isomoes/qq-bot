import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectAd } from '../src/ad/detector'
import { getAdSettings } from '../src/ad/settings'

/**
 * The real-world regression set: a realistic tech/AI community conversation.
 * Most messages are benign chatter (a member asks, replies, shares a paper, a
 * tool, a book, a cloud coupon); a few are genuine ads the detector must still
 * catch. Messages that continue a thread are marked `reply` — replying is how
 * the group talks, not how spam is written, so their soft evidence is dampened.
 *
 * Expected ads: #5 (course promo + promo code), #10 (paid GPU rental),
 * #18 (discount code + price + CTA), #24 (competition registration + invite
 * code), #27 (paid API recharge service).
 */
const cases: { text: string; reply?: boolean; ad?: boolean }[] = [
  { text: `@所有人 兄弟们，刚看到Qwen2.5-72B的推理速度又优化了，实测比上一代快18%，我跑了下自己的RAG任务，效果确实有提升。模型地址：https://huggingface.co/Qwen/Qwen2.5-72B-Instruct 你们谁在生产环境切了？说说坑？` },
  { text: `我切了，主要注意量化后精度下降，如果用AWQ要调参。另外官方推荐的这个微调脚本 https://github.com/QwenLM/Qwen2.5/tree/main/finetune 里有几个参数默认值不太适合中文长文本，建议改成max_len=8192。`, reply: true },
  { text: `老张说得对，我也踩过坑。顺便问下，有没有人用DeepSeek-V3做代码补全的？我想做个内部工具，但API价格有点高，有团购渠道吗？我这边有企业认证，可以开团队订阅，加我微信私聊（微信号：ai_coder_666），备注"DeepSeek"就行。`, reply: true },
  { text: `大佬带带我！我刚入行，正在学LangChain，有没有好的教程推荐？最好是免费的，付费的也行，别太贵。` },
  { text: `我这边有个《LangChain实战+Agent开发》训练营，本周五开课，原价2999，现在用优惠码 AIPRO100 立减500，报名链接：https://aicourse.example.com/langchain 课程含企业级项目，适合0-3年经验。不是广告哈，我自己听过觉得不错，纯分享。`, reply: true, ad: true },
  { text: `你那个课我上过，确实干货多，不过建议小白先看官方文档，不然跟不上。对了，我们组最近在招AI应用工程师，Base上海/远程，主要做LLM微调，要求熟悉PyTorch和HuggingFace，JD在这：https://jobs.example.com/ai-engineer 欢迎私聊内推，我可以帮改简历，内推码：NEI-2025。`, reply: true },
  { text: `内推码是啥？直接投递就行吗？我刚好在看机会，3年经验，主要做NLP。另外问下，你们用哪家云服务？我们想换供应商，听说火山引擎最近有促销，算力券5折，链接：https://volcengine.com/promo 不知道靠谱不。`, reply: true },
  { text: `火山引擎我用了半年，稳定性还行，不过注意他们那个优惠券只针对新用户，老用户得走企业合同。我们刚续费了AWS，如果有兴趣我可以帮拉个AWS的折扣群，加我钉钉：liyun_arch，备注"云折扣"。`, reply: true },
  { text: `@所有人 重磅！Meta刚刚开源了Llama 4的微调版，支持128K上下文，GitHub地址：https://github.com/meta-llama/llama4 我连夜测试了，长文档摘要效果炸裂，不过需要A100*8才能跑，有没有人有集群资源可以拼单？我们按时间分摊费用，有意私聊。` },
  { text: `我有H100集群，可以出租，按小时计费，价格比AWS便宜30%，详情看这个文档：https://gpu-share.example.com/pricing 首次租用送2小时试用，联系客服报暗号"AI程序员"即可。`, ad: true },
  { text: `刚看完《机器学习系统设计》这本书，推荐给做MLOps的同行，京东购买链接：https://item.jd.com/12345678.html 我现在在写读书笔记，后续会发到我的博客（https://blog.chen.com），欢迎交流。` },
  { text: `书不错，但定价有点贵，我找到个PDF（仅供学习），需要的话我发网盘，链接：https://pan.baidu.com/s/1abc... 提取码: mlai 不过还是支持正版哈。`, reply: true },
  { text: `兄弟们，Kaggle上有个新比赛"LLM安全检测"，奖金10万刀，报名地址：https://kaggle.com/competitions/llm-safety 我们组队还缺一个擅长Prompt工程的，有意加我微信：kaggle_leader，备注"组队"。` },
  { text: `插播一条招聘：我司（AI独角兽）急招大模型算法工程师，薪资60-100W，期权可谈，工作地北京/杭州。简历直接发我邮箱：xiaolu@ai-company.com 邮件标题注明"大模型岗位"，我会优先处理。内推成功有红包，欢迎扩散。` },
  { text: `我最近在维护一个RAG工具包，支持多种向量库，欢迎Star和PR：https://github.com/rag-tool/rag-studio 另外我们有个技术交流群，扫码进（二维码已发），群内会定期分享最新论文解读，纯技术讨论，无广告。` },
  { text: `arXiv今天又上新了，这篇《Chain-of-Thought with Active Retrieval》挺有意思，链接：https://arxiv.org/abs/2508.12345 我翻译了中文摘要贴在群文件了，大家可以去下载。` },
  { text: `发现一个超好用的Prompt管理工具，叫PromptDesk，官网：https://promptdesk.io 支持团队协作，还能版本对比，免费版够用。我写了一篇测评，发在我公众号了，关注后回复"prompt"获取，不是广告，真心觉得好用。` },
  { text: `我用了，确实不错，不过注意他们的付费版有额外功能，最近黑五折扣码 BLACKFRIDAY30 可以打7折，想上车的趁早。`, reply: true, ad: true },
  { text: `我们组明天下午有个线上技术分享，主题是"MoE架构在大模型中的应用"，免费参加，腾讯会议号：123-456-789，密码：AI123。会上会发布我们内部的一个MoE工具包，试用名额有限，先到先得，感兴趣的来。` },
  { text: `各位，我整理了一份《AI程序员常用工具清单》，包含IDE插件、调试工具、模型可视化等，PDF下载链接：https://t.cn/xxx 提取码: ai888 如果觉得有用，请帮我点个"在看"，谢谢！` },
  { text: `我们团队在做AI编程助手的创业项目，现需要找一位有编译器背景的合伙人，技术入股，可远程。项目介绍：https://startup-pitch.com/ai-code 有兴趣的私聊我，非诚勿扰。` },
  { text: `最近买了几张RTX 4090，想组一台本地训练机器，有没有推荐的装机配置？京东链接：https://item.jd.com/xxx（主板）、https://item.jd.com/yyy（电源） 另外电源要选多少W？求大佬指点。` },
  { text: `建议至少1200W，我用的这款海盗船，链接：https://amazon.com/... 另外，如果预算够，可以上H100云实例，我们公司有合作价，加我企业微信（二维码在群公告）咨询。`, reply: true },
  { text: `由我们社区主办的"AI应用创新大赛"开始报名了，一等奖5万元，还有云资源包，报名官网：https://ai-hackathon.com 使用邀请码 AICODER 可免报名费，欢迎大家组队参加，我们也会提供baseline代码。`, ad: true },
  { text: `这个比赛我参加过上一届，很不错。对了，谁能帮忙内推一下字节的AI岗位？我看官网有职位，但投递一直没反馈，有内推码的大佬请私我，感激不尽！`, reply: true },
  { text: `我有内推码，私发你了（BYTE2025），投递时填入即可，可以优先筛选。另外我们AI Lab最近发了几篇论文，有兴趣的可以看：https://research.bytedance.com 欢迎交流。` },
  { text: `刚测了Claude 3.7 Sonnet和GPT-4o在数学推理上的表现，详细对比报告我放在Notion了：https://notion.so/... 结论是Claude稍强，但GPT响应更快。另外，如果大家想用Claude API，我可以提供代充值服务（正规渠道），有需要联系。`, ad: true },
  { text: `提醒大家注意，最近有钓鱼网站冒充HuggingFace，实际域名是 huggingface.co.xx ，大家下载模型时注意核对。官方正确地址是 https://huggingface.co 另外，我们团队开源了一个模型安全扫描工具，GitHub: https://github.com/security-ai/scan 欢迎试用。` },
  { text: `下班前水一下，有没有人抢到过算力平台的免费额度？比如AutoDL、恒源云，我经常看他们发优惠券，今天又看到个：AUTODL50 满100减50，真香，链接：https://autodl.com/coupon 大家赶紧。` },
  { text: `@所有人 本群是技术交流群，禁止刷屏广告，但以上大家发的招聘、课程、工具、比赛等纯属群友互助，机器人误判的话请管理员手动放行。另外，我们下周三组织线下 meetup，报名链接稍后发，有兴趣的留意群公告。` },
]

describe('real community conversation regression (30 messages)', () => {
  const settings = getAdSettings()

  cases.forEach((c, i) => {
    const label = c.ad ? 'ad' : 'pass'
    it(`#${i + 1} should ${label}: ${c.text.slice(0, 18)}…`, () => {
      const hit = detectAd(c.text, settings, { reply: c.reply === true })
      if (c.ad) {
        assert.ok(hit, `expected #${i + 1} to be flagged: ${c.text}`)
      } else {
        assert.equal(hit, null, `#${i + 1} should NOT be flagged: ${c.text}`)
      }
    })
  })
})