'use strict';

const crypto = require('node:crypto');

/**
 * 目录名只允许 [0-9a-f]，避免 Windows 非法字符 / 大小写不敏感 / 路径穿越。
 * 规格：chatHash = sha1(chatId).slice(0, 16)，personHash = sha1(uid).slice(0, 16)。
 */
function sha1Hex(value) {
  return crypto.createHash('sha1').update(String(value), 'utf8').digest('hex');
}

function chatHash(chatId) {
  return sha1Hex(chatId).slice(0, 16);
}

function personHash(uid) {
  return sha1Hex(uid).slice(0, 16);
}

/** 短 id（事件 / 偏好去重用），不是目录名 */
function shortId(value, len = 10) {
  return sha1Hex(value).slice(0, len);
}

module.exports = { sha1Hex, chatHash, personHash, shortId };
