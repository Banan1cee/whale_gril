'use strict';

/**
 * 联系人缓存。
 *
 * 微信的 wxid 只能从微信自己的库里读，Node 这边读不到；桥接（Python）有权限，
 * 所以由桥接定期把「联系人 + 群」的精简清单推上来，这里落一份缓存，
 * 给启动器的选择器（白名单 / 黑名单）和 care 的目标解析用。
 *
 * 只是一份缓存：读不到就是空的，不报错、不影响聊天。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_ITEMS = 5000;

function clean(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

/** 一条联系人记录只保留这几样，别把头像、备注原文之外的东西全塞进来 */
function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const wxid = clean(item.wxid || item.username, 120);
  if (!wxid) return null;
  const isGroup = item.isGroup === true || /@chatroom$/i.test(wxid);
  const name = clean(item.name || item.nick_name || item.nickName || wxid, 80);
  const remark = clean(item.remark, 80);
  return {
    wxid,
    name: name || wxid,
    remark,
    isGroup,
    // 显示用：有备注先显示备注
    label: remark || name || wxid,
  };
}

class ContactsCache {
  constructor(config, { logger = null } = {}) {
    this.config = config;
    this.logger = logger;
    this.file = config && config.paths && config.paths.dataDir
      ? path.join(config.paths.dataDir, 'contacts-cache.json')
      : '';
    this.account = '';
    this.updatedAt = 0;
    this.items = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')) || {};
      this.account = clean(raw.account, 120);
      this.updatedAt = Number(raw.updatedAt) || 0;
      this.items = Array.isArray(raw.items) ? raw.items.map(normalizeItem).filter(Boolean) : [];
    } catch {
      this.items = [];
    }
    return this;
  }

  save() {
    if (!this.file) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const body = JSON.stringify({ account: this.account, updatedAt: this.updatedAt, items: this.items });
      // 原子写：写临时文件再改名，免得半截文件把缓存读坏
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, body, 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      if (this.logger) this.logger.warn('联系人缓存写入失败：' + err.message);
      return false;
    }
  }

  /** 桥接推上来的整份清单（覆盖写） */
  sync({ account = '', items = [], at = 0 } = {}) {
    const list = (Array.isArray(items) ? items : []).map(normalizeItem).filter(Boolean);
    const seen = new Set();
    const deduped = [];
    for (const item of list) {
      if (seen.has(item.wxid)) continue;
      seen.add(item.wxid);
      deduped.push(item);
      if (deduped.length >= MAX_ITEMS) break;
    }
    this.account = clean(account, 120);
    this.updatedAt = Number(at) || Date.now();
    this.items = deduped;
    this.save();
    return { count: deduped.length, updatedAt: this.updatedAt, account: this.account };
  }

  get(wxid) {
    const id = clean(wxid, 120);
    if (!id || !id.length) return null;
    return this.items.find((item) => item.wxid === id) || null;
  }

  /** 按 wxid / 名字 / 备注匹配（大小写不敏感）；空 q 返回全部 */
  search(q = '', { type = 'all' } = {}) {
    const key = clean(q, 40).toLowerCase();
    let list = this.items;
    if (type === 'user') list = list.filter((item) => !item.isGroup);
    else if (type === 'group') list = list.filter((item) => item.isGroup);
    if (key) {
      list = list.filter((item) => item.wxid.toLowerCase().includes(key)
        || item.name.toLowerCase().includes(key)
        || item.remark.toLowerCase().includes(key));
    }
    return list;
  }

  /** 给选择器用的返回体 */
  payload({ q = '', type = 'all' } = {}) {
    return {
      ok: true,
      account: this.account,
      updatedAt: this.updatedAt,
      total: this.items.length,
      items: this.search(q, { type }),
    };
  }
}

module.exports = { ContactsCache, normalizeItem, MAX_ITEMS };
