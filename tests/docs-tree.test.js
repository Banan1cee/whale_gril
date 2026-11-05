'use strict';

/**
 * README 目录树门禁：树里画的东西必须和「GitHub 仓库跟踪的条目」一致。
 *
 * 只解析 README「## Project structure」一节里的那个代码块，别把别处的代码块当目录树。
 * 三个方向：
 *   1. 树里每个一级路径都必须被 git 跟踪（防手写一个不存在的文件/目录）；
 *   2. 25 个必须出现在树里的跟踪条目，少一个就失败（防漏画新目录）；
 *   3. 不许出现运行期目录与被迁走的旧路径（data/ runtime/ artifacts/ config.json 不入库；
 *      web/ tools/ personas/ resources/ 已经删除或迁走）。
 *
 * git 不可用时（受限沙箱）退化成固定清单对照，不让门禁因为环境问题变红。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

// 反向断言的固定清单（git 不可用时的退化对照）
const REQUIRED = [
  '.gitattributes', '.gitignore', 'AGENTS.md', 'BUGS.md', 'CHANGELOG.md', 'CONTRIBUTING.md',
  'LICENSE', 'README.md', 'WhaleLauncher.exe', 'config.example.json', 'package.json',
  'release-manifest.json', 'requirements.txt', 'server.js',
  '.github', 'assets', 'bridge', 'docs', 'examples', 'installer', 'launcher', 'scripts',
  'src', 'tests', 'vendor',
];

const FORBIDDEN = ['data', 'runtime', 'artifacts', 'config.json', 'web', 'tools', 'personas', 'resources'];

/** 取出「## 目录结构」这一节里第一个代码块的行 */
function treeLines() {
  const heading = readme.indexOf('## Project structure');
  assert.ok(heading >= 0, 'README 缺少「## Project structure」一节');
  const nextHeading = readme.indexOf('\n## ', heading + 3);
  const section = readme.slice(heading, nextHeading < 0 ? undefined : nextHeading);
  const block = section.match(/```[^\n]*\n([\s\S]*?)```/);
  assert.ok(block, '「## Project structure」一节里没有代码块');
  return block[1].split(/\r?\n/).filter(Boolean);
}

/** 只取一级条目（行首就是 ├─ / └─），忽略根行与缩进的二级条目、注释 */
function firstLevel(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.match(/^[├└]─\s+([^\s#]+)/);
    if (!m) continue;
    const name = m[1].replace(/\/+$/, '');
    if (name) out.push(name);
  }
  return out;
}

function trackedTopLevel() {
  try {
    const out = execSync('git -c core.quotepath=false ls-files', {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(out.split(/\r?\n/).filter(Boolean).map((f) => f.split('/')[0]));
  } catch {
    return new Set(REQUIRED);
  }
}

test('目录树：每个一级路径都在 git 跟踪条目里', () => {
  const tracked = trackedTopLevel();
  assert.ok(tracked.size > 0, '拿不到跟踪清单');
  for (const name of firstLevel(treeLines())) {
    assert.ok(tracked.has(name), `目录树里的 ${name} 没有被 git 跟踪（或名字写错）`);
  }
});

test('目录树：25 个必须出现的跟踪条目一个都不能少', () => {
  const names = new Set(firstLevel(treeLines()));
  for (const rel of REQUIRED) {
    assert.ok(names.has(rel), `目录树漏了跟踪条目 ${rel}`);
  }
});

test('目录树：不含运行期目录、已删除或已迁走的旧路径，README 全文不含 .bat', () => {
  const names = firstLevel(treeLines());
  for (const bad of FORBIDDEN) {
    assert.equal(names.includes(bad), false, `目录树里不该出现 ${bad}`);
  }
  assert.equal(readme.includes('.' + 'bat'), false, 'README 里不该再出现脚本入口');
});
