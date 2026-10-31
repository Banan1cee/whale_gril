'use strict';

/**
 * 隐私扫描：把「不许进仓库 / 不许进包」的字符串集中在这里，供
 * `scripts/release-check.js` 与 CI 共用。
 *
 * 为什么单独一个文件：3.x 的 release-check 只认 `sk-`、裸 wxid 和本机用户名，
 * 结果真实的小号目录名 `wxid_xxx_cedb`、群号、手机号、邮箱、带调试路径的 exe
 * 都能一路进到公开仓库。规则散在脚本里没法单测，所以收成模块。
 *
 * 判定原则：
 * - 宁可漏报可疑散文，也不把测试占位符（wxid_test_*、wxid_aaaa1111_cedb、
 *   `00000000000@chatroom`）当成泄露，否则 CI 天天红，大家就会把检查关掉。
 * - 二进制只查 ASCII/UTF-16 里能出现的路径与源码托管链接，不做反编译。
 */
const fs = require('node:fs');
const path = require('node:path');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'data', 'runtime', 'backup', '__pycache__',
  'wechatauto_db', 'wechatauto_logs',
]);
// 构建缓存与审查产物：launcher/obj 里的 FileListAbsolute.txt 本来就记本机路径，
// 不跳过会把「刚编译完」误报成泄露。这里只跳中间产物，launcher/publish 的成品要扫。
const SKIP_PREFIX = [
  'launcher/bin/', 'launcher/obj/',
  'dist/', 'release/', '.tools/', 'artifacts/',
  'tests/launcher/Checks/bin/', 'tests/launcher/Checks/obj/',
  'tests/launcher/FakeBridge/bin/', 'tests/launcher/FakeBridge/obj/',
  '.venv/', 'venv/',
];
const SKIP_FILES = /(^|\/)(config\.json|settings\.json|.*\.log|.*\.bak.*|.*\.zip)$/;
const TEXT_EXT = /\.(js|json|md|py|ps1|bat|html|css|txt|yml|yaml)$/i;
const BINARY_EXT = /\.(exe|dll|pdb|node|sys)$/i;

const WXID_PLACEHOLDER = /(test|demo|self|master|someone|fake|other|boss|chat|peer|fast|friend|stranger|owner|weixin|account|nope|xxx|aaaa|bbbb|cccc)/i;
const EMAIL_ALLOWED = /(^|[.@])(example\.(com|org|net)|localhost|users\.noreply\.github\.com)$/i;
const GROUP_PLACEHOLDER = /^(\d)\1+@/;

function looksPlanted(value) {
  return WXID_PLACEHOLDER.test(value) || /(.)\1{2,}/.test(value);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mask(value) {
  const text = String(value);
  if (text.length <= 6) return '***';
  return text.slice(0, 6) + '***';
}

function textRules() {
  const names = new Set(
    [process.env.USERNAME, (process.env.USERPROFILE || '').split(/[\\/]/).pop()]
      .filter((s) => s && s.length >= 2),
  );
  return [
    { name: '密钥', re: /\bsk-[A-Za-z0-9]{16,}/g },
    {
      name: '云服务密钥',
      re: /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/g,
    },
    { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
    // 裸 wxid（≥12 位）与带 4 位目录后缀的账号目录名分开报，后者正是历史事故的形态
    { name: '真实 wxid', re: /\bwxid_[a-z0-9]{12,}\b/g, keep: (m) => !looksPlanted(m) },
    { name: '真实 wxid（账号目录）', re: /\bwxid_[a-z0-9]{6,}_[a-z0-9]{4}\b/g, keep: (m) => !looksPlanted(m) },
    { name: '群号', re: /\b\d{9,}@chatroom\b/g, keep: (m) => !GROUP_PLACEHOLDER.test(m) },
    { name: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
    {
      name: '邮箱',
      re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      keep: (m) => !EMAIL_ALLOWED.test(m),
    },
    ...[...names].map((n) => ({
      name: `本机用户名路径（${n}）`,
      re: new RegExp('C:\\\\Users\\\\' + escapeRe(n) + '\\\\', 'gi'),
    })),
  ];
}

const BINARY_RULES = [
  { name: '本机用户目录（二进制）', re: /C:\\Users\\/g },
  { name: '源码托管链接（二进制）', re: /raw\.githubusercontent\.com/gi },
];

function scanText(text, file = '', rules = textRules()) {
  const findings = [];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    const all = [];
    for (const m of String(text).matchAll(rule.re)) all.push(m[0]);
    const hits = rule.keep ? all.filter(rule.keep) : all;
    for (const hit of hits) findings.push({ file, rule: rule.name, sample: mask(hit) });
  }
  return findings;
}

function scanBinaryBuffer(buffer, file = '') {
  const findings = [];
  const seen = new Set();
  for (const encoding of ['latin1', 'utf16le']) {
    const text = buffer.toString(encoding);
    for (const rule of BINARY_RULES) {
      rule.re.lastIndex = 0;
      for (const m of text.matchAll(rule.re)) {
        const key = rule.name + ':' + m.index;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ file, rule: rule.name, sample: mask(m[0]) });
      }
    }
  }
  return findings;
}

function walk(root, dir = root) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // 临时目录可能正被别的进程删除/改 ACL；读不了就跳过，别让自检崩掉
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      // 中间产物整棵跳过：artifacts/ 下常有正在删的临时目录，walk 进去会 EPERM
      if (SKIP_PREFIX.some((p) => (rel + '/').startsWith(p))) continue;
      out.push(...walk(root, full));
    } else if (!SKIP_FILES.test(rel)) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * @param {string} root 项目根目录
 * @returns {{findings: Array, files: number, binaries: number}}
 */
function scan(root) {
  const findings = [];
  let files = 0;
  let binaries = 0;
  for (const rel of walk(root)) {
    const full = path.join(root, rel);
    const norm = rel.split(path.sep).join('/');
    if (SKIP_PREFIX.some((p) => norm.startsWith(p))) continue;
    try {
      if (TEXT_EXT.test(rel)) {
        files += 1;
        findings.push(...scanText(fs.readFileSync(full, 'utf8'), rel));
      } else if (BINARY_EXT.test(rel)) {
        binaries += 1;
        findings.push(...scanBinaryBuffer(fs.readFileSync(full), rel));
      }
    } catch {
      // 读不了就跳过：权限问题不该让发布自检直接崩
    }
  }
  return { findings, files, binaries };
}

module.exports = { scan, scanText, scanBinaryBuffer, textRules, looksPlanted, mask };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  const { findings, files, binaries } = scan(root);
  console.log(`隐私扫描：${root}\n文本 ${files} 个，二进制 ${binaries} 个`);
  if (!findings.length) {
    console.log('未发现个人信息');
  } else {
    for (const f of findings) console.log(`✗ ${f.file}（${f.rule}）${f.sample}`);
    console.error(`\n发现 ${findings.length} 处，先清理再提交/出包`);
    process.exit(1);
  }
}
