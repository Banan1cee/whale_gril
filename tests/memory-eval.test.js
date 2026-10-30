'use strict';

/**
 * 记忆的「评估集」：不是测函数对不对，是测「她像不像真人在记人」。
 *
 * 30 轮脚本对话，量三个数字：
 *   1. 旧事命中率——该想起的那条，有没有进到注入给模型的候选里（目标 ≥ 0.8）
 *   2. 复读率——同一件事在不该重复的间隔内被重复提起的比例（目标 = 0）
 *   3. 遗忘是否讲道理——老了没用的沉底，承诺/雷区不沉
 *
 * 数字不过就说明参数跑偏了，别靠感觉调。
 */

const test = require('node:test');
const assert = require('node:assert');

const recall = require('../src/memory/recall');
const forget = require('../src/memory/forget');

const DAY = 86400000;
const NOW = 1_700_000_000_000;

function fact(text, { age = 10, kind = 'fact', importance = 1, lastMentionedAt = 0 } = {}) {
  return { text, kind, createdAt: NOW - age * DAY, lastMentionedAt, mentions: 0, importance };
}

// 关于「小海」的 10 条记忆：3 条近期、4 条陈年、2 条承诺、1 条雷区
const NOTES = [
  fact('小海明天要去体检', { age: 2, kind: 'recent', importance: 2 }),
  fact('小海在准备考研', { age: 5, kind: 'recent', importance: 2 }),
  fact('小海的猫叫团子', { age: 8 }),
  fact('小海爱吃辣', { age: 40, kind: 'preference' }),
  fact('小海住在杭州', { age: 60 }),
  fact('小海在学吉他', { age: 90 }),
  fact('小海以前在成都读书', { age: 120 }),
  fact('小海对花生过敏', { age: 200, kind: 'taboo', importance: 3 }),
  fact('答应过陪小海去医院', { age: 30, kind: 'promise', importance: 2 }),
  fact('答应过给小海带火锅底料', { age: 70, kind: 'promise', importance: 2 }),
];

// 30 轮：每轮一句用户话 + 应该被想起的那条（null = 这轮没有对应记忆）
const TURNS = [
  ['明天几点去医院啊', '小海明天要去体检'],
  ['考研复习到哪了', '小海在准备考研'],
  ['团子今天乖不乖', '小海的猫叫团子'],
  ['晚上吃火锅吧', '小海爱吃辣'],
  ['杭州下雨了吗', '小海住在杭州'],
  ['吉他练得怎么样', '小海在学吉他'],
  ['你还在成都吗', '小海以前在成都读书'],
  ['这个饼干有花生吗', '小海对花生过敏'],
  ['医院那边我陪你去', '答应过陪小海去医院'],
  ['火锅底料买了没', '答应过给小海带火锅底料'],
  ['今天好累啊', null],
  ['在干嘛', null],
  ['哈哈哈哈哈', null],
  ['晚安', null],
  ['明天见', null],
  ['体检约的几点', '小海明天要去体检'],
  ['考研压力大不大', '小海在准备考研'],
  ['团子掉毛厉害吗', '小海的猫叫团子'],
  ['今天想吃点辣的', '小海爱吃辣'],
  ['杭州有什么好玩的', '小海住在杭州'],
  ['吉他学了多久了', '小海在学吉他'],
  ['成都的火锅和这边比呢', '小海以前在成都读书'],
  ['这个菜里有花生碎吗', '小海对花生过敏'],
  ['陪你去医院那事我记着', '答应过陪小海去医院'],
  ['底料我挑好了', '答应过给小海带火锅底料'],
  ['早上好', null],
  ['吃了吗', null],
  ['我先忙一会', null],
  ['地铁好挤', null],
  ['到家了', null],
];

test('旧事命中率：30 轮里该想起的，至少八成进了候选', () => {
  let expected = 0;
  let hit = 0;
  for (const [say, want] of TURNS) {
    if (!want) continue;
    expected += 1;
    const picks = recall.pickNotes(NOTES, say, { now: NOW, limit: 5 }).map((n) => n.text);
    if (picks.includes(want)) hit += 1;
    else assert.fail(`「${say}」该想起「${want}」，实际挑到：${picks.join(' / ')}`);
  }
  const rate = hit / expected;
  console.log(`  旧事命中率：${hit}/${expected} = ${(rate * 100).toFixed(0)}%`);
  assert.ok(rate >= 0.8, `命中率 ${(rate * 100).toFixed(0)}% < 80%`);
});

test('复读率：同一条在 30 分钟内不会被反复提', () => {
  let notes = NOTES.map((n) => ({ ...n }));
  const say = '明天去医院吗';
  const first = recall.pickNotes(notes, say, { now: NOW, limit: 5 });
  assert.ok(first.some((n) => n.text === '小海明天要去体检'), '第一次该提到');

  // 模拟「刚提过」：把命中的那条打上时间戳
  notes = notes.map((n) => (first.some((f) => f.text === n.text)
    ? { ...n, lastMentionedAt: NOW, mentions: 1 }
    : n));
  const second = recall.pickNotes(notes, say, { now: NOW + 5 * 60000, limit: 5 });
  assert.equal(
    second.some((n) => n.text === '小海明天要去体检'),
    false,
    '五分钟内不该再念一遍同一件事',
  );
});

test('遗忘是否讲道理：陈年小事沉底，承诺和雷区留下', () => {
  const pool = NOTES.map((n) => ({ ...n }));
  const archived = pool.filter((n) => forget.shouldArchive(n, NOW)).map((n) => n.text);
  console.log(`  会被忘掉的：${archived.join(' / ')}`);
  assert.ok(archived.includes('小海住在杭州'), '120 天没提过的住处该沉');
  assert.ok(archived.includes('小海以前在成都读书'), '更老的经历该沉');
  assert.equal(archived.includes('答应过陪小海去医院'), false, '承诺不能沉');
  assert.equal(archived.includes('小海对花生过敏'), false, '雷区不能沉');
  assert.equal(archived.includes('小海明天要去体检'), false, '近期的事不能沉');
});

test('淘汰顺序：名额不够时，先扔没用的，别扔承诺', () => {
  const pool = NOTES.map((n) => ({ ...n }));
  const evict = forget.pickEvictions(pool, 4, NOW).map((i) => pool[i].text);
  assert.equal(evict.length, 6, '10 条只留 4 条');
  assert.equal(evict.includes('答应过陪小海去医院'), false);
  assert.equal(evict.includes('小海对花生过敏'), false);
  assert.ok(evict.includes('小海以前在成都读书'), '最老最没用的先走');
});
