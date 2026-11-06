'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { releaseNotes } = require('../scripts/release-notes');

test('更新说明只来自指定版本，不混入未发布或其他版本', () => {
  const changelog = '# 更新记录\n\n## 未发布\n\n尚未发布\n\n## 4.0.6\n\n### 修复\n\n- 修复编码切换。\n- 支持私聊记忆清理。\n\n## 4.0.5\n\n旧版内容\n';
  const notes = releaseNotes(changelog, 'v4.0.6');
  assert.match(notes, /修复编码切换/);
  assert.match(notes, /私聊记忆清理/);
  assert.doesNotMatch(notes, /尚未发布|旧版内容/);
});

test('最后一个版本支持 CRLF 和没有结尾换行；缺失版本不能伪造说明', () => {
  assert.equal(releaseNotes('## 4.0.5\r\n\r\n- 修复安装问题。', '4.0.5'), '- 修复安装问题。');
  assert.throws(() => releaseNotes('## 4.0.5\n\n- 旧版本', '4.0.6'), /没有找到/);
});
