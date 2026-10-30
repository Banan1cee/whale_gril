'use strict';

const features = require('../infra/features');
const { clampInt } = require('./text');

/**
 * 触发判断：这条群消息到底要不要接。
 * 纯逻辑 + 对 state 的少量写入（静默期/接话窗口），不调用模型、不写记忆。
 */

/** 明确的骂人词：出现就算开战 */
const INSULT_RE = /傻逼|傻比|煞笔|脑残|智障|弱智|废物|垃圾|狗东西|贱人|婊子|你妈|他妈|操你|草你|去死|滚蛋|滚开|滚|孤儿|低能|神经病|有病|恶心|丑逼|蠢|菜狗|臭机器人|破机器人|人工智障|没素质|素质低|下头|欠揍|挑衅|算什么东西|不要脸/;
/** 弱一点的贬义：配合「你/机器人」也算骂她 */
const INSULT_LOOSE_RE = /臭|破|烂|没用|闭嘴|烦人|装什么|什么玩意儿/;

/**
 * 这条消息有没有在叫她。
 * 「机器人」不再裸算：必须带指代（这个/那个/你/破/臭/傻/烂/死），
 * 否则群里聊「这破机器人又卡了」会被误判成骂她。
 */
function namedHerIn(text) {
  const s = String(text || '');
  if (/(鲸鲸|小鲸|肥鱼)/.test(s)) return true;
  return /(这个|那个|你|破|臭|傻|烂|死)\s*机器人/.test(s);
}

/**
 * @param {object} bot  需要 bot.config / bot.store / bot.rng
 * @param {{msg:object, atMe:boolean, clean:{text:string}, isGroup:boolean, state:object, nowMs:number, isMaster:boolean, key:string}} args
 */
