'use strict';

/**
 * 发布前自检：打 zip 之前跑一遍，防止「代码改了但没进包」。
 *
 * 起因：3.0.3 的包里 web/index.html 还是旧的，导致「设置里找不到看图 API」，
 * 而源目录 D: 里明明是好的 —— 因为打包时从一份没同步全的副本取的。
 *
 * 用法：node scripts/release-check.js [目录，默认项目根]
 * 退出码：0 通过 / 1 有问题
 */
const fs = require('node:fs');
const path = require('node:path');

// 参数：第一个非 -- 开头的值是目录；--release 表示「这是发布树，不该有 data/config/runtime」
const argv = process.argv.slice(2);
const dirArg = argv.find((a) => !a.startsWith('--'));
const root = path.resolve(dirArg || path.join(__dirname, '..'));
const problems = [];
const rows = [];

function read(rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return '';
  }
}

function check(name, ok, detail = '') {
  rows.push({ name, ok, detail });
  if (!ok) problems.push(name + (detail ? '：' + detail : ''));
}

function mustInclude(rel, needles) {
  const text = read(rel);
  if (!text) {
    check(rel + ' 存在', false, '文件不存在');
    return;
  }
  for (const [label, needle] of needles) {
    check(`${rel} 含「${label}」`, text.includes(needle));
  }
}

// 1) 看图（图片识别）这条链路
mustInclude('web/index.html', [
  ['看图 API Key', 'visionApiKey'],
  ['测试看图按钮', 'btnVisionTest'],
]);
mustInclude('web/assets/app.js', [
  ['调用测试接口', '/api/vision/test'],
  ['提交 visionApiKey', 'visionApiKey'],
]);
mustInclude('server.js', [
  ['看图测试接口', "/api/vision/test"],
  ['返回 vision 状态', 'vision.status(config)'],
]);
mustInclude('src/vision.js', [
  ['Key 兜底解析', 'resolveKey'],
  ['按文件头判格式', 'sniffMime'],
  ['wxgf 提示', 'wxgf'],
]);

// 2) 主人识别
mustInclude('src/master.js', [['判定函数', 'matchMaster']]);
mustInclude('src/bot.js', [['剔除身份争执', 'stripMasterDispute']]);

// 3) UIA 可诊断
mustInclude('examples/wechatauto_bridge.py', [
  ['ffmpeg 自检', 'ensure_ffmpeg_env'],
  ['wxgf 转码', '_wxgf_to_jpg'],
  ['失败原因解释', 'explain_uia_failure'],
  ['中文路径提醒', '路径里有中文'],
]);
check('tools/uia-diag.py 存在', fs.existsSync(path.join(root, 'tools/uia-diag.py')));

// 4) 包里不该有隐私/运行数据（只有 --release 时才检查；在开发目录里这些本来就有）
const release = argv.includes('--release');
if (release) {
  check('没有 data/ 目录', !fs.existsSync(path.join(root, 'data')), '打包时要把 data/ 排除');
  check('没有 config.json', !fs.existsSync(path.join(root, 'config.json')), '用户自己的配置不该进包');
  check('没有 runtime/', !fs.existsSync(path.join(root, 'runtime')), '源码包不带运行时');
  check('没有 wechatauto_db/', !fs.existsSync(path.join(root, 'wechatauto_db')), '微信数据库快照不该进包');
} else {
  console.log('（开发目录模式：跳过 data/、config.json、runtime/ 的检查；打包前加 --release 再跑）\n');
}

