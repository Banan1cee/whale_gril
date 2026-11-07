'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const launcherIcon = fs.readFileSync(path.join(root, 'launcher/Assets/app.png'));
const websiteIcon = fs.readFileSync(path.join(root, 'website/images/launcher-icon.png'));

// 网站品牌标识必须和启动器使用同一份图标，避免两处各自更新后形象分叉。
assert.ok(launcherIcon.equals(websiteIcon), '网站图标应与启动器 app.png 字节一致');

const html = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
assert.match(html, /rel="icon" href="\.\/images\/launcher-icon\.png"/, 'favicon 指向启动器图标');
assert.match(html, /rel="apple-touch-icon" href="\.\/images\/launcher-icon\.png"/);
assert.equal((html.match(/class="brand-icon"/g) || []).length, 2, '页头与页脚使用同一图标');
assert.match(html, /<img class="brand-icon" src="\.\/images\/launcher-icon\.png"[^>]*width="256" height="256"/);
assert.doesNotMatch(html.slice(0, html.indexOf('<main')), /<svg[^>]*viewBox="0 0 40 32"/, '旧的矢量鲸鱼标识已移除');

console.log('website brand: launcher icon identity and references passed');
