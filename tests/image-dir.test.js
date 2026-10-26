'use strict';

/**
 * 「图片识别只认默认微信文件地址，改了就不行」的回归测试。
 *
 * 根因：微信改「文件保存位置」后，数据库（db_storage）会搬到新目录、账号目录名还会
 * 换一个新的哈希后缀；但 msg/attach 里的图片缓存不保证跟着搬。于是消息照常收发、
 * 图片却永远找不到——因为 wechatauto 把图片路径写死在 db.account_dir 下。
 *
 * 修法：examples/media_fallback.py 给 MediaDownloader 打一层只读兜底，当前账号目录
 * 找不到时按「会话 md5 + 图片 md5」去其它账号目录/其它盘找，并给密钥反推的
 * 探针/模板接上同样的兜底。桥接 _get_media() 创建下载器时自动装。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const fallback = fs.readFileSync(path.join(root, 'examples', 'media_fallback.py'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'examples', 'wechatauto_bridge.py'), 'utf8');

test('兜底模块存在，且会替换「找图片 / 密钥探针 / 模板」三处', () => {
  assert.match(fallback, /def install_media_fallback/);
  assert.match(fallback, /def attach_dirs/);
  assert.match(fallback, /def data_roots/);
  // 三处补丁
  assert.match(fallback, /dl\._image_files = image_files/);
  assert.match(fallback, /dl\._probe_ct = probe_ct/);
  assert.match(fallback, /dl\._collect_templates = collect_templates/);
});

test('兜底会搜其它账号目录和其它盘，而不只看当前账号目录', () => {
  // 当前账号目录 + 数据根下其它账号目录
  assert.match(fallback, /account_dir.*msg.*attach/, '当前账号目录要排第一');
  assert.match(fallback, /os\.listdir\(root\)/, '要枚举数据根下的其它账号目录');
  // 其它盘
  assert.match(fallback, /xwechat_files/, '要认识 xwechat_files');
  assert.match(fallback, /WeChat Files/);
  assert.match(fallback, /xwechat_files_data/);
  // 只读：绝不移动/删除微信文件
  assert.match(fallback, /只读/, '要写清只读，不能动微信目录');
});

test('桥接 _get_media() 会装上兜底，并打印「已就位」日志', () => {
  assert.match(bridge, /from media_fallback import install_media_fallback/);
  assert.match(bridge, /install_media_fallback\(\s*dl, db/);
  assert.match(bridge, /图片目录兜底已就位/, '装上了要有日志，出问题才好排查');
  assert.match(bridge, /图片目录兜底没装上/, '装不上也要记日志，但不能影响默认路径');
});

test('兜底逻辑自检能跑通（需要包内 Python；没有就跳过）', () => {
  const py = path.join(root, 'runtime', 'python', 'python.exe');
  if (!fs.existsSync(py)) {
    return; // 没有包内 Python（纯源码环境），跳过
  }
  const out = execFileSync(py, ['-u', path.join(root, 'examples', 'media_fallback.py'), '--selftest'], {
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.match(out, /SELFTEST OK/, '自检要输出 SELFTEST OK，实际：' + out);
});
