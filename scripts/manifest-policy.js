'use strict';

/**
 * 改 release-manifest.json 的策略字段，并自动把 manifest_version +1。
 *
 * 为什么要 +1：客户端同时读 4 个源，取 manifest_version 最大的那份。
 * 你只改 main 上的文件、不抬序号的话，Release 资产里那份同序号的旧清单
 * 会先被选中——刹车就失效了。这个脚本替你保证这一点。
 *
 * 用法：
 *   npm run brake                          # force=false：只提示，不强制
 *   npm run unbrake                        # force=null ：恢复时间闸
 *   npm run force-now                      # force=true ：立即强制
 *   node scripts/manifest-policy.js --kill-below 4.0.2     # 熔断
 *   node scripts/manifest-policy.js --kill-below null      # 取消熔断
 *   node scripts/manifest-policy.js --force-after-hours 6  # 时间闸改成 6 小时
 *
 * 改完记得 commit + push，客户端 1~5 分钟内生效。
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const fileArg = arg('file');
const file = fileArg ? path.resolve(fileArg) : path.join(root, 'release-manifest.json');

const wantHelp = process.argv.includes('--help') || process.argv.length <= 2;
if (wantHelp) {
  console.log(`改更新策略（会自动把 manifest_version +1）

  npm run brake                          刹车：force=false（只提示，不强制）
  npm run unbrake                        恢复：force=null（按时间闸）
  npm run force-now                      立即强制：force=true
  node scripts/manifest-policy.js --kill-below 4.0.2       熔断：低于 4.0.2 不许启动
  node scripts/manifest-policy.js --kill-below null        取消熔断
  node scripts/manifest-policy.js --force-after-hours 6    时间闸改成 6 小时

改完记得 git commit + push；客户端 1~5 分钟内生效。`);
  process.exit(0);
}

if (!fs.existsSync(file)) {
  console.error(`找不到 ${file}`);
  process.exit(1);
}

let m;
try {
  m = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error('release-manifest.json 不是合法 JSON：' + e.message);
  process.exit(1);
}

let touched = false;

const forceArg = arg('force');
if (forceArg !== undefined) {
  if (forceArg === 'true') m.force = true;
  else if (forceArg === 'false') m.force = false;
  else if (forceArg === 'null') m.force = null;
  else {
    console.error('--force 只能是 true / false / null');
    process.exit(1);
  }
  touched = true;
}

const killArg = arg('kill-below');
if (killArg !== undefined) {
  m.kill_below = killArg === 'null' || killArg === '' ? null : killArg.replace(/^[vV]/, '');
  touched = true;
}

const hoursArg = arg('force-after-hours');
if (hoursArg !== undefined) {
  const n = Number(hoursArg);
  if (!Number.isFinite(n) || n < 0) {
    console.error('--force-after-hours 要是非负数字');
    process.exit(1);
  }
  m.force_after_hours = n;
  touched = true;
}

if (!touched) {
  console.error('没给任何策略参数，什么也没改。加 --help 看用法。');
  process.exit(1);
}

// 关键一步：抬序号，否则旧清单会赢
m.manifest_version = (Number(m.manifest_version) || 0) + 1;

fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n', 'utf8');

const forceText = m.force === null ? 'null（按时间闸自动）' : String(m.force);
const killText = m.kill_below === null || m.kill_below === undefined ? 'null（不熔断）' : m.kill_below;

console.log('已更新 ' + path.relative(root, file));
console.log('  manifest_version   ' + m.manifest_version);
console.log('  latest             ' + m.latest);
console.log('  force              ' + forceText);
console.log('  kill_below         ' + killText);
console.log('  force_after_hours  ' + m.force_after_hours);
console.log('');
console.log('下一步：git add release-manifest.json && git commit -m "chore: 更新更新策略" && git push');
