'use strict';

/**
 * episode 抽取的预算与日志（2026-11 修「思考吃满 max_tokens → 空泡泡」）。
 *
 * 以前 extractEpisode 传 maxTokens:900，被 client 夹成 700；思考模型把 700 全用来
 * reasoning，finish=length、content 为空，日志只剩一句「空泡泡」，看不出原因。
 * 这里钉住：
 *   1) 抽取必须传 thinking:false + allowOverflow:true + maxTokens:1200；
 *   2) 失败日志要带 code/detail，不能拿「空泡泡」当日志；
 *   3) 返回不是可解析 JSON 时要 warn「疑似截断」，不静默降级。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { extractEpisode } = require('../src/memory/extractor');
const { LlmError, FRIENDLY } = require('../src/llm/client');

const messages = [
  { role: 'user', uid: 'u1', name: '小海', text: '最近在换工作，压力挺大，想换个环境', id: 'msg_1' },
  { role: 'assistant', uid: 'bot', name: '鲸鲸', text: '慢慢来，别把自己逼太紧' },
];
const speakers = [{ uid: 'u1', name: '小海' }];

function collector() {
  const logs = [];
  return {
    logs,
    logger: {
      warn: (m) => logs.push(['warn', String(m)]),
      info: () => {},
      debug: () => {},
      error: (m) => logs.push(['error', String(m)]),
    },
  };
}

test('抽取请求带 thinking:false / allowOverflow / maxTokens:1200', async () => {
  let seen = null;
  const llm = {
    isMock: false,
    async complete(opts) {
      seen = opts;
      return JSON.stringify({ summary: '在聊换工作', facts: [], traits: [], events: [], threads: [] });
    },
  };
  await extractEpisode({ messages, llm, speakers });
  assert.ok(seen, '必须真的调一次模型');
  assert.equal(seen.thinking, false, '抽取必须关思考（思考 token 会吃光预算）');
  assert.equal(seen.allowOverflow, true, '后台任务不吃聊天的 700 夹取');
  assert.equal(seen.maxTokens, 1200, '给足预算，别再被夹成 700');
});

test('LlmError 带 detail：日志里有 code/detail，不能只有「空泡泡」', async () => {
  const { logs, logger } = collector();
  const detail = '空响应（finish=length usage=3200/700 reasoning_tokens=700）';
  const llm = {
    isMock: false,
    async complete() {
      throw new LlmError(FRIENDLY.empty, { code: 'empty', detail });
    },
  };
  const out = await extractEpisode({ messages, llm, speakers, logger });
  assert.equal(out.fallback, true, '失败要退回规则兜底');
  const line = logs.map(([, m]) => m).join('\n');
  assert.ok(line.includes('episode 抽取失败'), line);
  assert.ok(line.includes('code=empty'), '日志要带 code：' + line);
  assert.ok(line.includes('finish=length'), '日志要带 detail：' + line);
  assert.ok(!line.includes('空泡泡'), '不能拿给用户看的话术当日志：' + line);
});

test('返回不是可解析 JSON：warn「疑似截断」，不静默降级', async () => {
  const { logs, logger } = collector();
  const llm = {
    isMock: false,
    async complete() {
      // 典型截断：JSON 只开了个头
      return '{"summary":"在聊换工作","facts":[{"uid":"u1","text":"换工作"';
    },
  };
  const out = await extractEpisode({ messages, llm, speakers, logger });
  assert.equal(out.fallback, true);
  const line = logs.map(([, m]) => m).join('\n');
  assert.ok(line.includes('不是可解析 JSON'), line);
  assert.ok(line.includes('疑似截断'), line);
});
