'use strict';

const fs = require('node:fs');
const path = require('node:path');
const stickers = require('../adapters/stickers');

function run(root, action, key) {
  const file = path.join(root, 'config.json');
  let config = { root };
  try {
    config = { ...JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')), root };
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error('无法读取 config.json');
  }
  const dir = stickers.stickerDir(config, root);
  const categories = Object.entries(stickers.EMOTIONS).map(([key, label]) => ({ key, label }));
  for (const { label } of stickers.readExtraCategories(config, root)) {
    categories.push({ key: stickers.extraKey(label), label });
  }
  if (action === 'open') {
    const selected = categories.find(category => category.key === key);
    if (!selected) throw new Error('请先选择一个有效分类');
    return { ok: true, dir: stickers.safeDirectory(path.join(dir, selected.label)) };
  }
  if (action !== 'inventory') throw new Error('未知的图库操作');
  const emotions = categories.map(category => {
    const items = stickers.categoryImages(dir, category.key).flatMap(file => {
      try {
        return [{ id: path.relative(dir, file).split(path.sep).join('/'),
          path: file, version: fs.statSync(file).mtimeMs }];
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    });
    return { ...category, items, count: items.length };
  });
  return { ok: true, dir, emotions, enabled: stickers.isOn(config),
    configuredDir: config.sticker?.dir || '', testChat: config.sticker?.testChat || '文件传输助手' };
}

if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(run(path.resolve(__dirname, '../..'), process.argv[2], process.argv[3])));
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
    process.exitCode = 1;
  }
}

module.exports = { run };
