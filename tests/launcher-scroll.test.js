'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'launcher', name), 'utf8');

test('会话刷新独立于探测和主动状态请求，页面卸载停止且禁止并发请求', () => {
  const src = read('Views/StatusPage.xaml.cs');
  assert.match(src, /_recentTimer = .*DispatcherTimer.*TimeSpan.FromSeconds\(1\)/);
  assert.match(src, /_recentTimer.Tick.*PollRecentAsync/);
  assert.match(src, /Unloaded.*_recentTimer.Stop/);
  assert.match(src, /if \(_recentBusy \|\| !IsLoaded\) return/);
  assert.match(src, /finally \{ _recentBusy = false; \}/);
  assert.doesNotMatch(src, /TotalSeconds >= 5/);
  assert.match(src, /json == _recentJson/);
  const catchBody = src.slice(src.indexOf('// /api/recent'));
  assert.doesNotMatch(catchBody, /Recent.ItemsSource = null/);
});

test('三个列表共用像素缓动，自动跟随使用布局后的同一滚动实现', () => {
  const smooth = read('SmoothScroll.cs');
  assert.match(smooth, /VirtualizingPanel.SetScrollUnit\(list, ScrollUnit.Pixel\)/);
  assert.match(smooth, /SystemParameters.ClientAreaAnimation/);
  assert.match(smooth, /DispatcherPriority.Loaded/);
  assert.match(smooth, /Math.Max\(0, Math.Min\(viewer.ScrollableHeight, target\)\)/);
  for (const [file, control] of [['BridgePage', 'Console'], ['DiagPage', 'Logs'], ['StatusPage', 'Recent']]) {
    assert.ok(read('Views/' + file + '.xaml.cs').includes('SmoothScroll.Attach(' + control + ')'));
  }
  assert.match(read('Views/DiagPage.xaml.cs'), /SmoothScroll.AtEnd\(Logs\)/);
  assert.doesNotMatch(read('Views/BridgePage.xaml.cs'), /Console.ScrollIntoView/);
});
