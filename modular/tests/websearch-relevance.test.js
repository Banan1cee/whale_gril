'use strict';
/**
 * 联网检索相关性回归。
 *
 * 现场问题：日志写着「联网搜索」、资料也注入了提示词，但她的回答是
 * 「我记的是旧的」——因为 Bing 中国站把这些问法返回成了跑题结果：
 *   「最新 iPhone 多少钱」→ Yandex 官网
 *   「显卡行情」        → 「帮」字的字典解释
 * 模型按提示词「资料里没写就直说记的是旧的」如实回答了，所以看起来像「联网坏了」。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const websearch = require('../src/adapters/websearch');

test('口语问句清洗成可检索关键词，保留价格意图', () => {
  assert.equal(websearch.cleanQuery('最新 iPhone 多少钱'), 'iPhone 价格');
  assert.equal(websearch.cleanQuery('帮我查一下现在的显卡行情'), '显卡行情');
  assert.equal(websearch.cleanQuery('谁是这个游戏公司老板'), '游戏公司老板');
});

test('过泛的二字组不参与相关性判定', () => {
  const tokens = websearch.queryTokens('谁是这个游戏公司老板');
  for (const generic of ['谁是', '是谁', '这个', '什么']) assert.ok(!tokens.includes(generic), generic);
  assert.ok(tokens.includes('游戏') && tokens.includes('老板'));
});

test('跑题结果被过滤掉，命中的留下', () => {
  const garbage = [
    { title: '俄罗斯搜索引擎网址 yandex 官网入口直达_百度知道', snippet: 'Yandex 的官方网址如下', url: 'https://zhidao.baidu.com/x' },
    { title: '帮_百度百科', snippet: '帮，汉语一级字', url: 'https://baike.baidu.com/x' },
  ];
  assert.deepEqual(websearch.keepRelevant('最新 iPhone 多少钱', garbage), []);
  const good = [
    { title: '选购 iPhone 18 Pro 和 iPhone 18 Pro Max - Apple (中国大陆)', snippet: '起售价 9999 元', url: 'https://apple.com.cn/x' },
    { title: '俄罗斯搜索引擎', snippet: '无关内容', url: 'https://ya.ru/' },
  ];
  const kept = websearch.keepRelevant('最新 iPhone 多少钱', good);
  assert.equal(kept.length, 1);
  assert.match(kept[0].title, /iPhone/);
});

test('真正相关的资料不会被误杀', () => {
  const results = [
    { title: '北京天气预报,北京 7天 天气预报', snippet: '今天晴', url: 'https://weather.com.cn/x' },
  ];
  assert.equal(websearch.keepRelevant('北京明天会下雨吗', results).length, 1);
  assert.equal(websearch.keepRelevant('显卡行情', [{ title: '【显卡】显卡报价大全-ZOL', snippet: '行情', url: 'u' }]).length, 1);
});

test('品牌口语归一成可检索型号名', () => {
  assert.match(websearch.cleanQuery('苹果最新的机器是什么'), /iPhone/);
  assert.match(websearch.cleanQuery('苹果最新的笔记本'), /Mac/);
  assert.equal(websearch.cleanQuery('帮我查一下现在的显卡行情'), '显卡行情');
});

test('手机语境下水果百科被剔除，公司词条保留', () => {
  const fruit = [{ title: '苹果（蔷薇科苹果属植物）_百度百科', snippet: '苹果是落叶乔木', url: 'https://baike.baidu.com/apple' }];
  assert.deepEqual(websearch.keepRelevant('苹果最新的机器是什么', fruit), []);
  const company = [{ title: '苹果公司_百度百科', snippet: '1976 年成立，主营 iPhone', url: 'https://baike.baidu.com/co' }];
  assert.equal(websearch.keepRelevant('苹果最新的机器是什么', company).length, 1);
});
