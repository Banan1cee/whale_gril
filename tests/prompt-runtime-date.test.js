'use strict';

/**
 * 提示词里的时间必须是**运行时时**，而且要给到年月日。
 *
 * 两个真实故障叠在一起：
 *   3.64：提示词原来只给「周四 15:44」，没有年月日 —— 用户问「今天几号」，
 *         她按训练数据/上下文猜，实测答成「4 月 18」。
 *   3.9 ：提示词里写死了「现在是 2026 年」，于是程序跑到别的年份还在说 2026。
 *
 * 这类问题最容易被「换一年再说」掩盖：写死年份的测试永远绿，
 * 所以这里用两个不同年份各跑一次，并且断言**不含**写死的年份。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const persona = require('../src/persona');
const { DEFAULT_CONFIG } = require('../src/infra/config');

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
  return persona.buildSystem({
    config: config({
      persona: Object.assign({}, config().persona, { customPrompt }),
      ...extra,
    }),
    msg: { chatType, senderName: '小海', chatTitle: '深海鱼塘' },
    now: date,
  });
}

test('私聊提示词带完整年月日 + 星期 + 时刻（问「今天几号」有据可依）', () => {
  const sys = buildAt(new Date(2026, 9, 31, 18, 5, 0)); // 2026-10-31 周六 18:05（本地时间）
  // 默认人设走【此刻】、自定义人设走【现在】，两条分支都得给全
  assert.match(sys, /【(现在|此刻)】/, '提示词里必须有时间行');
  assert.match(sys, /2026年10月31日/, '缺年月日 → 她会把「今天几号」答成别的日期');
  assert.match(sys, /周六/, '缺星期');
  assert.match(sys, /18:05/, '缺时刻');
  assert.match(sys, /按这个答|以这个为准/, '要明确告诉她「按这个答、别自己编」');
});

test('群聊提示词同样带年月日（两条分支不能只改一条）', () => {
  const sys = buildAt(new Date(2026, 0, 1, 9, 30, 0), { chatType: 'group' });
  assert.match(sys, /2026年1月1日/);
  assert.match(sys, /周四/);
});

test('年份来自运行时，不是写死的 2026', () => {
  const sys = buildAt(new Date(2031, 4, 6, 12, 0, 0)); // 2031-05-06 周二
  assert.match(sys, /2031年5月6日/);
  assert.doesNotMatch(sys, /现在是\s*2026\s*年/, '提示词里不许再写死年份');
  assert.doesNotMatch(sys, /【现在】2026/, '【现在】这一行必须是运行时间');
});

test('自定义人设也带时间（换成自定义提示词不能把时间弄丢）', () => {
  const sys = buildAt(new Date(2027, 2, 15, 8, 0, 0), { customPrompt: '你就是鲸鲸，说话俏皮一点。' });
  assert.ok(sys.startsWith('你就是鲸鲸'), '自定义人设原文要在最前面');
  assert.match(sys, /2027年3月15日/, '自定义人设分支漏了运行时间');
});
