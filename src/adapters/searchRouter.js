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
{"need":true,"kind":"web|weather|hotlist","query":"简短检索词（保留完整专名和型号）","site":"bilibili|weibo|toutiao|","city":"地名原文或空","fresh":"strict|normal|any","timeRange":"current|today|tomorrow|week|history|future|any"}
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

kind 字段：普通具体事实用 web；今明两天常规天气用 weather；要求整个平台榜单或泛热点新闻用 hotlist。
具体人物/产品/事件的新闻用 web，不要用整个平台热榜替代。空气质量、台风路径、历史/远期天气用 web。
timeRange 字段：按用户要求填 current（现在）、today、tomorrow、week、history、future 或 any（没要求）。

city 字段：这句话提到地点就把地名原文抄进 city（保留用户写法，不翻译）；没提就留空。
例如「明天上海会下雨吗」→ city 填「上海」；「明天会下雨吗」→ city 留空。

fresh 字段（结果要多新）：
- strict：问价格、型号、最新、现在出到几、这周/今天这类会变的数字
- normal：一般事实、新闻、近况
- any：常识、历史、定义这类不会变的知识

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

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const { remaining, errorInfo, report, searchError } = require('./search/transport');

/** 把「现在是什么时间」告诉路由器：不然它判「今天/最新」只能凭训练数据。 */
function systemFor(now = new Date()) {
  const day = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(day).map(x => [x.type, x.value]));
  const weekday = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))).getUTCDay();
  const stamp = `${parts.year}-${parts.month}-${parts.day} ${WEEKDAYS[weekday]} ${parts.hour}:${parts.minute}`;
  return `${SYSTEM}

现在是 ${stamp}（北京时间）。判断「今天 / 最新 / 这周」时以这个时间为基准；检索词里不要自己加年份，除非用户原话提到了。`;
}

function parseRoute(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  // 容忍代码块围栏和前后废话
  const jsonText = (text.match(/\{[\s\S]*\}/) || [''])[0];
  if (!jsonText) return null;
  let obj;
  try { obj = JSON.parse(jsonText); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  // 缺失/损坏的判断不是明确的“不查”，必须让调用方走规则兜底。
  if (![true, false, 'true', 'false'].includes(obj.need)) return null;
  const need = obj.need === true || obj.need === 'true';
  if (need && typeof obj.query !== 'string') return null;
  const query = String(obj.query || '').trim().slice(0, 100);
  const site = ['bilibili', 'weibo', 'toutiao'].includes(String(obj.site || '').trim())
    ? String(obj.site).trim() : '';
  // 地名保留用户写法（不翻译）；只做长度和空白收敛
  const city = String(obj.city == null ? '' : obj.city).trim().slice(0, 40);
  const fresh = ['strict', 'normal', 'any'].includes(String(obj.fresh || '').trim())
    ? String(obj.fresh).trim() : 'normal';
  if (!need) return { need: false, query: '', site: '', city, fresh };
  if (!query) return null;
  const intent = {};
  if (obj.kind != null) {
    if (!['web', 'weather', 'hotlist'].includes(obj.kind)) return null;
    intent.kind = obj.kind;
  }
  if (obj.timeRange != null) {
    if (!['current', 'today', 'tomorrow', 'week', 'history', 'future', 'any'].includes(obj.timeRange)) return null;
    intent.timeRange = obj.timeRange;
  }
  return { need: true, query, site, city, fresh, ...intent };
}

/**
 * @param {{ complete: Function }} llm
 * @param {string} text 用户这一句
 * @param {{history?: string[], timeoutMs?: number, deadline?: number, signal?: AbortSignal, trace?: Function, now?: Date}} [opts]
 * @returns {Promise<{need:boolean,query:string,site:string,city:string,fresh:string,kind?:string,timeRange?:string,failed?:boolean}>}
 */
async function route(llm, text, opts = {}) {
  const said = String(text || '').trim().slice(0, 200);
  if (!said) return { need: false, query: '', site: '', city: '', fresh: 'normal' };
  if (!llm || typeof llm.complete !== 'function') {
    report(opts.trace, 'route_failed', errorInfo(searchError('router_unavailable')));
    return { need: false, query: '', site: '', city: '', fresh: 'normal', failed: true };
  }
  const history = (opts.history || []).slice(-4).join('\n') || '（无）';
  let timer, abort;
  const controller = new AbortController();
  try {
    // complete 自身可能重试多次；辅助路由不能拖住真正的回复。
    const timeoutMs = remaining({ ...opts, timeoutMs: opts.timeoutMs ?? 2000 });
    if (opts.signal?.aborted || timeoutMs <= 0) throw searchError(opts.signal?.aborted ? 'aborted' : 'deadline_exceeded');
    const raw = await Promise.race([
      Promise.resolve().then(() => llm.complete({
        system: systemFor(opts.now),
        turns: [{ role: 'user', content: `最近的对话：\n${history}\n\n这句话：${said}` }],
        maxTokens: 240,
        signal: controller.signal,
      })),
      new Promise((_, reject) => {
        abort = () => { controller.abort(); reject(searchError('aborted')); };
        opts.signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => {
          controller.abort();
          reject(searchError('deadline_exceeded'));
        }, timeoutMs);
      }),
    ]);
    const parsed = parseRoute(raw);
    if (!parsed) throw searchError('invalid_route');
    return parsed;
  } catch (err) {
    report(opts.trace, 'route_failed', errorInfo(err));
    return { need: false, query: '', site: '', city: '', fresh: 'normal', failed: true };
  } finally {
    clearTimeout(timer);
    if (abort) opts.signal?.removeEventListener('abort', abort);
  }
}

module.exports = { route, parseRoute, SYSTEM, systemFor };
