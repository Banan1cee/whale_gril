'use strict';

/**
 * 台账自检：`BUGS.md` 里每一条修过的 bug 都必须指向一个**真实存在、且真有断言**的测试文件。
 *
 * 为什么要有这条测试：
 *   - 台账是「回归看这里」的唯一入口，写错一个路径就等于这条 bug 再也没人守；
 *   - 实际上已经坏过一次：有 6 行的路径被转义成了「TAB + ests/」（`tests/` 的 `\t` 被吃掉了），
 *     人眼很难看出来，自动化一眼就红；
 *   - 「补一条能复现它的测试」是台账自己写下的规矩（文件末尾第 4 条），
 *     这条测试就是那句规矩的执行器。
 *
 * 它只读文件，不跑别的用例，所以很便宜。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BUGS_MD = path.join(ROOT, 'BUGS.md');
const TESTS_DIR = path.join(ROOT, 'tests');

/** 表格行 → { line, id, symptom, cause, fix, version, regression, cells } */
function readRows() {
  const text = fs.readFileSync(BUGS_MD, 'utf8');
  const rows = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    if (!line.startsWith('|')) return;
    const cells = line.split('|');
    // 首尾各有一个空串（行首/行尾的竖线）
    if (cells.length < 8) return;
    const id = String(cells[1]).trim();
    if (!/^\d+$/.test(id)) return; // 跳过表头与分隔行
    const pick = (i) => String(cells[i] || '').trim();
    rows.push({
      line: idx + 1,
      id: Number(id),
      symptom: pick(2),
      cause: pick(3),
      fix: pick(4),
      version: pick(5),
      regression: pick(6),
      cells: cells.length - 2,
    });
  });
  return rows;
}

const rows = readRows();

test('台账存在并且不是空的（每条真实故障都要留一行）', () => {
  assert.ok(fs.existsSync(BUGS_MD), 'BUGS.md 不见了');
  assert.ok(rows.length >= 25, `台账只剩 ${rows.length} 行，明显被删过`);
});

test('每行都是完整的 6 列：现象 / 根因 / 修复 / 版本 / 回归测试', () => {
  for (const r of rows) {
    assert.equal(r.cells, 6, `第 ${r.line} 行（#${r.id}）列数不是 6，可能是竖线被吃掉了`);
    for (const [field, label] of [['symptom', '现象'], ['cause', '根因'], ['fix', '修复'], ['version', '版本'], ['regression', '回归测试']]) {
      assert.ok(r[field].length > 0, `第 ${r.line} 行（#${r.id}）的「${label}」是空的`);
    }
  }
});

test('版本列是合法版本号，id 唯一且连续（没有删行 / 重号），最新的在最上面', () => {
  const ids = rows.map((r) => r.id);
  for (const r of rows) {
    assert.match(r.version.replace(/^v/i, ''), /^\d+(\.\d+){1,3}$/, `第 ${r.line} 行（#${r.id}）版本号写成「${r.version}」`);
  }
  assert.equal(new Set(ids).size, ids.length, `台账里有重复的 bug 编号：${ids.filter((v, i) => ids.indexOf(v) !== i).join(',')}`);
  const max = Math.max(...ids);
  const missing = [];
  for (let i = 1; i <= max; i += 1) if (!ids.includes(i)) missing.push(i);
  assert.deepEqual(missing, [], `编号不连续，缺了 ${missing.join(',')}（删行会让后来的人对不上号）`);
  // 「修新 bug 时照这个格式加到最上面」——只要求最新一条在最前面，
  // 历史批次内部的顺序（#25/#26/#27 这种）不强制。
  assert.equal(rows[0].id, max, `最新的一条应该在表格最上面，实际第一行是 #${rows[0].id}，最大编号是 #${max}`);
});

test('回归测试列不许有被转义坏掉的路径（TAB + ests/、\\tests/ 这类）', () => {
  for (const r of rows) {
    assert.equal(/\t\s*ests\//.test(r.regression), false, `第 ${r.line} 行（#${r.id}）的测试路径里混进了 TAB：${JSON.stringify(r.regression)}`);
    assert.equal(/\\tests\//.test(r.regression), false, `第 ${r.line} 行（#${r.id}）的测试路径被转义成了反斜杠：${JSON.stringify(r.regression)}`);
  }
});

test('每条 bug 都指向至少一个 tests/*.test.js（#9 是出包自检，例外）', () => {
  const exempt = new Set();
  for (const r of rows) {
    const refs = r.regression.match(/tests\/[\w.-]+\.test\.js/g) || [];
    if (refs.length === 0) {
      // 唯一的例外：出包类 bug 靠 release-check / 出包脚本守
      const byScript = /release-check|出包脚本|build-release/.test(r.regression);
      assert.ok(byScript, `第 ${r.line} 行（#${r.id}）既没指测试文件，也不是出包自检：${JSON.stringify(r.regression)}`);
      exempt.add(r.id);
      continue;
    }
  }
  assert.ok(exempt.size <= 2, `靠脚本站台的 bug 太多了（${[...exempt].join(',')}），回归覆盖在退化`);
});

test('台账里提到的测试文件必须真实存在', () => {
  const missing = new Set();
  for (const r of rows) {
    const refs = r.regression.match(/tests\/[\w.-]+\.test\.js/g) || [];
    for (const ref of refs) {
      if (!fs.existsSync(path.join(ROOT, ref))) missing.add(`${ref}（第 ${r.line} 行 #${r.id}）`);
    }
  }
  assert.deepEqual([...missing], [], '台账指向了不存在的测试文件：\n  ' + [...missing].join('\n  '));
});

test('台账提到的测试文件里必须真的有断言（空壳文件不算覆盖）', () => {
  const refs = new Set();
  for (const r of rows) for (const ref of r.regression.match(/tests\/[\w.-]+\.test\.js/g) || []) refs.add(ref);
  assert.ok(refs.size >= 8, `只引用了 ${refs.size} 个测试文件，回归面太窄`);
  for (const ref of refs) {
    const full = path.join(ROOT, ref);
    if (!fs.existsSync(full)) continue; // 交给上一条用例报
    const src = fs.readFileSync(full, 'utf8');
    const hasCase = /\b(?:test|it)\(\s*['"`]/.test(src) || /\b(?:test|it)\(\s*`/.test(src);
    assert.ok(hasCase, `${ref} 里没有一条 test()：台账指的测试是空壳`);
  }
});

test('台账尾部仍然写着「修 bug 的固定动作」五步（防止后来的人把流程删掉）', () => {
  const text = fs.readFileSync(BUGS_MD, 'utf8');
  assert.match(text, /修 bug 的固定动作/, 'BUGS.md 的流程说明被删了');
  assert.match(text, /补回归测试/, '流程第 4 步「补回归测试」被删了');
});

test('新增的测试文件本身都在 tests/ 目录里、命名是 *.test.js（CI 的 glob 只认这个）', () => {
  const files = fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    assert.match(f, /\.test\.js$/, `tests/${f} 不是 *.test.js，npm test 的 glob 不会跑到它`);
  }
});
