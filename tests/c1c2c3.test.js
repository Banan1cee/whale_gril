'use strict';

/**
 * C1/C2/C3 三条「顺手」修复的回归：
 *  C1 桥接同类错误日志节流（没配看图 Key 时以前每张图刷一条）
 *  C2 data/media-cache 启动时清理（以前永不清理）
 *  C3 搜「最新/现在」时过滤明显过期结果（以前把 2010 年的文章当现状）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mediaCache = require('../src/adapters/mediaCache');
const websearch = require('../src/adapters/websearch');

const ROOT = path.resolve(__dirname, '..');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whale-c-'));
}

function writeFile(dir, name, { size = 10, ageDays = 0 } = {}) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, 1));
  if (ageDays) {
    const t = (Date.now() - ageDays * 86400000) / 1000;
    fs.utimesSync(file, t, t);
  }
  return file;
}

test('C2：超过保留天数的媒体文件会被清掉，新的留着', () => {
  const dir = tmpDir();
  const old = writeFile(dir, 'old.jpg', { ageDays: 30 });
  const fresh = writeFile(dir, 'new.jpg', { ageDays: 1 });
  const r = mediaCache.cleanup(dir, { maxAgeDays: 7, maxTotalMB: 500 });
  assert.equal(fs.existsSync(old), false, '30 天前的应该删掉');
  assert.equal(fs.existsSync(fresh), true, '1 天前的要留着');
  assert.equal(r.removed, 1);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});

test('C2：总量超限时按最旧优先删，不删空的', () => {
  const dir = tmpDir();
  const files = [
    writeFile(dir, 'a.jpg', { size: 400 * 1024, ageDays: 5 }),
    writeFile(dir, 'b.jpg', { size: 400 * 1024, ageDays: 3 }),
    writeFile(dir, 'c.jpg', { size: 400 * 1024, ageDays: 1 }),
  ];
  // 上限 0.5MB，必然要删
  const r = mediaCache.cleanup(dir, { maxAgeDays: 365, maxTotalMB: 0.5 });
  assert.ok(r.removed >= 1, '超总量必须删');
  assert.equal(fs.existsSync(files[2]), true, '最新的那个要留着');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});

test('C2：目录不存在时安静返回，不抛异常', () => {
  const r = mediaCache.cleanup(path.join(os.tmpdir(), 'whale-nonexistent-' + Date.now()));
  assert.deepEqual(r, { removed: 0, freedMB: 0, kept: 0 });
});

test('C3：能解析「3 天之前」和「2026年9月5日」两种时间', () => {
  assert.equal(Math.round(websearch.parseSnippetAgeDays('3 天之前&ensp;正文')), 3);
  assert.ok(websearch.parseSnippetAgeDays('2026年9月5日&ensp;正文') > 0);
  assert.equal(websearch.parseSnippetAgeDays('没有日期'), null);
});

test('C3-2：更多时间写法都认（X天前 / 刚刚 / 昨天 / 11月2日 / 2026-11-02）', () => {
  const now = new Date(2026, 10, 3, 12, 0, 0).getTime();   // 2026-11-03 12:00
  assert.equal(Math.round(websearch.parseSnippetAgeDays('4 天前 正文', now)), 4);
  assert.equal(websearch.parseSnippetAgeDays('刚刚 正文', now), 0);
  assert.equal(websearch.parseSnippetAgeDays('昨天 20:11 正文', now), 1);
  assert.equal(Math.floor(websearch.parseSnippetAgeDays('11月2日 正文', now)), 1);
  assert.equal(Math.floor(websearch.parseSnippetAgeDays('2026-11-01 正文', now)), 2);
  // 跨年：1 月读到「12月20日」的稿子是去年的，不能算成未来/今天
  const jan = new Date(2026, 0, 5, 12, 0, 0).getTime();
  const age = websearch.parseSnippetAgeDays('12月20日 正文', jan);
  assert.ok(age > 10 && age < 40, '按去年 12 月 20 日算（约 16 天），不能算成未来：' + age);
});

test('C3-2：「今天」把丢旧结果的阈值收紧到 2 天，四天前的旧闻不再当今天', () => {
  const results = [
    { title: '今天的', snippet: '今天 09:12 最新消息' },
    { title: '四天前', snippet: '4 天之前 旧闻' },
  ];
  assert.deepEqual(websearch.dropStaleResults('今天有什么新闻', results).map((x) => x.title), ['今天的']);
  assert.equal(websearch.effectiveMaxAgeDays('今天显卡多少钱', 'strict'), 2);
  assert.equal(websearch.effectiveMaxAgeDays('显卡行情', 'strict'), 90);
  assert.equal(websearch.effectiveMaxAgeDays('这周发布会', 'normal'), 7);
  assert.equal(websearch.effectiveMaxAgeDays('今天有什么新闻', 'any'), 2);
});

test('C3：问「最新」时丢掉明显过期结果', () => {
  const results = [
    { title: '新文', snippet: '1 天之前 最新情况' },
    { title: '旧文', snippet: '2010年3月4日 十年前的老文章' },
  ];
  const kept = websearch.dropStaleResults('苹果现在出到几了', results);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, '新文');
});

test('C3：普通问题不过滤（问红楼作者不需要时效）', () => {
  const results = [
    { title: '新文', snippet: '1 天之前 x' },
    { title: '旧文', snippet: '2010年3月4日 y' },
  ];
  assert.equal(websearch.dropStaleResults('红楼梦作者是谁', results).length, 2);
});

test('C3：模型判的时效三档决定丢弃阈值（strict 90 / normal 365 / any 不限）', () => {
  const results = [
    { title: '近文', snippet: '30 天之前 a' },
    { title: '中年', snippet: '200 天之前 b' },
    { title: '老文', snippet: '2019年1月1日 c' },
  ];
  assert.deepEqual(websearch.dropStaleResults('随便', results, { maxAgeDays: 90 }).map((x) => x.title), ['近文']);
  assert.deepEqual(websearch.dropStaleResults('随便', results, { maxAgeDays: 365 }).map((x) => x.title), ['近文', '中年']);
  assert.equal(websearch.dropStaleResults('随便', results, { maxAgeDays: null }).length, 3);
});
test('C3：全被判过期时如实返回无有效结果', () => {
  const results = [{ title: '旧文', snippet: '2010年3月4日 z' }];
  assert.equal(websearch.dropStaleResults('最新显卡', results).length, 0);
});

test('C1：桥接里识别失败日志走节流函数', () => {
  const src = fs.readFileSync(path.join(ROOT, 'bridge', 'engine.py'), 'utf8');
  assert.match(src, /def log_throttled/, '要有节流函数');
  assert.match(src, /log_throttled\("img-fail:/, '看图失败要走节流');
  assert.match(src, /log_throttled\("voice-fail:/, '语音失败要走节流');
  assert.doesNotMatch(src, /\n\s+log\("第 %d 段识别失败/, '不能再无条件刷日志');
});

test('C3：时效性问题不再机械加年份（实测加了反而更差）', () => {
  assert.equal(websearch.isTimeSensitive('苹果现在出到几了'), true);
  assert.equal(websearch.isTimeSensitive('DeepSeek 最新版本'), true);
  assert.equal(websearch.isTimeSensitive('显卡推荐'), false);
});

test('C2：config.example 里能调媒体缓存策略', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(cfg.storage.mediaKeepDays, 7);
  assert.equal(cfg.storage.mediaMaxMB, 500);
});

test('C2：不写配置也有默认清理策略（config.storage 必须存在）', () => {
  const { loadConfig } = require('../src/infra/config');
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.storage.mediaKeepDays, 7);
  assert.equal(cfg.storage.mediaMaxMB, 500);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ storage: { mediaKeepDays: 30, mediaMaxMB: 1024 } })
  );
  const cfg2 = loadConfig({ root: dir, env: {} });
  assert.equal(cfg2.storage.mediaKeepDays, 30, '用户自己配的要生效');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});
