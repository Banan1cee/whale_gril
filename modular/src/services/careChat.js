'use strict';

const care = require('./care');

/**
 * 主动搭话的内容：问她一句「在干啥 / 累不累」。
 * 演示模式（没 Key）直接用内置台词，省得等模型；有 Key 就带着最近聊天生成，避免每次同一句。
 */
async function careForChat(runtime, chatId) {
  const personaCfg = runtime.config.persona || {};
  const name = String(personaCfg.ownerName || '主人');
  const hour = new Date().getHours();
  let recent = [];
  if (chatId) {
    // 会话 key 可能是私聊（wechat:u:<id>）也可能是群（wechat:g:<id>），两边都试
    for (const key of [`wechat:u:${chatId}`, `wechat:g:${chatId}`, chatId]) {
      try {
        const msgs = runtime.store.messages(key, 12) || [];
        if (msgs.length) {
          recent = msgs
            .filter((m) => m && m.text)
            .map((m) => `${m.role === 'user' ? '对方' : (personaCfg.name || '我')}：${String(m.text).slice(0, 60)}`);
          break;
        }
      } catch {
        recent = [];
      }
    }
  }
  if (runtime.llm.isMock) {
    return { ok: true, text: care.pickTemplate(), mock: true, hour };
  }
  try {
    const { system, user } = care.buildCarePrompt({ persona: personaCfg, recent, name, hour });
    const raw = await runtime.llm.complete({ system, turns: [{ role: 'user', content: user }] });
    const text = care.cleanCareText(raw) || care.pickTemplate();
    return { ok: true, text, mock: false, hour };
  } catch (err) {
    runtime.logger.warn('搭话模型失败，用内置台词：' + (err && err.message));
    return { ok: true, text: care.pickTemplate(), mock: true, fallback: true, hour };
  }
}

module.exports = { careForChat };
