'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const manifest = require('../scripts/vb-cable-pack45.json');
test('Pack45 pins all 31 official files, including the eight catalog signatures', () => {
  assert.equal(Object.keys(manifest).length, 31);
  assert.equal(Object.keys(manifest).filter(n => n.endsWith('.cat')).length, 8);
  assert.ok(manifest['vbaudio_cable64_win10.cat']);
  for (const hash of Object.values(manifest)) assert.match(hash, /^[0-9a-f]{64}$/);
  const iss = fs.readFileSync(path.join(root, 'installer/whale.iss'), 'utf8');
  assert.ok(!/Excludes:[^\r\n]*\*\.cat/i.test(iss));
  const fetch = fs.readFileSync(path.join(root, 'scripts/fetch-vb-cable.ps1'), 'utf8');
  assert.ok(fetch.includes('Get-VbCablePackageProblems $directory'));
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/installer.yml'), 'utf8');
  assert.equal((workflow.match(/Assert-VbCablePackage \(Join-Path \$dir 'VB-CABLE虚拟声卡'\)/g) || []).length, 2);
});
test('package validator rejects missing CATs, corrupt files and the exact user-reported missing Win10 catalog', t => {
  const executable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  if (spawnSync(executable, ['-NoProfile', '-Command', 'exit 0']).error?.code === 'ENOENT') return t.skip('PowerShell unavailable');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-cable-check-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const expected = {};
  for (const name of Object.keys(manifest)) {
    const bytes = Buffer.from('fixture for ' + name);
    fs.writeFileSync(path.join(fixture, name), bytes);
    expected[name] = crypto.createHash('sha256').update(bytes).digest('hex');
  }
  fs.writeFileSync(path.join(fixture, 'expected.json'), JSON.stringify(expected));
  // Paths are passed as environment values, never interpolated into PowerShell source.
  const check = () => {
    const result = spawnSync(executable, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      '. $env:VB_CHECK_SCRIPT; $items=@(Get-VbCablePackageProblems $env:VB_CHECK_DIR $env:VB_CHECK_MANIFEST); ConvertTo-Json -InputObject $items -Compress'], {
      env: { ...process.env, VB_CHECK_SCRIPT: path.join(root, 'scripts/vb-cable-package.ps1'), VB_CHECK_DIR: fixture, VB_CHECK_MANIFEST: path.join(fixture, 'expected.json') }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  };
  assert.deepEqual(check(), []);
  const name = 'vbaudio_cable64_win10.cat';
  fs.unlinkSync(path.join(fixture, name));
  assert.deepEqual(check(), ['Missing: ' + name]);
  fs.writeFileSync(path.join(fixture, name), 'damaged');
  assert.deepEqual(check(), ['Modified: ' + name], 'Corrupt catalog fixture hash: ' + crypto.createHash('sha256').update(fs.readFileSync(path.join(fixture,name))).digest('hex') + '; expected: ' + expected[name]);
  for (const n of Object.keys(manifest).filter(n => n.endsWith('.cat'))) fs.unlinkSync(path.join(fixture, n));
  assert.equal(check().length, 8);
});
