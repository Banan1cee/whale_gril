'use strict';

/**
 * 一个改动 = 一个版本号：把「改版本号 + 写 CHANGELOG」合成一条命令。
 *
 * 用法：
 *   node scripts/bump-version.js "修好了 XXX"              # 补丁号 +1（默认）
 *   node scripts/bump-version.js "新增 XXX" --level=minor  # 次版本
 *   node scripts/bump-version.js "重构 XXX" --level=major  # 主版本
 *   npm run bump -- "修好了 XXX"
 *
 * 它会：
 *   1. package.json 版本 +1
 *   2. 在 CHANGELOG.md 最上面插一条对应版本（内容就是你给的说明）
 *   3. 打印新旧版本号
 *
 * 已经存在同名版本会直接报错退出，避免同一个版本号改两次。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const levelArg = argv.find((a) => a.startsWith('--level='));
const level = levelArg ? levelArg.split('=')[1] : 'patch';
const desc = argv.filter((a) => !a.startsWith('--')).join(' ').trim();

if (!desc) {
  console.error('用法：node scripts/bump-version.js "这次改了什么" [--level=patch|minor|major]');
  process.exit(1);
}
if (!['patch', 'minor', 'major'].includes(level)) {
  console.error('--level 只能是 patch / minor / major');
  process.exit(1);
}

const pkgPath = path.join(root, 'package.json');
const clPath = path.join(root, 'CHANGELOG.md');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const [maj, min, pat] = String(pkg.version).split('.').map((n) => Number(n) || 0);
const next = level === 'major' ? `${maj + 1}.0.0` : level === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;

let cl = fs.readFileSync(clPath, 'utf8');
const dupRe = new RegExp('^##\\s*' + next.replace(/\./g, '\\.') + '\\b', 'm');
if (dupRe.test(cl)) {
  console.error(`CHANGELOG 里已经有 ${next} 了：一个版本号只能对应一次改动，先确认再改。`);
  process.exit(1);
}

const entry = `## ${next}\n\n${desc}\n\n`;
const idx = cl.search(/^## /m);
cl = idx >= 0 ? cl.slice(0, idx) + entry + cl.slice(idx) : cl.trimEnd() + '\n\n' + entry;
fs.writeFileSync(clPath, cl, 'utf8');

pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n', 'utf8');

console.log(`版本：${pkg.version === next ? '旧 -> 新' : ''}  ${next}（${level}）`);
console.log(`CHANGELOG 已加一条：${desc}`);
console.log('下一步：npm test && npm run release-check，然后 deploy + 出包。');
