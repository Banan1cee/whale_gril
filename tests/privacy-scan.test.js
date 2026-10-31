'use strict';

/**
 * 隐私扫描的单测：3.x 出过「真实小号目录名进了测试、带 PDB 路径的 exe 进了仓库」，
 * 规则一旦写宽或写窄，要么漏放要么天天误报，所以这里把正反例都钉住。
 *
 * 注意：本文件里的命中样例都在运行时拼出来，不写成字面量 —— 否则这份测试自己就会
 * 被 privacy-scan 扫成泄露（自检会扫 tests/）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanText, scanBinaryBuffer, scan, looksPlanted } = require('../scripts/privacy-scan');

const rulesOf = (findings) => findings.map((f) => f.rule);

const REAL_WXID = 'wxid_' + '3lhy4r4dlcxb12' + '_cea5';
const REAL_GROUP = '45063658812' + '@chatroom';
const PHONE = '1380013' + '8000';

test('真实 wxid 会命中，种占位符不会', () => {
  const account = scanText('account: ' + REAL_WXID);
  assert.ok(rulesOf(account).includes('真实 wxid（账号目录）'), '带后缀的小号目录名要报');

  const bare = scanText('id: ' + 'wxid_' + '3lhy4r4dlcxb12');
  assert.ok(rulesOf(bare).includes('真实 wxid'), '裸 wxid 也要报');

  for (const fake of [
    'wxid_' + 'aaaaaaaaaaaa',
    'wxid_test_master',
    'wxid_aaaa1111_cedb',
    'wxid_bbbb2222_a51e',
    'wxid_status_self',
    'wxid_someone_else',
  ]) {
    assert.deepEqual(scanText('id: ' + fake), [], `${fake} 是测试占位符，不该报`);
    assert.equal(looksPlanted(fake), true);
  }
});

test('群号 / 手机号 / 邮箱 / 密钥 / JWT 会命中，示例值不会', () => {
  assert.ok(rulesOf(scanText('群 ' + REAL_GROUP)).includes('群号'));
  assert.deepEqual(scanText('群 ' + '00000000000' + '@chatroom'), [], '全零占位群号不该报');
  assert.deepEqual(scanText('群 1@chatroom'), []);

  assert.ok(rulesOf(scanText('电话 ' + PHONE)).includes('手机号'));
  assert.deepEqual(scanText('时间戳 1793370600000'), [], '13 位时间戳不是手机号');

  assert.ok(rulesOf(scanText('联系 ' + 'someone' + '@' + 'qq.com')).includes('邮箱'));
  assert.deepEqual(scanText('联系 12345@users.noreply.github.com'), [], 'GitHub noreply 不算');
  assert.deepEqual(scanText('联系 dev@example.com'), [], '示例域名不算');

  assert.ok(rulesOf(scanText('key ' + 'sk-' + 'abcdefghijklmnopqrstuvwx')).includes('密钥'));
  assert.ok(rulesOf(scanText('AKIA' + 'ABCDEFGHIJKLMNOP')).includes('云服务密钥'));
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + 'abcdefghij';
  assert.ok(rulesOf(scanText('token ' + jwt)).includes('JWT'));
});

test('本机用户名路径会命中，别人的路径不会', () => {
  const user = process.env.USERNAME || 'nobody';
  assert.ok(rulesOf(scanText('C:\\Users\\' + user + '\\Documents\\x')).length > 0);
  assert.deepEqual(scanText('C:\\Users\\someoneelse\\x'), [], '别把所有人的路径都算泄露');
});

test('二进制里的调试路径与源码托管链接会被扫出来', () => {
  const dirty = Buffer.from('junk C:\\Users\\21371\\Documents\\proj\\obj\\x.pdb junk');
  assert.ok(rulesOf(scanBinaryBuffer(dirty)).includes('本机用户目录（二进制）'));

  const sourceLink = Buffer.from('{"documents":{"*":"https://raw.github' + 'usercontent.com/o/r/abc/*"}}');
  assert.ok(rulesOf(scanBinaryBuffer(sourceLink)).includes('源码托管链接（二进制）'));

  assert.deepEqual(scanBinaryBuffer(Buffer.from('plain binary, no paths')), []);
});

test('scan() 会跳过 data/runtime/artifacts，但会扫 launcher/publish 的成品', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-scan-'));
  try {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'settings.json'), '{"k":"' + REAL_WXID + '"}');
    fs.mkdirSync(path.join(dir, 'launcher', 'publish'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'launcher', 'publish', 'a.exe'),
      Buffer.from('C:\\Users\\21371\\whale_gril\\launcher\\obj\\x.pdb'));
    // artifacts/ 是审查产物，下面常掖着正在删的临时目录；整棵跳过，不能因 EPERM 崩掉
    fs.mkdirSync(path.join(dir, 'artifacts', 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'artifacts', 'tmp', 'leak.md'), 'id: ' + REAL_WXID);
    fs.writeFileSync(path.join(dir, 'notes.md'), 'ok');

    const { findings, binaries } = scan(dir);
    assert.equal(binaries, 1, 'publish 目录的 exe 要被算进二进制');
    assert.ok(findings.some((f) => f.file === 'launcher/publish/a.exe'), 'exe 的路径要报');
    assert.ok(!findings.some((f) => f.file.startsWith('data/')), 'data/ 是运行时数据，不扫');
    assert.ok(!findings.some((f) => f.file.startsWith('artifacts/')), 'artifacts/ 是审查产物，不扫');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
