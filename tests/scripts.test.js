'use strict';

/**
 * 启动脚本检查：.bat 必须是 CRLF，否则 cmd 会报「命令语法不正确」。
 * 这个坑踩过一次：一键终止.bat 用 LF 存盘，双击直接失败。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function listBat(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) {
      if (['node_modules', 'release', 'data', 'vendor'].includes(name.name)) continue;
      out.push(...listBat(full));
      continue;
    }
    if (name.name.toLowerCase().endsWith('.bat')) out.push(full);
  }
  return out;
}

test('所有 .bat 都用 CRLF 换行', () => {
  const files = listBat(root);
  assert.ok(files.length >= 5, '应该找到启动脚本，实际 ' + files.length);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const bareLf = text.split('\n').filter((line, i, all) => i < all.length - 1 && !line.endsWith('\r'));
    assert.equal(bareLf.length, 0, path.basename(file) + ' 有 ' + bareLf.length + ' 行是 LF 换行，cmd 会报语法错误');
  }
});

test('一键终止.bat 存在，并且调用 stop-all.ps1', () => {
  const bat = path.join(root, '一键终止.bat');
  assert.ok(fs.existsSync(bat), '缺少 一键终止.bat');
  const text = fs.readFileSync(bat, 'utf8');
  assert.match(text, /stop-all\.ps1/);
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'stop-all.ps1')), '缺少 scripts\\stop-all.ps1');
});

test('启动脚本会清掉失效的本机代理（否则所有模型请求都连不上）', () => {
  const ps1 = fs.readFileSync(path.join(root, 'scripts', 'start.ps1'), 'utf8');
  assert.match(ps1, /HTTPS_PROXY/, 'start.ps1 要处理 HTTPS_PROXY');
  assert.match(ps1, /Remove-Item "env:/, '要真的删掉代理环境变量');
  assert.match(ps1, /NO_PROXY/);
  const bat = fs.readFileSync(path.join(root, '启动微信桥接.bat'), 'utf8');
  assert.match(bat, /set "HTTPS_PROXY="/, '桥接启动时也要清代理');
});

test('start.ps1 必须是带 BOM 的 UTF-8（否则中文会让 PowerShell 解析失败）', () => {
  const p = path.join(root, 'scripts', 'start.ps1');
  const buf = fs.readFileSync(p);
  assert.equal(buf[0], 0xef, 'start.ps1 缺 BOM，PowerShell 5.1 会解析中文失败');
  assert.equal(buf[1], 0xbb);
  assert.equal(buf[2], 0xbf);
});

test('优先用包里自带的 runtime\\node.exe（用户不用装 Node）', () => {
  const ps1 = fs.readFileSync(path.join(root, 'scripts', 'start.ps1'), 'utf8');
  assert.match(ps1, /runtime\\node\.exe/, '要支持包内运行时');
  assert.match(ps1, /包内 runtime/, '要标明来源');
  // 包内运行时必须排在 PATH 检测之前
  const bundledAt = ps1.indexOf('runtime\\node.exe');
  const pathAt = ps1.indexOf("From = 'PATH'");
  assert.ok(bundledAt > 0 && pathAt > bundledAt, '包内运行时应该先于 PATH 被选中');
});

test('桥接启动脚本在缺 Python 时给提示，而不是一闪而过', () => {
  const bat = fs.readFileSync(path.join(root, '启动微信桥接.bat'), 'utf8');
  assert.match(bat, /没找到 Python/);
  assert.match(bat, /python\.org/);
});

test('stop-all.ps1 会写暂停标记，并覆盖服务/桥接/守护/热键', () => {
  const ps1 = fs.readFileSync(path.join(root, 'scripts', 'stop-all.ps1'), 'utf8');
  assert.match(ps1, /PAUSED/, '必须写 data\\PAUSED，否则 bridge_loop 会重新拉起桥接');
  assert.match(ps1, /wechatauto_bridge\.py/);
  assert.match(ps1, /server\.js/);
  assert.match(ps1, /bridge_loop\.bat/);
  assert.match(ps1, /hotkey_daemon\.py/);
  assert.match(ps1, /8787/, '要有按端口兜底');
});

test('桥接启动脚本会清掉 PAUSED，避免手动启动被挡住', () => {
  const text = fs.readFileSync(path.join(root, '启动微信桥接.bat'), 'utf8');
  assert.match(text, /del \/q "data\\PAUSED"/);
});
/* ---------------- 维护脚本（部署 / 出包） ---------------- */

test('部署与出包脚本存在，且是带 BOM 的 UTF-8（否则 PowerShell 5.1 解析中文会报错）', () => {
  for (const rel of ['scripts/deploy.ps1', 'scripts/build-release.ps1']) {
    const p = path.join(root, rel);
    assert.ok(fs.existsSync(p), '缺少 ' + rel);
    const buf = fs.readFileSync(p);
    assert.equal(buf[0], 0xef, rel + ' 缺 BOM');
    assert.equal(buf[1], 0xbb);
    assert.equal(buf[2], 0xbf);
  }
});

test('部署脚本只同步代码，绝不覆盖运行数据', () => {
  const text = fs.readFileSync(path.join(root, 'scripts', 'deploy.ps1'), 'utf8');
  assert.match(text, /robocopy/);
  assert.match(text, /'data'/, '要把 data 排除掉');
  assert.match(text, /'config\.json'/, '要把 config.json 排除掉');
  assert.match(text, /'runtime'/, '要把 runtime 排除掉');
  assert.match(text, /Get-FileHash/, '要有哈希校验，防止「改了但没过去」');
});

