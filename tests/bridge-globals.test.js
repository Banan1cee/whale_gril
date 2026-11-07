'use strict';

/**
 * 两条互相独立、但都会让桥接直接起不来的 bug：
 *
 * 1) config.json 解析失败（手填路径单反斜杠）时，engine.py 读配置的那段
 *    `try` 在 json.load 处整段中断，QUOTE_REPLY 等 7 个开关一个都赋不上值，
 *    而它们以前**没有模块级默认值** → main() 里一读就 NameError → 退出码 1。
 * 2) 桥接模块化后，app.py / 各 mixin 只 `import engine as G`，但代码里还留着
 *    拆分前的裸名 `QUOTE_REPLY`、`MessagePipeline`、`uia_boot`……
 *    这些名字在自己模块里根本不存在 → 运行到那一行才 NameError。
 *
 * 这里用「AST 扫裸名」+「拿坏 config.json 真的 import 一遍」两条路一起盯。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const py = path.join(root, 'runtime', 'python', 'python.exe');
const hasPy = fs.existsSync(py);
const bridgeDir = path.join(root, 'bridge');

const ENGINE_GLOBALS = [
  'QUOTE_REPLY',
  'KEYBOARD_FALLBACK',
  'BACKGROUND_SEND',
  'ACCOUNT_GUARD',
  'WINDOW_HWND',
  'LOW_BATTERY_PCT',
  'GOODNIGHT_TEXT',
];

function runPy(code) {
  return execFileSync(py, ['-c', code], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180000,
  });
}

function lastJsonLine(out) {
  const lines = String(out).trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test('engine.py 给 7 个配置开关都留了模块级默认值（读配置之前）', () => {
  const src = fs.readFileSync(path.join(bridgeDir, 'engine.py'), 'utf8');
  for (const name of ENGINE_GLOBALS) {
    assert.match(
      src,
      new RegExp(`^${name} = `, 'm'),
      `${name} 必须有模块级默认值，否则 config.json 坏掉时会 NameError`
    );
  }
  // 默认值要和 try 里 _wechat.get(...) 的兜底值一致，不能是随手写的
  assert.match(src, /^QUOTE_REPLY = False$/m, 'quoteReply 的默认就是关');
  assert.match(src, /^KEYBOARD_FALLBACK = True$/m);
  assert.match(src, /^BACKGROUND_SEND = True$/m);
  assert.match(src, /^ACCOUNT_GUARD = True$/m);
  assert.match(src, /^GOODNIGHT_TEXT = '晚安/m);
});

test('config.json 是坏的：engine 仍能导入，7 个全局都在（修复前是 NameError）', { skip: !hasPy && '没有内置 python' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bridge-cfg-'));
  try {
    fs.cpSync(bridgeDir, path.join(tmp, 'bridge'), { recursive: true });
    // 和事故现场一样：Windows 路径只写了一个反斜杠 → Invalid \escape
    fs.writeFileSync(path.join(tmp, 'config.json'), '{"wechat": {"dbDir": "E:\\WeChat Files"}}', 'utf8');

    const code = [
      'import importlib.util, json, sys',
      `sys.path.insert(0, ${JSON.stringify(path.join(tmp, 'bridge'))})`,
      `spec = importlib.util.spec_from_file_location("engine", ${JSON.stringify(path.join(tmp, 'bridge', 'engine.py'))})`,
      'm = importlib.util.module_from_spec(spec)',
      'sys.modules["engine"] = m',
      'spec.loader.exec_module(m)',
      `print(json.dumps({k: (k in vars(m)) for k in ${JSON.stringify(ENGINE_GLOBALS)}}))`,
    ].join('\n');

    const got = lastJsonLine(runPy(code));
    for (const name of ENGINE_GLOBALS) {
      assert.equal(got[name], true, `${name} 在配置解析失败时也必须有值`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('mixin 不许裸用 engine 的模块级名字（裸名 = 运行到那一行才 NameError）', { skip: !hasPy && '没有内置 python' }, () => {
  const code = [
    'import ast, json, os',
    `bridge = ${JSON.stringify(bridgeDir)}`,
    '',
    'def module_bound(tree):',
    '    """模块级绑定的名字（含模块级 try/if 里的赋值与 import）。"""',
    '    names = set()',
    '    def walk(nodes):',
    '        for n in nodes:',
    '            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):',
    '                names.add(n.name)',
    '            elif isinstance(n, ast.Assign):',
    '                for t in n.targets:',
    '                    names.update(x.id for x in ast.walk(t) if isinstance(x, ast.Name))',
    '            elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):',
    '                names.add(n.target.id)',
    '            elif isinstance(n, (ast.Import, ast.ImportFrom)):',
    '                for a in n.names:',
    '                    names.add((a.asname or a.name).split(".")[0])',
    '            elif isinstance(n, (ast.If, ast.Try, ast.For, ast.While, ast.With)):',
    '                walk(getattr(n, "body", []))',
    '                walk(getattr(n, "handlers", []) or [])',
    '                walk(getattr(n, "orelse", []) or [])',
    '                walk(getattr(n, "finalbody", []) or [])',
    '    walk(tree.body)',
    '    return names',
    '',
    'def file_bound(tree):',
    '    own = module_bound(tree)',
    '    for n in ast.walk(tree):',
    '        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):',
    '            own.add(n.id)',
    '        elif isinstance(n, ast.arg):',
    '            own.add(n.arg)',
    '        elif isinstance(n, (ast.Import, ast.ImportFrom)):',
    '            for a in n.names:',
    '                own.add((a.asname or a.name).split(".")[0])',
    '        elif isinstance(n, (ast.Global, ast.Nonlocal)):',
    '            own.update(n.names)',
    '        elif isinstance(n, ast.ExceptHandler) and n.name:',
    '            own.add(n.name)',
    '        elif isinstance(n, (ast.For, ast.AsyncFor)):',
    '            own.update(x.id for x in ast.walk(n.target) if isinstance(x, ast.Name))',
    '        elif isinstance(n, (ast.With, ast.AsyncWith)):',
    '            for it in n.items:',
    '                if it.optional_vars:',
    '                    own.update(x.id for x in ast.walk(it.optional_vars) if isinstance(x, ast.Name))',
    '        elif isinstance(n, ast.NamedExpr) and isinstance(n.target, ast.Name):',
    '            own.add(n.target.id)',
    '        elif isinstance(n, ast.comprehension):',
    '            own.update(x.id for x in ast.walk(n.target) if isinstance(x, ast.Name))',
    '        elif isinstance(n, getattr(ast, "MatchAs", ())) and getattr(n, "name", None):',
    '            own.add(n.name)',
    '    return own',
    '',
    'with open(os.path.join(bridge, "engine.py"), encoding="utf-8") as f:',
    '    engine_names = module_bound(ast.parse(f.read()))',
    'problems = {}',
    'for name in sorted(os.listdir(bridge)):',
    '    if not name.endswith(".py") or name == "engine.py":',
    '        continue',
    '    with open(os.path.join(bridge, name), encoding="utf-8") as f:',
    '        tree = ast.parse(f.read())',
    '    own = file_bound(tree)',
    '    bare = {}',
    '    for n in ast.walk(tree):',
    '        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id in engine_names and n.id not in own:',
    '            bare.setdefault(n.id, []).append(n.lineno)',
    '    if bare:',
    '        problems[name] = bare',
    'print(json.dumps(problems, ensure_ascii=False))',
  ].join('\n');

  const problems = lastJsonLine(runPy(code));
  assert.deepEqual(
    problems,
    {},
    '这些名字在本文件里没定义，只能走 G.xxx：' + JSON.stringify(problems, null, 2)
  );
});
