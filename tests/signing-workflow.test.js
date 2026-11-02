'use strict';

/**
 * 签名流水线契约测试。
 *
 * 钉住几件「改错就会悄悄发未签名包」的事：
 *   1. 启动器必须先签、后编译安装包（顺序反了，包里嵌的就是未签名 exe，而且看不出来）
 *   2. SignPath 的上传/取件必须成对：upload-artifact 的 archive: false
 *      对应 signpath step 的 skip-decompress: true
 *   3. 配了 SIGNING_MODE 就必须硬检查签名状态，不能只是打个摘要
 *   4. 两份 artifact configuration 的根元素是 <pe-file>（裸 exe），不是 <zip-file>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const wf = fs.readFileSync(path.join(root, '.github/workflows/installer.yml'), 'utf8');
const idx = (s) => wf.indexOf(s);

test('签名方式由仓库变量 SIGNING_MODE 切换，不配就走 PFX 老路', () => {
  assert.match(wf, /SIGNING_MODE: \$\{\{ vars\.SIGNING_MODE \}\}/, 'workflow 没读 vars.SIGNING_MODE');
  assert.ok(idx("if: env.SIGNING_MODE == 'signpath'") > 0, '没有 signpath 分支');
  assert.ok(idx("if: env.SIGNING_MODE != 'signpath'") > 0, 'PFX 分支没做互斥');
});

test('启动器先签、后编译安装包', () => {
  const signLauncher = idx('签启动器（SignPath）');
  const swapLauncher = idx('换上签好名的启动器');
  const compile = idx('- name: 编译安装包');
  const signSetup = idx('签安装包（SignPath）');
  assert.ok(signLauncher > 0 && swapLauncher > 0 && compile > 0 && signSetup > 0, '签名/编译步骤缺了');
  assert.ok(signLauncher < compile, '签名必须在编译安装包之前');
  assert.ok(swapLauncher < compile, '签好的启动器要在编译前放回 launcher\\publish');
  assert.ok(compile < signSetup, '安装包要在编译之后再签');
});

test('SignPath 上传/取件参数成对，且两轮签的都校验状态', () => {
  // 裸 exe（不走 zip）→ 取件时也要 skip-decompress
  const uploads = [...wf.matchAll(/archive: false/g)].length;
  const skips = [...wf.matchAll(/skip-decompress: true/g)].length;
  assert.equal(uploads, 2, '应该有两处 archive: false（启动器 + 安装包）');
  assert.equal(skips, 2, '应该有两处 skip-decompress: true');

  assert.match(wf, /artifact-configuration-slug: whale-launcher/);
  assert.match(wf, /artifact-configuration-slug: whale-setup/);
  assert.match(wf, /signing-policy-slug: \$\{\{ github\.ref_type == 'tag' && 'release-signing' \|\| 'test-signing' \}\}/,
    'tag 用发版策略、其它用测试策略');
  assert.equal((wf.match(/if \(\$sig\.Status -ne 'Valid'\)/g) || []).length >= 2, true,
    '两轮签名都要回读校验，不能只看文件在不在');
});

test('配了 SIGNING_MODE 却签不上时，摘要那步直接失败', () => {
  const summary = wf.slice(idx('产物摘要与校验值'));
  assert.match(summary, /if \(\$env:SIGNING_MODE -and \$sig\.Status -ne 'Valid'\)/, '安装包签名没做硬检查');
  assert.match(summary, /if \(\$env:SIGNING_MODE -and \$launcherSig\.Status -ne 'Valid'\)/, '启动器签名没做硬检查');
  assert.match(summary, /::error title=签名没生效::/, '失败时要出 ::error');
});

test('两轮签名都要读本次运行的 artifact（不允许本地签名顶上）', () => {
  assert.match(wf, /github-artifact-id: \$\{\{ steps\.upload-unsigned-launcher\.outputs\.artifact-id \}\}/);
  assert.match(wf, /github-artifact-id: \$\{\{ steps\.upload-unsigned-setup\.outputs\.artifact-id \}\}/);
  assert.match(wf, /permissions:\n  contents: write\n  # SignPath 那步要读本次运行的 artifact 和 job 信息\n  actions: read/,
    '缺 actions: read 权限，SignPath 那步读不到 artifact');
});

test('artifact configuration 的根是 <pe-file>，和裸 exe 上传一致', () => {
  const dir = path.join(root, '.github/signpath');
  for (const [file, pattern] of [
    ['whale-launcher.xml', /<pe-file path="WhaleLauncher\.exe">\s*<authenticode-sign \/>/],
    ['whale-setup.xml', /<pe-file path="whale-girl-\*-setup\.exe">\s*<authenticode-sign \/>/],
  ]) {
    const full = path.join(dir, file);
    assert.ok(fs.existsSync(full), `缺少 ${file}`);
    const xml = fs.readFileSync(full, 'utf8');
    assert.match(xml, /xmlns="http:\/\/signpath\.io\/artifact-configuration\/v1"/, `${file} 命名空间不对`);
    assert.match(xml, pattern, `${file} 里 pe-file 路径没对上`);
    assert.doesNotMatch(xml, /<zip-file/, `${file} 是裸 exe，不能写 zip-file`);
  }
});

test('文档写清了要配哪个 secret 和哪些变量', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/打包与签名.md'), 'utf8');
  for (const key of ['SIGNPATH_API_TOKEN', 'SIGNPATH_ORG_ID', 'SIGNPATH_PROJECT_SLUG', 'SIGNING_MODE']) {
    assert.ok(doc.includes(key), `文档没提 ${key}`);
  }
  assert.match(doc, /signpath\.org/, '文档要给 SignPath Foundation 的申请入口');
});

test('仓库里不留自签名/本机签名工具：对外只认公开受信任的签名', () => {
  // 自签名只对导入过证书的那台机器有效，别人下载照样是「未知发布者」。
  // 留着它只会让人误以为包「已经签好了」，所以工具和文档入口都不要。
  for (const rel of ['一键签名.bat', 'scripts/make-dev-cert.ps1', 'scripts/sign-local.ps1', 'scripts/sign-one-click.ps1']) {
    assert.equal(fs.existsSync(path.join(root, rel)), false, `${rel} 不该再存在（自签名对分发没意义）`);
  }
  const doc = fs.readFileSync(path.join(root, 'docs/打包与签名.md'), 'utf8');
  assert.doesNotMatch(doc, /一键签名|make-dev-cert|sign-local/, '文档不该再教怎么自签名');
});

test('安装烟测不把「随包 .NET 安装包被安装器删掉」当成缺文件', () => {
  // 本机已有 .NET 10 桌面运行时的时候，installer 会删掉那个 57MB 的安装包（设计如此）。
  // runner 上装了 .NET 10 SDK，所以这一步几乎每次都会删 —— 烟测必须区分
  // 「被删了」和「压根没进包」，否则流水线每次都红。
  const expectBlock = wf.slice(wf.indexOf('$expect = @('), wf.indexOf('$missing = $expect'));
  assert.doesNotMatch(expectBlock, /windowsdesktop-runtime-10-win-x64\.exe/,
    '随包 .NET 安装包不能再放在必检清单里（它会被安装器删掉）');
  assert.match(wf, /\$dotnetInstaller = Join-Path \$dir 'runtime\\dotnet\\windowsdesktop-runtime-10-win-x64\.exe'/,
    '要单独检查随包 .NET 安装包');
  assert.match(wf, /Microsoft\.WindowsDesktop\.App/, '缺文件时要看本机有没有 .NET 10 桌面运行时');
  assert.match(wf, /压根没进包/, '两种情况要分开报错');

  const doc = fs.readFileSync(path.join(root, 'docs/打包与签名.md'), 'utf8');
  assert.match(doc, /被安装器删掉/, '文档要写成「在，或者被删且本机已有运行时」');
});
