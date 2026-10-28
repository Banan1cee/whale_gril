'use strict';

/**
 * 分层检查：谁可以 require 谁。
 *
 * 这不是「学术洁癖」——它挡的是真实发生过的问题：
 *   - core 里 require persona，结果「纯逻辑」单元测试要读文件系统；
 *   - services require http，结果想换个 HTTP 框架要动业务代码；
 *   - adapters 反向依赖 pipeline，结果一改对话流程所有适配器都要跟着改。
 *
 * 规则只写「禁止」，没列到的都允许。新增依赖前先问：
 * 「这条边是往上层走，还是往 IO 走？」
 *
 * 例外（有意为之，写在下面的 ALLOW 里）：
 *   core → infra/features   只是读配置里的布尔值，没有 IO，纯函数。
 *
 * 用法：node scripts/check-layers.js
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src');
const LAYERS = ['core', 'pipeline', 'persona', 'memory', 'llm', 'services', 'adapters', 'http', 'infra'];

const RULES = [
  { from: 'core', deny: ['adapters', 'services', 'http', 'pipeline', 'memory', 'llm', 'persona'] },
  { from: 'adapters', deny: ['pipeline', 'services', 'http'] },
  { from: 'memory', deny: ['pipeline', 'services', 'http', 'adapters'] },
  { from: 'llm', deny: ['pipeline', 'services', 'http', 'adapters'] },
  { from: 'persona', deny: ['pipeline', 'services', 'http'] },
  { from: 'pipeline', deny: ['http'] },
  // 服务层可以拿 HTTP 协议工具（json/readBody/sseSend），但不能碰服务器实现
  { from: 'services', deny: ['http/router', 'http/security', 'http/static', 'http/util'] },
];

const ALLOW = ['core -> infra/features'];

function layerOf(relPath) {
  const first = relPath.split(/[\\/]/)[0];
  return LAYERS.includes(first) ? first : null;
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function checksFor(fileRel) {
  const layer = layerOf(fileRel);
  const rule = RULES.find((r) => r.from === layer);
  return rule ? rule.deny : [];
}

function check() {
  const violations = [];
  for (const abs of walk(SRC)) {
    const rel = path.relative(SRC, abs).replace(/\\/g, '/');
    const deny = checksFor(rel);
    if (!deny.length) continue;

    const text = fs.readFileSync(abs, 'utf8');
    const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(text))) {
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(rel), m[1].replace(/\\/g, '/'))
      );
      const targetLayer = layerOf(target);
      if (!targetLayer) continue;
      for (const banned of deny) {
        // `http/router` 这种「层 + 子路径」按前缀匹配；只写 `http` 就整层禁
        const hit = target === banned || target.startsWith(banned + '/');
        if (!hit) continue;
        const edge = layerOf(rel) + ' -> ' + target;
        if (ALLOW.includes(edge)) continue;
        violations.push({ file: rel, require: m[1], target, rule: `${layerOf(rel)} -/-> ${banned}` });
      }
    }
  }
  return violations;
}

function main() {
  const violations = check();
  if (!violations.length) {
    console.log('分层检查通过：' + walk(SRC).length + ' 个文件，没有反向依赖。');
    return 0;
  }
  console.error('分层检查失败（' + violations.length + ' 处）：');
  for (const v of violations) {
    console.error('  ' + v.file + '  require(' + v.require + ')  →  ' + v.target + '   [' + v.rule + ']');
  }
  console.error('\n要么把依赖反转（传参 / 注入），要么在 scripts/check-layers.js 的 ALLOW 里写明理由。');
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { check, LAYERS, RULES, ALLOW };
