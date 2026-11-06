'use strict';

const fs = require('node:fs');
const path = require('node:path');

function releaseNotes(changelog, version) {
  const escaped = String(version).replace(/^v/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(changelog).match(new RegExp('^##\\s+v?' + escaped + '\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))', 'm'));
  if (!match || !match[1].trim()) throw new Error('没有找到该版本的更新说明');
  return match[1].trim();
}

if (require.main === module) {
  try { process.stdout.write(releaseNotes(fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'), process.argv[2] || '') + '\n'); }
  catch (err) { console.error(err.message); process.exitCode = 1; }
}

module.exports = { releaseNotes };
