'use strict';

/**
 * 检索路由：让模型自己判断「这句话要不要联网」，而不是靠关键词表。
 *
 * 为什么需要它：关键词永远追不上人的说法 —— 「B站的热搜是什么」命中「热搜」
 * 却去查头条榜；「小蓝鲸是什么梗」一个词都不命中就永远不查。这里用一次很短的
 * 模型调用做语义判断，并顺手把查询词改写成能搜到东西的形式。
 *
 * 失败时返回 { need:false, failed:true }，由调用方回退到关键词规则，保证不退化。
 */

const SCHEMA_HINT = `只输出 JSON，不要解释、不要代码块围栏。格式：
{"need":true,"query":"检索词（不超过 14 个字）","site":"bilibili|weibo|toutiao|"}
或
{"need":false}`;

const SYSTEM = `你是一个检索路由器。判断用户这句话是否需要联网查「当前或具体的事实信息」。

需要联网的典型情况：
- 新闻、热搜、热榜、时事、赛事结果
- 价格、报价、参数、发布时间、销量
- 天气、气温、限行
- 某个你可能记不准的具体事实（新出的产品/型号、某个人的近况、某个作品的最新进度）
- 明显是「我刚看到的，你查查」这类指向外部事实的话
- 用户明确让你查、搜、看看

不需要联网的典型情况：
- 打招呼、闲聊、情绪倾诉、撒娇、拌嘴
- 问对方的观点、喜好、感受（“你觉得…”“你喜欢吗”）
- 让你做事、翻译、写东西、讲笑话、角色扮演
- 常识性、不会变的知识（水的沸点、红楼梦作者）
- 只是在复述或回应上一句

site 字段：明确提到 B站/哔哩哔哩 用 bilibili；明确提到微博 用 weibo；不指定留空。
query 字段：写成「能直接粘进搜索引擎」的词。
- **保留用户原话里的名词**（产品名、人名、作品名、公司名），不要改写成更泛的类别。
  反例：用户说「苹果最新的机器」，不要改写成「苹果最新发布电脑」（那是另一个产品线）。
- 只去掉口语、语气词和「帮我/查一下/搜一搜」这类动作词。
- 可以补上让搜索更准的词（例如「比赛结果」「最新价格」）。

例如
「B站热搜」→ {"need":true,"query":"B站热搜","site":"bilibili"}
「小蓝鲸是什么梗」→ {"need":true,"query":"小蓝鲸 是什么梗"}
「现在几点」→ {"need":false}（程序自己知道时间）

${SCHEMA_HINT}`;

function parseRoute(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  // 容忍代码块围栏和前后废话
  const jsonText = (text.match(/\{[\s\S]*\}/) || [''])[0];
  if (!jsonText) return null;
  let obj;
  try { obj = JSON.parse(jsonText); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const need = obj.need === true || obj.need === 'true';
  const query = String(obj.query || '').trim().slice(0, 40);
  const site = ['bilibili', 'weibo', 'toutiao'].includes(String(obj.site || '').trim())
    ? String(obj.site).trim() : '';
  if (!need) return { need: false, query: '', site: '' };
  if (!query) return null;
  return { need: true, query, site };
}

/**
 * @param {{ complete: Function }} llm
 * @param {string} text 用户这一句
 * @param {{history?: string[]}} [opts]
 * @returns {Promise<{need:boolean,query:string,site:string,failed?:boolean}>}
 */
async function route(llm, text, opts = {}) {
  const said = String(text || '').trim().slice(0, 200);
  if (!said) return { need: false, query: '', site: '' };
  if (!llm || typeof llm.complete !== 'function') return { need: false, query: '', site: '', failed: true };
  const history = (opts.history || []).slice(-4).join('\n') || '（无）';
  try {
    const raw = await llm.complete({
      system: SYSTEM,
      turns: [{ role: 'user', content: `最近的对话：\n${history}\n\n这句话：${said}` }],
      maxTokens: 60,
    });
    const parsed = parseRoute(raw);
    if (!parsed) return { need: false, query: '', site: '', failed: true };
    return parsed;
  } catch {
    return { need: false, query: '', site: '', failed: true };
  }
}

module.exports = { route, parseRoute, SYSTEM };