test('出包脚本会跑测试与发布自检，并从 zip 里复核内容', () => {
  const text = fs.readFileSync(path.join(root, 'scripts', 'build-release.ps1'), 'utf8');
  assert.match(text, /--test/, '要先跑测试');
  assert.match(text, /release-check\.js' --release|release-check\.js --release/, '要跑发布自检');
  assert.match(text, /ZipFile/, '要从 zip 里读文件复核');
  assert.match(text, /visionApiKey/, '要检查看图字段真的在包里（3.0.3 事故）');
});

test('维护文档与 bug 台账在', () => {
  assert.ok(fs.existsSync(path.join(root, 'docs', '维护手册.md')), '缺少 docs/维护手册.md');
  assert.ok(fs.existsSync(path.join(root, 'BUGS.md')), '缺少 BUGS.md');
  const bugs = fs.readFileSync(path.join(root, 'BUGS.md'), 'utf8');
  assert.match(bugs, /回归测试/, '每个 bug 要有回归测试列');
});
test('桥接会定时发心跳，网页才看得到「桥接在线 / UIA 不可用」', () => {
  const bridge = fs.readFileSync(path.join(root, 'examples', 'wechatauto_bridge.py'), 'utf8');
  assert.match(bridge, /def bridge_heartbeat/);
  assert.match(bridge, /\/api\/bridge\/heartbeat/);
  assert.match(bridge, /UIA_CACHE\.get\("u"\)/);
  assert.match(bridge, /"rest": resting/, '休息模式要单独上报，不能当成 UIA 坏了');
  assert.match(bridge, /time\.sleep\(20\)/, '20 秒一次');
});
/* ---------------- 重置全部 = 恢复出厂 ---------------- */

test('重置全部.bat 交给 factory-reset.ps1，不再是「只重启」', () => {
  const bat = fs.readFileSync(path.join(root, '重置全部.bat'), 'utf8');
  assert.match(bat, /factory-reset\.ps1/, '要调用恢复出厂脚本');
  assert.doesNotMatch(bat, /start "鲸鲸服务"/, '不该自己再起服务（交给 ps1）');
});

test('恢复出厂会备份、清空 data/config、并用示例重建', () => {
  const p = path.join(root, 'scripts', 'factory-reset.ps1');
  assert.ok(fs.existsSync(p), '缺少 scripts/factory-reset.ps1');
  const buf = fs.readFileSync(p);
  assert.equal(buf[0], 0xef, '必须带 BOM，否则 PowerShell 5.1 解析中文会报错');
  const text = fs.readFileSync(p, 'utf8');
  assert.match(text, /RESET/, '要有二次确认');
  assert.match(text, /backup\\reset-|backup', 'reset-|\\backup\\/, '要备份到 backup\\reset-…');
  assert.match(text, /stop-all\.ps1/, '先停进程再动文件');
  assert.match(text, /\$targets = @\('data', 'config\.json', 'wechatauto_db', 'wechatauto_logs', 'debug\.log'\)/, '要清空这些运行数据');
  assert.match(text, /config\.example\.json/, '要用出厂配置重建 config.json');
  assert.doesNotMatch(text, /'src'|'web'|'runtime'/, '不能删程序本体');
});

test('维护手册写了「重置全部 = 恢复出厂」和备份位置', () => {
  const doc = fs.readFileSync(path.join(root, 'docs', '维护手册.md'), 'utf8');
  assert.match(doc, /重置全部/);
  assert.match(doc, /恢复出厂/);
  assert.match(doc, /backup/);
});
test('版本号工具存在，且 release-check 会拦「重复/跳号/空条目」', () => {
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'bump-version.js')), '缺少 scripts/bump-version.js');
  const bump = fs.readFileSync(path.join(root, 'scripts', 'bump-version.js'), 'utf8');
  assert.match(bump, /--level=/, '支持 patch/minor/major');
  assert.match(bump, /CHANGELOG/, '要写 CHANGELOG');
  const rc = fs.readFileSync(path.join(root, 'scripts', 'release-check.js'), 'utf8');
  assert.match(rc, /CHANGELOG 没有重复版本号/);
  assert.match(rc, /版本号连续（不跳号）/);
  assert.match(rc, /每个版本都有说明内容/);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.bump, 'node scripts/bump-version.js');
});

/**
 * 出包前必须自动扫个人信息。
 * 3.3.0 出包时靠人工扫才发现三处泄漏：BUGS.md 写了真实用户目录、
 * 维护手册把禁用串原文列了出来、出包脚本默认目录写死用户名。
 * 现在做成硬检查，命中就不许出包。
 */
test('发布自检会扫个人信息（密钥 / 真实 wxid / 本机用户名）', () => {
  const rc = fs.readFileSync(path.join(root, 'scripts', 'release-check.js'), 'utf8');
  assert.match(rc, /没有个人信息/, '要有这项检查');
  assert.match(rc, /sk-\[A-Za-z0-9\]\{16,\}/, '密钥要扫');
  assert.match(rc, /wxid_\[a-z0-9\]\{12,\}/, '真实 wxid 要扫');
  assert.match(rc, /process\.env\.USERNAME/, '按本机真实用户名判断，别把所有中文都算泄漏');
  assert.match(rc, /USERPROFILE/, 'USERPROFILE 的目录名也算');
  assert.match(rc, /wxid_\(\.\)\\1\+/, '占位符 wxid_xxxxxxxx 要跳过');
});