// 5) 版本号与 CHANGELOG 首条一致
try {
  const pkg = JSON.parse(read('package.json'));
  const cl = read('CHANGELOG.md');
  const m = cl.match(/^##\s*([0-9]+\.[0-9]+\.[0-9]+)/m);
  check('package.json 版本 = CHANGELOG 最新条目', Boolean(m) && m[1] === pkg.version,
    `package=${pkg.version} changelog=${m ? m[1] : '没找到'}`);

  // 6) 一个改动 = 一个版本号：不允许重复版本 / 跳号 / 空条目
  const heads = [...cl.matchAll(/^##\s*([0-9]+)\.([0-9]+)\.([0-9]+)\s*$/gm)].map((x) => ({ raw: x[1] + '.' + x[2] + '.' + x[3], maj: Number(x[1]), min: Number(x[2]), pat: Number(x[3]), at: x.index }));
  const seen = new Map();
  const dupes = [];
  for (const h of heads) {
    if (seen.has(h.raw)) dupes.push(h.raw);
    seen.set(h.raw, true);
  }
  check('CHANGELOG 没有重复版本号', dupes.length === 0, dupes.length ? '重复：' + dupes.join(', ') : `${heads.length} 个版本`);

  // 同一条主线（主.次 相同）里补丁号必须连续：3.0.0~3.0.15 不能缺 3.0.7。
  // 只查「package.json 所在的那条线」——历史版本（比如从上游接手的 2.9.2）不一定连续。
  const missing = [];
  const line = `${pkg.version.split('.')[0]}.${pkg.version.split('.')[1]}`;
  const pats = heads.filter((h) => `${h.maj}.${h.min}` === line).map((h) => h.pat);
  if (pats.length) {
    const max = Math.max(...pats);
    for (let i = 0; i <= max; i += 1) if (!pats.includes(i)) missing.push(`${line}.${i}`);
  }
  check('版本号连续（不跳号）', missing.length === 0, missing.length ? '缺：' + missing.join(', ') : `${line}.x 共 ${pats.length} 个`);

  // 每个版本都得有内容，不能只有标题
  const empty = [];
  for (let i = 0; i < heads.length; i += 1) {
    const start = heads[i].at;
    const end = i + 1 < heads.length ? heads[i + 1].at : cl.length;
    const body = cl.slice(start, end).replace(/^##.*$/m, '').trim();
    if (!body) empty.push(heads[i].raw);
  }
  check('每个版本都有说明内容', empty.length === 0, empty.length ? '空条目：' + empty.join(', ') : '');

  // 7) 版本号必须在台面上可见：包名带版本、横幅与网页都显示
  try {
    const build = read('scripts/build-release.ps1');
    const dynamicPkg = /\$pkgName\s*=\s*"whale-girl-\$ver"/.test(build);
    check('包名带完整版本号', dynamicPkg && !/'whale-girl-3\.0\.zip'/.test(build),
      dynamicPkg ? 'whale-girl-$ver.zip' : '仍写死 whale-girl-3.0.zip');
    const server = read('server.js');
    check('启动横幅显示版本', /runtime\.version/.test(server) && /版本：/.test(server), '');
    const html = read('web/index.html');
    check('网页显示版本', /id="buildVersion"/.test(html), '');
  } catch (e) {
    check('版本可见性检查可运行', false, e.message);
  }
} catch (e) {
  check('package.json 可解析', false, e.message);
}

// 8) 不能把自己的隐私带进包里：密钥、真实 wxid、带中文用户名的绝对路径
//    以前这三样都漏过（BUGS.md 写了真实路径、手册列了禁用串、出包脚本默认目录写死用户名），
//    所以做成硬检查：命中就不许出包。
try {
  const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'runtime', 'backup', '__pycache__', 'wechatauto_db', 'wechatauto_logs']);
  const SKIP_FILES = /(^|\/)(config\.json|settings\.json|.*\.log|.*\.bak.*|.*\.zip)$/;
  const walk = (dir) => {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        out.push(...walk(full));
      } else if (!SKIP_FILES.test(rel)) {
        out.push(rel);
      }
    }
    return out;
  };
  const files = walk(root).filter((f) => /\.(js|json|md|py|ps1|bat|html|css|txt|yml|yaml)$/i.test(f));
  // 只认「本机上真实存在的东西」：占位示例（张三、wxid_xxxxxxxx）不该误报。
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = new Set(
    [process.env.USERNAME, (process.env.USERPROFILE || '').split(/[\\/]/).pop()]
      .filter((s) => s && s.length >= 2),
  );
  const rules = [
    { name: '密钥', re: /\bsk-[A-Za-z0-9]{16,}/g },
    // 占位符形如 wxid_xxxxxxxx（同一个字符重复），真 wxid 不会这样
    { name: '真实 wxid', re: /\bwxid_[a-z0-9]{12,}\b/g, keep: (m) => !/^wxid_(.)\1+$/.test(m) },
    ...[...names].map((n) => ({
      name: `本机用户名路径（${n}）`,
      re: new RegExp('C:\\\\Users\\\\' + esc(n) + '\\\\', 'gi'),
    })),
  ];
  const found = [];
  for (const rel of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    for (const r of rules) {
      r.re.lastIndex = 0;
      const all = text.match(r.re) || [];
      const hits = r.keep ? all.filter(r.keep) : all;
      if (hits.length) found.push(`${rel}（${r.name}×${hits.length}）`);
    }
  }
  check('没有个人信息（密钥 / 真实 wxid / 本机用户名）', found.length === 0,
    found.length ? found.slice(0, 4).join('、') : `${files.length} 个文件干净`);
} catch (e) {
  check('个人信息检查可运行', false, e.message);
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
console.log(`发布自检：${root}\n`);
for (const r of rows) {
  console.log(`${r.ok ? '✓' : '✗'} ${pad(r.name, 46)}${r.detail || ''}`);
}
console.log('');
if (problems.length) {
  console.error(`发现 ${problems.length} 个问题，先修再打包：`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`全部通过（${rows.length} 项）`);