function computeTrigger(bot, { msg, atMe, clean, isGroup, state, nowMs, isMaster, key }) {
  if (!isGroup) return { wake: true, reason: 'private' };
  const addressed = atMe || msg.replyToBot;
  // 只要有人 @ 她（或回复她），一律回复，静默期也解除
  if (addressed) {
    state.silentUntil = 0;
    // 被叫到之后开一个接话窗口，同一人接着问不用再 @
    const mins = Math.max(1, Number(bot.config.group.engagedMinutes) || 6);
    state.engagedUntil = nowMs + mins * 60000;
    state.engagedBy = String(msg.senderId || '');
    return { wake: true, reason: 'addressed' };
  }
  // 任何人单发一个问号，她也回一个问号
  if (/^[?？]+$/.test(String(clean.text || '').trim())) {
    return { wake: true, reason: 'question_mark' };
  }
  // 没 @ 但明显是在叫她说话：「来给大家说句话」「开麦」「跟大家聊聊」
  if (/(来(给|和)?(大家|群里|群友)?说|跟大家(说|聊)|开麦|说句话|出来说|你说两句)/.test(clean.text || '')) {
    state.silentUntil = 0;
    const mins = Math.max(1, Number(bot.config.group.engagedMinutes) || 6);
    state.engagedUntil = nowMs + mins * 60000;
    state.engagedBy = String(msg.senderId || '');
    return { wake: true, reason: 'directed' };
  }
  // 被赶走后的静默期：高于「主人说话就回」，否则主人说完「让她滚」下一句又把她叫起来。
  // @ 她仍然能解除（上面 addressed 分支），所以不是永久失联。
  if (Number(state.silentUntil) > nowMs) {
    return { wake: false, reason: 'silent' };
  }
  if (isMaster && bot.config.group.masterAlwaysReply) return { wake: true, reason: 'master' };
  if (Number(state.engagedUntil) > nowMs) {
    const txt = String(clean.text || '');
    const sameSender = String(msg.senderId || '') === String(state.engagedBy || '');
    const question = /[?？]|吗|呢|怎么|为什么|啥|多少|几点|谁|哪|是不是|能不能|要不要/.test(txt);
    if (sameSender && (question || txt.length <= 30)) return { wake: true, reason: 'engaged' };
    // 别人也在接这个话题：她刚说过话、对方又用「你」冲她说，就不算旁人闲聊
    const justSpoke = Number(state.lastReplyAt) && nowMs - Number(state.lastReplyAt) < 90 * 1000;
    const toHer = /你|你们|咱|鲸鲸|小鲸|肥鱼/.test(txt);
    // L1：以前「她 90 秒内说过话 + 有人发『你…』」就唤醒，别人聊自己的事也会被插嘴。
    // 现在只有开了 groupAddressGuard 才保留，且本条不能在跟别人说话。
    const guardOn = features.isOn(bot.config, 'groupAddressGuard');
    const others = Array.isArray(msg.mentionedNames) ? msg.mentionedNames.filter(Boolean) : [];
    const talkingToOthers = others.length > 0 || (/(他|她|楼上|那谁|某人)/.test(txt) && !/你|你们/.test(txt));
    if (!guardOn && justSpoke && toHer && txt.length <= 60) return { wake: true, reason: 'engaged_group' };
    if (guardOn && justSpoke && namedHerIn(txt) && !talkingToOthers && txt.length <= 60) {
      return { wake: true, reason: 'engaged_group' };
    }
    return { wake: false, reason: 'engaged_side_chatter' };
  }
  // 她刚在群里说过话（3 分钟内），紧接着有人用「你」冲她说话 → 也算在跟她说
  const lastBotAt = Number(state.lastReplyAt) || 0;
  const txtNow = String(clean.text || '');
  if (lastBotAt && nowMs - lastBotAt < 3 * 60000 && /你|你们|鲸鲸|小鲸|肥鱼/.test(txtNow) && txtNow.length <= 60) {
    return { wake: true, reason: 'followup' };
  }

  const g = bot.config.group;
  const cooldownMs = (Number(g.cooldownSec) || 0) * 1000;
  const tooSoon = Number(state.lastReplyAt) + cooldownMs > nowMs;
  // 每小时回复上限：这个配置以前只在配置文件和状态接口里出现，
  // 代码里根本没读，等于摆设。现在真的按「最近一小时回了几条」拦。
  const cap = Number(g.maxRepliesPerHour);
  if (cap > 0) {
    const hourAgo = nowMs - 3600 * 1000;
    const times = Array.isArray(state.replyTimes) ? state.replyTimes : [];
    let recent = 0;
    for (const t of times) if (Number(t) > hourAgo) recent += 1;
    // state.replyTimes 在会话状态被重建时会丢条目（并发下实测会漏拦），
    // 所以再数一遍存储里真正落盘的助手消息 —— 那才是权威来源。
    try {
      const stored = bot.store
        .messages(key, 200)
        .filter((m) => m.role === 'assistant' && Number(m.ts) > hourAgo).length;
      if (stored > recent) recent = stored;
    } catch { /* 读不到就按内存里的算 */ }
    if (!recent && Number(state.lastReplyAt) > hourAgo) recent = 1;
    if (recent >= cap) return { wake: false, reason: 'hourly_cap' };
  }
  // 没点名她的时候有两种放行方式，都受同一个「插话概率」控制：
  //   1. 「允许她自己插话」开着 → 按概率抽一句；
  //   2. 「必须 @ 她才回」关掉 → 也是按概率抽，不是每条都回。
  // 以前 case 2 直接 return wake:true，等于让概率设置完全失效（用户以为没保存）。
  const interjectChance = clampInt(Number(g.freeChatChance) * 1000, 0, 1000, 60) / 1000;
  const interject = !tooSoon && interjectChance > 0 && bot.rng() < interjectChance;
  if (g.requireAt === false) {
    return interject ? { wake: true, reason: 'free_chat' } : { wake: false, reason: 'not_addressed' };
  }
  if (g.freeChat && interject) return { wake: true, reason: 'free_chat' };
  return { wake: false, reason: clean.text ? 'not_addressed' : 'no_text' };
}

module.exports = { INSULT_RE, INSULT_LOOSE_RE, namedHerIn, computeTrigger };
