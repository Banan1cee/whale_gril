'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../website/index.html'), 'utf8');
const versions = [...html.matchAll(/class="release-version">([\d.]+)/g)].map(match => match[1]);
const links = [...html.matchAll(/class="release-row" href="([^"]+)"/g)].map(match => match[1]);

// 网站只列真实发行过的 4.x 版本；4.0.2–4.0.4 合并在 4.0.5 里，不能伪装成已发布版本。
assert.deepEqual(versions, ['4.0.7', '4.0.6', '4.0.5'], '按新到旧保留三个真实发行版本');
assert.equal(links.length, 3);
assert.ok(links[0].endsWith('/releases/tag/v4.0.7'));
assert.ok(links[1].endsWith('/releases/tag/v4.0.6'));
assert.ok(links[2].endsWith('/releases/tag/4.0.5'));
assert.match(html, /4\.0\.2[–-]4\.0\.4 未单独发版，内容已并入 4\.0\.5/, '说明合并版本，避免用户找不到');
assert.doesNotMatch(html, /id="changelog"/, '不再保留独立更新日志栏目');
assert.doesNotMatch(html, /更新日志/, '导航与正文不再出现更新日志');
assert.match(html, /<a href="#updates">更新<\/a>/, '导航只保留「更新」');
assert.match(html, /<time datetime="2026-11-07">2026\.11\.07<\/time>[\s\S]*<time datetime="2026-11-06">2026\.11\.06<\/time>[\s\S]*<time datetime="2026-11-06">2026\.11\.06<\/time>/, '日期与 Releases 发布时间一致');

console.log('website releases: three published versions aligned with GitHub Releases');
