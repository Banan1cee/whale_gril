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
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // 有些目录（比如别的工具留下的临时目录）会带奇怪的 ACL，读不进去就跳过，
    // 脚本规范检查不该因为一个读不了的路人目录整体失败。
    return out;
  }
  for (const name of entries) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) {
      // runtime 是「一键装运行环境」下载的运行时（node/python），不归我们管：
      // 里面的目录可能带各种 ACL，扫进去只会报 EPERM。
      if (['node_modules', 'release', 'data', 'vendor', 'runtime'].includes(name.name)) continue;
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

test('stop-all.ps1 会写暂停标记，并覆盖服务/桥接/守护', () => {
  const ps1 = fs.readFileSync(path.join(root, 'scripts', 'stop-all.ps1'), 'utf8');
  assert.match(ps1, /PAUSED/, '必须写 data\\PAUSED，否则 bridge_loop 会重新拉起桥接');
  assert.match(ps1, /wechatauto_bridge\.py/);
  assert.match(ps1, /server\.js/);
  assert.match(ps1, /bridge_loop\.bat/);
  assert.doesNotMatch(ps1, /hotkey_daemon/, '热键功能已下线，不该再出现');
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
  const bridge = fs.readFileSync(path.join(root, 'bridge', 'engine.py'), 'utf8');
  assert.match(bridge, /def bridge_heartbeat/);
  assert.match(bridge, /\/api\/bridge\/heartbeat/);
  assert.match(bridge, /UIA_CACHE\.get\("u"\)/);
  assert.match(bridge, /"rest": resting/, 'rest 字段还要继续上报（前端在读）');
  assert.match(bridge, /resting = False/, '休息模式已删除，字段保留但恒为 false');
  assert.doesNotMatch(bridge, /def game_running\(/, '「打游戏就休息」已删除');
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

test('引用回复默认关闭（开着的话每条要多走一遍 UI，回复明显变慢）', () => {
  const bridge = fs.readFileSync(path.join(root, 'bridge', 'engine.py'), 'utf8');
  assert.match(bridge, /QUOTE_REPLY = bool\(_wechat\.get\("quoteReply", False\)\)/, '启动读配置时默认必须是 False');
  assert.match(bridge, /QUOTE_REPLY = bool\(w\.get\("quoteReply", False\)\)/, '热重载时默认也必须是 False');
  assert.doesNotMatch(bridge, /get\("quoteReply", True\)/, '不能有人再写回 True');
  const example = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(example.wechat.quoteReply, false, 'config.example 里也应该是 false');
});

test('桥接启动失败要区分「缺 VC++ 运行库」和「缺 pip 包」', () => {
  const bridge = fs.readFileSync(path.join(root, 'bridge', 'engine.py'), 'utf8');
  assert.match(bridge, /_dll_issue/, '要有 DLL 判定');
  assert.match(bridge, /vc_redist/, '缺 DLL 时要引导装 VC++ 运行库');
  assert.match(bridge, /Windows Server 默认不装 MFC/, '要点明 Server 的情况');
});

test('打开微信数据库要有超时，不能一直卡着不监听', () => {
  const bridge = fs.readFileSync(path.join(root, 'bridge', 'engine.py'), 'utf8');
  assert.match(bridge, /_open_db_with_timeout/, 'DB 初始化要包超时');
  assert.match(bridge, /卡住超过 90 秒/, '超时要明确告诉用户');
});

test('桥接起来后写就绪文件（用来判断「起来了但没监听」）', () => {
  const bridge = fs.readFileSync(path.join(root, 'bridge', 'engine.py'), 'utf8');
  assert.match(bridge, /bridge-ready\.json/);
});

test('守护循环有重启上限，不会无限 3 秒重启刷屏', () => {
  const loop = fs.readFileSync(path.join(root, 'scripts', 'bridge_loop.bat'), 'utf8');
  assert.match(loop, /FAILS/);
  assert.match(loop, /GEQ 4/, '连续 4 次失败就停下来');
  assert.match(loop, /bridge-ready\.json/, '每次启动前清掉就绪标记');
});

test('发行包自带 ffmpeg（微信 4.x 图片是 wxHEVC，没它看不了图）', () => {
  const probe = path.join(root, 'runtime', 'ffmpeg', 'bin', 'ffmpeg.exe');
  if (!fs.existsSync(probe)) {
    // 源码树没有 runtime，跳过（发行包才带）
    return;
  }
  assert.ok(fs.statSync(probe).size > 10 * 1024 * 1024, 'ffmpeg.exe 应该是完整二进制');
});

test('热键文件已删除，README 不再提热键', () => {
  assert.equal(fs.existsSync(path.join(root, '启动热键.bat')), false, '启动热键.bat 应删除');
  assert.equal(fs.existsSync(path.join(root, 'tools', 'hotkey_daemon.py')), false, 'hotkey_daemon.py 应删除');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /启动热键\.bat|hotkey_daemon/, 'README 不该再提热键');
});

test('新增「先点启动鲸鱼娘再点启动桥接」文件夹，两个启动器按顺序编号', () => {
  const dir = path.join(root, '先点启动鲸鱼娘再点启动桥接');
  assert.ok(fs.existsSync(dir), '文件夹要存在');
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.bat')).sort();
  assert.equal(files.length, 2, '里面只放两个启动器');
  assert.match(files[0], /^1 /, '第一个是第 1 步');
  assert.match(files[1], /^2 /, '第二个是第 2 步');
  assert.match(fs.readFileSync(path.join(dir, files[0]), 'utf8'), /启动鲸鱼娘\.bat/);
  assert.match(fs.readFileSync(path.join(dir, files[1]), 'utf8'), /启动微信桥接\.bat/);
});

test('服务把实际端口写盘，桥接优先读（换端口不至于满屏积极拒绝）', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /server-port\.txt/, '服务要写实际端口');
  const bridge = fs.readFileSync(path.join(root, 'bridge', 'engine.py'), 'utf8');
  assert.match(bridge, /server-port\.txt/, '桥接要优先读它');
});

test('桥接启动前等服务就绪，连接中断要节流并给明确提示', () => {
  const bridge = fs.readFileSync(path.join(root, 'bridge', 'engine.py'), 'utf8');
  assert.match(bridge, /def wait_for_server/, '要有等待服务就绪');
  assert.match(bridge, /wait_for_server\(bot_url/, '监听前要调用');
  assert.match(bridge, /conn-refused/, '积极拒绝要走节流');
  assert.match(bridge, /先双击「启动鲸鱼娘\.bat」/, '要告诉用户先点服务');
  assert.match(bridge, /已连上鲸鲸服务/, '恢复连接时打一条');
});
