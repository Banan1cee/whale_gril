'use strict';

/**
 * 回归：「状态播报」权重太高，她句句「我刚泡完脚，手还湿着呢」，人机感重。
 * 规则：时间照给；「在干嘛」按小时抽样，只当背景，并明确要求不要说出来。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const persona = require('../src/persona');

function makeConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-status-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({}));
  const config = loadConfig({ root, env: {} });
  return { config, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }) };
}

const msg = (extra = {}) => ({
  platform: 'wechat',
  chatId: 'wxid_status_self',
  chatType: 'private',
  senderId: 'wxid_status_self',
  senderName: 'Banan',
  text: '在吗',
  isMaster: false,
  ...extra,
});

function promptAt(config, date) {
  return persona.buildSystem({ config, msg: msg(), profile: {}, notes: [], now: date });
}

test('提示词里明确写了「别汇报状态」', () => {
  const { config, cleanup } = makeConfig();
  const sys = promptAt(config, new Date());
  assert.match(sys, /别汇报状态/);
  assert.match(sys, /不要用「我刚…」「我在…」开头|直接接对方的话/);
  cleanup();
});

test('不再要求她把心情说出来', () => {
  const { config, cleanup } = makeConfig();
  const sys = promptAt(config, new Date());
  assert.doesNotMatch(sys, /今天的心情：/, '心情不应该被当成一句话说出来');
  assert.match(sys, /语气底子/);
  cleanup();
});

test('「此刻在干嘛」按小时抽样，最多只占少数小时', () => {
  const { config, cleanup } = makeConfig();
  let shown = 0;
  for (let h = 0; h < 24; h += 1) {
    const date = new Date(2026, 9, 26, h, 30, 0);
    const sys = promptAt(config, date);
    if (sys.includes('你此刻大概')) {
      shown += 1;
      assert.match(sys, /不要主动说出来/, '给了背景也必须要求她别说出来');
    } else {
      assert.match(sys, /不用说自己正在干什么/);
    }
  }
  assert.ok(shown >= 1 && shown <= 10, `24 小时里应只有少数几个小时给背景，实际 ${shown}`);
  cleanup();
});

test('时间还是要给的（不然她会活在过去）', () => {
  const { config, cleanup } = makeConfig();
  const sys = promptAt(config, new Date(2026, 9, 26, 15, 42, 0));
  assert.match(sys, /15:42/, '当前时间必须出现在提示词里');
  cleanup();
});
