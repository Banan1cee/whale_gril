'use strict';

/**
 * 提示词里的时间必须是**运行时时**，而且要给到年月日。
 *
 * 两个真实故障叠在一起：
 *   3.64：提示词原来只给「周四 15:44」，没有年月日 —— 用户问「今天几号」，
 *         她按训练数据/上下文猜，实测答成「4 月 18」。
 *   3.9 ：提示词里写死了「现在是 2026 年」，于是程序跑到别的年份还在说 2026。
 *
 * 静态化改造后（features.staticSystem）：日期只出现在 system 的一行「今天是…」里，
 * 具体时刻交给每条消息前面的 [MM-DD HH:mm] 时间戳。所以这里两条都要验：
 * system 有日期行、拼装后的 prompt 有消息时间戳。仍然用两个不同年份各跑一次，
 * 并断言**不含**写死的年份。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_CONFIG } = require('../src/infra/config');
const { assemblePrompt } = require('./support/prompt');

function config(extra = {}) {
  return Object.assign(
    {},
    DEFAULT_CONFIG,
    {
      persona: Object.assign({}, DEFAULT_CONFIG.persona, {
        name: '鲸鲸',
        aliases: ['鲸鲸', '鲸娘', '小鲸'],
        ownerName: '主人',
        master: { names: ['Master'], wxids: ['wxid_test_master'] },
      }),
      chat: Object.assign({}, DEFAULT_CONFIG.chat),
    },
    extra
  );
}

/** 用本地时间构造，避免测试机时区（CI 是 UTC）把日期挪一天 */
function buildAt(date, { chatType = 'private', customPrompt = '', extra = {} } = {}) {
  const cfg = config({
    persona: Object.assign({}, config().persona, { customPrompt }),
    ...extra,
  });
  return assemblePrompt({
    config: cfg,
    msg: { chatType, senderName: '小海', chatTitle: '深海鱼塘', text: '在吗', ts: date.getTime() },
    now: date,
  });
}

test('私聊提示词带完整年月日 + 星期（问「今天几号」有据可依）', () => {
  const { system, prompt } = buildAt(new Date(2026, 9, 31, 18, 5, 0)); // 2026-10-31 周六 18:05（本地时间）
  assert.match(system, /今天是 2026年10月31日 周六/, 'system 里必须有日期行');
  assert.match(system, /时间怎么看/, '要告诉她时间看哪里、别自己编');
  assert.match(system, /按下面那行「今天是…」回答/, '日期按 system 那行答');
  assert.match(prompt, /\[10-31 18:05\]/, '拼装后的提示词里要有这条消息的时间戳');
  assert.doesNotMatch(system, /18:05/, '具体时刻只在消息时间戳里，system 不再每轮变');
});

test('群聊提示词同样带年月日（两条分支不能只改一条）', () => {
  const { system, prompt } = buildAt(new Date(2026, 0, 1, 9, 30, 0), { chatType: 'group' });
  assert.match(system, /今天是 2026年1月1日 周四/);
  assert.match(prompt, /\[01-01 09:30\]/);
});

test('年份来自运行时，不是写死的 2026', () => {
  const { system } = buildAt(new Date(2031, 4, 6, 12, 0, 0)); // 2031-05-06
  assert.match(system, /今天是 2031年5月6日/);
  assert.doesNotMatch(system, /现在是\s*2026\s*年/, '提示词里不许再写死年份');
  assert.doesNotMatch(system, /【现在】2026/, '【现在】这一行必须是运行时间');
});

test('自定义人设也带时间（换成自定义提示词不能把时间弄丢）', () => {
  const { system, prompt } = buildAt(new Date(2027, 2, 15, 8, 0, 0), { customPrompt: '你就是鲸鲸，说话俏皮一点。' });
  assert.ok(system.startsWith('你就是鲸鲸'), '自定义人设原文要在最前面');
  assert.match(system, /今天是 2027年3月15日 周一/, '自定义人设分支漏了运行日期');
  assert.match(prompt, /\[03-15 08:00\]/, '自定义人设分支漏了消息时间戳');
});
