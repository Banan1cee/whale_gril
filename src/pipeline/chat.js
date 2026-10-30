'use strict';

/**
 * 机器人核心：判断要不要接话 → 组装提示词 → 由 DeepSeek 生成 → 写入记忆。
 * 这里不关心消息从哪来（网页 / 微信 / 抖音），只处理统一后的消息对象。
 *
 * 统一消息对象：
 * {
 *   platform: 'web'|'wechat'|'douyin',
 *   chatId:   '123456',              // 群 id 或用户 id
 *   chatType: 'private'|'group',
 *   senderId: 'wxid_xxx',
 *   senderName: '阿螈',
 *   text: '在吗',
 *   atMe: false,                     // 是否 @ 了鲸鲸 / 回复了鲸鲸
 *   msgId: '可选，用于去重',
 *   chatTitle: '深海鱼塘',            // 可选，群名
 * }
 */
const persona = require('../persona');
const recall = require('../memory/recall');
const _digestInFlight = new Set();
const memoryDigest = require('../memory/digest');
const memorySemantic = require('../memory/semantic');
const features = require('../infra/features');
const { matchMaster } = require('../core/master');
const links = require('../adapters/links');
const websearch = require('../adapters/websearch');
const searchRouter = require('../adapters/searchRouter');
const { DigestService } = require('../services/digestService');
const { LlmError } = require('../llm/client');
const { saveSettings } = require('../infra/config');
const personaStore = require('../persona/store');
const { sanitizeForModel, nameMatches, clampInt } = require('../core/text');
const trigger = require('../core/trigger');
const { INSULT_RE, INSULT_LOOSE_RE, namedHerIn } = require('../core/trigger');
const context = require('../core/context');
const { isEcho } = require('../core/echo');
const { extractSelfFacts } = require('../core/facts');
const { extractMentionNames } = require('../core/mentions');
const { COMMAND_HELP, extractCommand } = require('../core/commands');
const { cannedReply } = require('./stages/canned');
const reminderCore = require('../core/reminder');
const stickers = require('../adapters/stickers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


class Bot {
  constructor({ config, store, llm, logger, now = () => new Date(), rng = Math.random, mockChunkDelayMs = 12, linkReader = null }) {
    this.config = config;
    this.store = store;
    this.llm = llm;
    this.logger = logger;
    this.now = now;
    this.rng = rng;
    // 消息汇总（把错过的消息推给主人）：内存态队列，开关关着不采集。
    // 注意跟 memory/digest.js（整理记忆）不是一个东西。
    this.digestService = new DigestService(config, { now: () => this.now().getTime() });
    this.mockChunkDelayMs = mockChunkDelayMs;
    this.linkReader = linkReader || ((url) => links.describeLink(url, { timeoutMs: (config.links && config.links.timeoutMs) || 6000 }));
    this.startedAt = Date.now();
  }

  sessionKey(msg) {
    const type = msg.chatType === 'group' ? 'g' : 'u';
    return `${msg.platform}:${type}:${msg.chatId}`;
  }

  /**
   * 设提醒：「十点半提醒我开会」→ 落库，并回一句确认。
   * 不在提醒范围内的普通消息原样返回 null，交给后面的正常流程。
   */
  async tryReminder({ msg, clean, key, now, isGroup, atMe }) {
    const service = this.reminders;
    if (!service) return null;
    const text = String((clean && clean.text) || '').trim();
    if (!text || text.length > 120) return null;

    // 取消 / 查看：只处理「取消提醒」「提醒列表」这种整句
    if (/^(?:取消|删除|清空)(?:所有|全部)?提醒[。.!！~～]*$/.test(text)) {
      const pending = service.pendingFor(msg.chatId);
      if (!pending.length) return { action: 'reply', key, msg, atMe, canned: '这个会话没有待发的提醒。', reason: 'reminder_cancel' };
      for (const item of pending) service.cancel(item.id);
      return { action: 'reply', key, msg, atMe, canned: `好，取消了 ${pending.length} 条提醒。`, reason: 'reminder_cancel' };
    }
    if (/^(?:提醒列表|我的提醒|有哪些提醒)[。.!！~～?？]*$/.test(text)) {
      const pending = service.pendingFor(msg.chatId);
      if (!pending.length) return { action: 'reply', key, msg, atMe, canned: '这会儿没有待发的提醒。', reason: 'reminder_list' };
      const lines = pending.slice(0, 5).map((it) => `${reminderCore.describeWhen(new Date(it.dueAt), now)} ${it.text}`);
      return { action: 'reply', key, msg, atMe, canned: '还有这些：' + lines.join('；'), reason: 'reminder_list' };
    }

    if (!reminderCore.looksLikeReminder(text)) return null;
    let parsed = reminderCore.parseReminder(text, now);
    if (!parsed) parsed = await this.reminderFromModel(text, now);
    if (!parsed) return null;

    try {
      const item = service.add({
        wxid: msg.chatId,
        name: msg.chatTitle || msg.senderName || msg.chatId,
        chatType: msg.chatType,
        text: parsed.what,
        at: parsed.at,
        atName: msg.senderName || '',
      });
      this.logger && this.logger.info(`提醒已登记：${item.text} @ ${reminderCore.describeWhen(new Date(item.dueAt), now)}`);
      return {
        action: 'reply',
        key,
        msg,
        atMe,
        canned: reminderCore.confirmText(parsed, { now, group: isGroup, who: msg.senderName || '' }),
        reason: 'reminder_set',
      };
    } catch (err) {
      return { action: 'reply', key, msg, atMe, canned: '这个提醒没设上：' + ((err && err.message) || err), reason: 'reminder_error' };
    }
  }

  /** 规则解析不出来时，让模型把时间和事情抽成 JSON（模型不可用就放弃，不瞎猜） */
  async reminderFromModel(text, now) {
    if (!this.llm || this.llm.isMock || typeof this.llm.complete !== 'function') return null;
    const pad2 = (n) => String(n).padStart(2, '0');
    const nowText = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const raw = await this.llm.complete({
        system: [
          '你是一个提醒解析器。把用户这句话里的「提醒时间」和「提醒内容」抽出来。',
          `现在是 ${nowText}（本地时间）。只说今天/明天/后天/几点，按这个基准换成绝对时间。`,
          '只输出 JSON，不要解释、不要代码块围栏：{"at":"YYYY-MM-DD HH:mm","what":"要提醒的事"}',
          '如果这句话不是在让人提醒某件事，输出 {"at":"","what":""}。',
        ].join('\n'),
        turns: [{ role: 'user', content: String(text).slice(0, 120) }],
        maxTokens: 120,
        signal: controller.signal,
      });
      const jsonText = (String(raw || '').match(/\{[\s\S]*\}/) || [''])[0];
      if (!jsonText) return null;
      const obj = JSON.parse(jsonText);
      const at = new Date(String(obj.at || '').replace(' ', 'T'));
      const what = String(obj.what || '').trim().slice(0, 200);
      if (!what || !Number.isFinite(at.getTime())) return null;
      if (at.getTime() <= now.getTime()) return null;
      return { at, what, when: obj.at };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 最近别人说过的原话（含当前这条），用来判断她是不是在复读 */
  recentHeard(decision, limit = 6) {
    const msg = (decision && decision.msg) || {};
    const list = [];
    const current = String(msg.cleanText || msg.text || '').trim();
    if (current) list.push(current);
    try {
      const key = decision && decision.key;
      if (key) {
        const recent = this.store.messages(key, 20)
          .filter((m) => m.role === 'user' && m.text)
          .map((m) => String(m.text).trim())
          .filter((t) => t && t !== current);
        list.push(...recent.slice(-limit));
      }
    } catch { /* ignore */ }
    return list;
  }

  /** 她最近说过的几句，用来避免自己复读自己 */
  recentOwn(decision, limit = 4) {
    try {
      const key = decision && decision.key;
      if (!key) return [];
      return this.store.messages(key, 20)
        .filter((m) => m.role === 'assistant' && m.text && !m.error)
        .map((m) => String(m.text).trim())
        .slice(-limit);
    } catch {
      return [];
    }
  }

  normalize(msg) {
    const at = msg.atMe === true || msg.atMe === 1 || msg.atMe === '1' || msg.atMe === 'true';
    return {
      platform: String(msg.platform || 'web').slice(0, 20),
      chatId: String(msg.chatId ?? 'default').slice(0, 120),
      chatType: msg.chatType === 'group' ? 'group' : 'private',
      senderId: String(msg.senderId ?? 'anonymous').slice(0, 100),
      senderName: String(msg.senderName ?? '群友').slice(0, 60),
      text: String(msg.text ?? '').slice(0, 2000),
      atMe: at,
      msgId: msg.msgId ? String(msg.msgId).slice(0, 120) : '',
      chatTitle: msg.chatTitle ? String(msg.chatTitle).slice(0, 60) : '',
      replyToBot: msg.replyToBot === true,
      replyToName: String(msg.replyToName || msg.reply_to_name || '').slice(0, 60),
      replyToUserId: String(msg.replyToUserId || msg.reply_to_user_id || '').slice(0, 100),
      mentionedNames: (Array.isArray(msg.mentionedNames) ? msg.mentionedNames : Array.isArray(msg.mention_names) ? msg.mention_names : [])
        .map((x) => String(x && typeof x === 'object' ? (x.name || x.nickname || '') : x).trim()).filter(Boolean).slice(0, 4),
    };
  }

  buildTurns(msg, history) {
    return context.buildTurns(msg, history);
  }

  /**
   * 判断并准备好这次回复（不调用模型）。返回 decision。
   */
  async decide(rawMsg) {
    const digestOn = this.digestService.reconcile();
    const digestGeneration = this.digestService.generation;
    const decision = await this._decide(rawMsg);
    // 只收「错过」的普通微信消息：命令、重复、系统通知、被静默、已经回过的都不收。
    const missed = new Set(['addressed_to_other', 'not_addressed', 'silent', 'engaged_side_chatter', 'hourly_cap', 'cooldown']);
    if (digestOn && this.digestService.reconcile() && this.digestService.generation === digestGeneration
      && decision.action === 'ignore' && missed.has(decision.reason)) {
      this.digestService.collect(decision.msg);
    }
    return decision;
  }

  async _decide(rawMsg) {
    const msg = this.normalize(rawMsg);
    // 网页/管理员动态改窗口后，存储限额也要跟上；不会恢复之前已被丢弃的记录。
    if (this.store.limits) this.store.limits.maxMessages = Math.min(800, Math.max(this.store.limits.maxMessages, Number(this.config.chat.historyTurns || 200) + 2, Number(this.config.chat.groupHistoryTurns || 150) + 2));
    const key = this.sessionKey(msg);
    const now = this.now();
    const nowMs = now.getTime();
    // 群消息常带 "wxid_xxx:\n正文" 前缀，先去掉再识别 @/名字，否则别名不在行首会漏判
    const rawText = String(msg.text || '').replace(/^[A-Za-z0-9_\-]{4,}:\s*/, '');
    const clean = persona.cleanIncoming(rawText, this.config);
    msg.cleanText = clean.text;
    const atMe = msg.atMe || clean.atMe;
    const isGroup = msg.chatType === 'group';
    const mentionedNames = isGroup
      ? [...new Set([...(msg.mentionedNames || []), ...extractMentionNames(rawText, persona.aliasList(this.config))])].slice(0, 4)
      : [];
    msg.mentionedNames = mentionedNames;
    msg.externalMentionNames = mentionedNames;
    msg.addressedToBot = Boolean(atMe || msg.replyToBot);

    // 系统号 / 通知类消息（比如「微信团队」的自动推送）一律不接话
    const sysNames = new Set([
      '微信团队', '微信支付', '服务通知', '订阅号消息', '文件传输助手',
      '微信运动', '微信公众平台', '腾讯客服', '微信安全中心',
      ...((this.config.wechat && this.config.wechat.ignoreSenders) || []).map((x) => String(x)),
    ]);
    if (/<a\s+href=|weixin:\/\//i.test(rawText) || sysNames.has(String(msg.senderName || ''))) {
      return { action: 'ignore', reason: 'system_notice', key, msg, atMe };
    }

    // 消息里有链接 → 读一下标题/摘要（短视频平台只读得到文案，读不到画面）
    let linkText = '';
    if (clean.text && (!this.config.links || this.config.links.enabled !== false)) {
      const urls = links.extractUrls(clean.text);
      if (urls.length) {
        try {
          const info = await this.linkReader(urls[0]);
          linkText = links.formatForPrompt(info);
          this.logger && this.logger.info(`读取链接：${urls[0]} → ${info && info.ok ? 'ok' : (info && info.error) || 'failed'}`);
          const title = String((info && (info.title || info.site)) || '').slice(0, 60);
          this.store.appendEvent(key, {
            type: 'link',
            detail: title ? `${urls[0].slice(0, 80)} → ${title}` : urls[0].slice(0, 120),
            status: info && info.ok ? 'ok' : 'failed',
          });
        } catch (err) {
          linkText = `对方发了一个链接（${urls[0]}），但读取失败。`;
          this.logger && this.logger.warn('读取链接失败：' + (err && err.message));
          this.store.appendEvent(key, { type: 'link', detail: urls[0].slice(0, 120), status: 'failed' });
        }
      }
    }

    const session = this.store.ensureSession(key, {
      platform: msg.platform,
      chatId: msg.chatId,
      chatType: msg.chatType,
      title: msg.chatTitle,
    });

    // 1) 去重
    if (msg.msgId && this.store.isDuplicate(key, msg.msgId)) {
      return { action: 'ignore', reason: 'duplicate', key, msg };
    }
    if (msg.msgId) this.store.markSeen(key, msg.msgId);

    // 每个说话人分别跟踪最近的显式 @ 对象；只作为短时路由提示，不当作确定事实。
    if (isGroup) {
      const targets = session.state.externalTargets || (session.state.externalTargets = {});
      for (const [uid, value] of Object.entries(targets)) {
        if (nowMs - Number(value.ts || 0) > 60000) delete targets[uid];
      }
      if (atMe || msg.replyToBot) {
        delete targets[msg.senderId];
      } else if (mentionedNames.length) {
        targets[msg.senderId] = { names: mentionedNames, ts: nowMs };
        msg.directedElsewhere = true;
      } else if (targets[msg.senderId] && /你|您/.test(clean.text)) {
        msg.directedElsewhere = true;
        msg.inferredTargetNames = targets[msg.senderId].names;
      }
    }

    // 2) 记录收到的话（被忽略的也记，让它知道群里在聊什么）
    // 只 @ 不说话时：看看这个人刚才是不是问过什么，直接接着回答上一个问题
    if (isGroup && atMe && (!clean.text || /^[?？!！.。…~～\s]+$/.test(clean.text))) {
      try {
        const recent = this.store
          .messages(key, 8)
          .filter((m) => m.role === 'user' && m.text && String(m.text).trim().length > 1)
          .filter((m) => String(m.text).trim() !== String(rawText).trim())
          .filter((m) => {
            if (msg.senderId && m.uid) return String(m.uid) === String(msg.senderId);
            return !msg.senderName || String(m.name || '') === String(msg.senderName);
          });
        const last = recent[recent.length - 1];
        if (last && this.now().getTime() - Number(last.ts || 0) < 180000) {
          clean.text = String(last.text).trim();
          msg.cleanText = clean.text;
        }
      } catch { /* ignore */ }
    }

    const hasText = Boolean(clean.text);
    if (hasText) {
      this.store.appendMessage(key, {
        role: 'user',
        name: msg.senderName,
        uid: msg.senderId,
        text: clean.text,
        ts: nowMs,
        msgId: msg.msgId,
        addressedToBot: msg.addressedToBot,
        mentionedNames,
        inferredTargetNames: msg.inferredTargetNames || [],
        replyToName: msg.replyToName,
        replyToUserId: msg.replyToUserId,
      });
    }
    const profile = this.store.profile(key, msg.senderId, msg.senderName);
    // 自动记一点关于这个人的事实，下次不用重新问（只认明确的自述句）
    if (hasText && !isGroup) {
      try {
        const facts = extractSelfFacts(clean.text);
        for (const fact of facts) this.store.addNote(key, msg.senderId, fact);
      } catch { /* ignore */ }
    }
    const state = session.state;
    const muted = state.mutedUntil > nowMs;

    // 识别「唯一的主人」（配置里 master.names / master.wxids）
    // 规则只写在 src/master.js，调试台预览提示词用的是同一个函数，不会出现
    //「控制台说认了、微信里却当陌生人」这种两边打架的情况。
    const masterCfg = (this.config.persona && this.config.persona.master) || {};
    const masterHit = matchMaster(this.config, msg);
    const isMaster = masterHit.isMaster;
    // 每条微信私聊都留一行判定，出问题直接看日志，不用猜
    if (msg.platform === 'wechat' && msg.chatType === 'private' && this.logger) {
      this.logger.info(
        `[master] 私聊 ${msg.senderName || '(无名)'}（${msg.senderId || '没有 id'}）→ ` +
        `${isMaster ? '主人' : '非主人'}${masterHit.reason ? '（' + masterHit.reason + '）' : ''}`
      );
    }
    // 昵称对上了、senderId 却没对上：八成是 master.wxids 里填了微信号或昵称，微信里认不出来。
    // 每个 id 只提醒一次，别刷日志。
    if (!isMaster && msg.platform === 'wechat' && masterHit.nameHit) {
      const sid = String(msg.senderId || '(没有 id)');
      this._masterWarned = this._masterWarned || new Set();
      if (!this._masterWarned.has(sid) && this.logger) {
        this._masterWarned.add(sid);
        this.logger.warn(
          `[master] 昵称「${msg.senderName}」在主人名单里，但 senderId「${sid}」和 persona.master.wxids 里的` +
          `「${masterHit.wxids.join('、') || '空'}」都对不上；微信里只认 senderId。` +
          `如果这是主人，把 ${sid} 填进 config.json 的 persona.master.wxids`
        );
      }
    }
    // 后面生成的文本要判断「是不是在对主人说话」（例如不许带脏字回骂）
    msg.isMaster = isMaster;

    // 提醒：任何会话、任何人都能设（「十点半提醒我开会」）。
    // 放在最前面：群里没 @ 她也要能设，且不能被后面的静默/忽略逻辑挡掉。
    if (hasText) {
      const reminderReply = await this.tryReminder({ msg, clean, key, now, nowMs, isGroup, atMe });
      if (reminderReply) return reminderReply;
    }

    // 对别人的话仍然旁听存档，但不触发命令、回怼或接话。
    if (isGroup && msg.directedElsewhere) {
      return { action: 'ignore', key, msg, reason: 'addressed_to_other' };
    }


    // 固定话术：群成员名录 / 查自己的号 / 同意被损 / 主人点名吐槽 / 退场 / 休息模式。
    // 这些只靠一条正则就能决定，不调模型；实现见 pipeline/stages/canned.js。
    const canned = cannedReply(this, {
      msg,
      text: clean.text,
      isGroup,
      isMaster,
      atMe,
      state,
      nowMs,
      key,
    });
    if (canned) return canned;

    // 魔咒 / 管理员权限（只有主人能用）
    const adminReply = this.handleAdmin({ msg, clean, key, state, isMaster, nowMs });
    if (adminReply) return adminReply;

    // 主人在微信里禁言过这个群 → 一句话都不说
    const mutedGroups = (this.config.group && Array.isArray(this.config.group.mutedGroups)) ? this.config.group.mutedGroups : [];
    if (isGroup && mutedGroups.length) {
      const groupName = msg.chatTitle || session.title || '';
      if (mutedGroups.some((g) => g === '*' || nameMatches(groupName, g))) {
        return { action: 'ignore', reason: 'muted_group', key, msg };
      }
    }

    // 3) 命令（群里说「安静」这类自然语言命令，要先叫到鲸鲸才算；主人说话直接算）
    let command = hasText ? extractCommand(clean.text) : null;
    const slashCommand = Boolean(command && /^[/／!！]/.test(command.raw));
    const addressed = atMe || msg.replyToBot;
    if (command && isGroup && !addressed && !slashCommand && !isMaster) command = null;
    if (command && isGroup && muted && command.type !== 'unmute') command = null;
    if (command) {
      return this.runCommand({ command, msg, key, profile, state, now, nowMs, atMe });
    }

    // 4) 群聊里没被叫到就先不说话
    const trigger = this.computeTrigger({ msg, atMe, clean, isGroup, state, nowMs, isMaster });
    // 群里被人骂了但没 @：只有「骂的是她」才唤醒她反击。
    // 以前这里只看「文本带脏字」+「她刚说过话/在接话窗口」就唤醒 —— 于是群里任何人
    // 抱怨一句「这天气真垃圾」「股票跌了滚蛋吧」，她都会跳出来，还绕过静默期。
    if (!trigger.wake && isGroup && !atMe) {
      const said = String(clean.text || '');
      const insulted = INSULT_RE.test(said) || INSULT_LOOSE_RE.test(said);
      const guard = features.isOn(this.config, 'groupAddressGuard');
      // 只说「机器人」不再等于叫她：得带指代（这个/你/破/臭/傻/烂…），
      // 否则群里讨论「这破机器人又卡了」都会被当成骂她。
      const bareRobot = /(鲸鲸|小鲸|肥鱼)/i.test(said);
      const pointedRobot = guard
        ? /(这个|那个|你|破|臭|傻|烂|死)?\s*机器人/.test(said) && /(这个|那个|你|破|臭|傻|烂|死)/.test(said)
        : /机器人|人机|bot/i.test(said);
      const namedHer = guard ? bareRobot || pointedRobot : /(鲸鲸|小鲸|肥鱼|机器人|人机|bot)/i.test(said);
      const talkingToHer =
        Boolean(msg.replyToBot) ||
        (String(state.engagedBy || '') === String(msg.senderId || '') && Number(state.engagedUntil) > nowMs);
      // L1：这条明明在跟别人说话（@了别人 / 出现其他成员名字 / 第三人称指代）→ 不算骂她
      let talkingToOthers = false;
      if (guard) {
        const others = Array.isArray(msg.mentionedNames) ? msg.mentionedNames.filter(Boolean) : [];
        const otherMentioned = others.length > 0;
        const thirdPerson = /(他|她|楼上|楼下|那谁|某人|刚才那个)/.test(said) && !/(你|你们)/.test(said);
        const otherNames = (msg.otherMemberNames || []).some((n) => n && n !== msg.senderName && said.includes(n));
        talkingToOthers = otherMentioned || thirdPerson || otherNames;
      }
      const aimedAtHer = (namedHer || talkingToHer) && !talkingToOthers;
      const silent = Number(state.silentUntil) > nowMs;
      // 静默期内（被赶走了）不反击：除非 @ 她（上面 addressed 已解除静默）
      if (insulted && aimedAtHer && !silent) {
        trigger.wake = true;
        trigger.reason = 'insulted';
      }
      if (guard && talkingToOthers && this.logger) {
        this.logger.info(`[group] 判定在跟别人说话，不接：${said.slice(0, 24)}`);
      }
    }
    if (!trigger.wake) {
      return { action: 'ignore', reason: trigger.reason, key, msg, atMe };
    }
    // 只有明确叫她、定向叫她或同一个人接着聊，才延长接话窗口。
    // 不能让旁人的闲聊把窗口续下去。
    if (isGroup && ['addressed', 'directed', 'engaged', 'insulted'].includes(trigger.reason)) {
      state.engagedUntil = nowMs + Math.max(1, Number(this.config.group.engagedMinutes) || 6) * 60000;
    }
    if (muted) {
      return { action: 'ignore', reason: 'muted', key, msg, atMe };
    }
    // 同一个会话一分钟内已经回了太多条 → 先停一下，别越聊越乱
    const recentReplies = (state.replyTimes || []).filter((t) => nowMs - Number(t) < 60000);
    if (recentReplies.length >= 10) {
      return { action: 'ignore', reason: 'burst_limit', key, msg, atMe };
    }

    // 对方只发了一个「？」→ 也回一个「？」
    if (hasText && /^[?？]+$/.test(String(clean.text || '').trim())) {
      return { action: 'reply', key, msg, atMe, canned: '？', reason: 'question_mark' };
    }

    // 整条就是已知缩写时走固定短回法，保证 kskbl 只回 zdjd，不让模型多发挥。
    const fixedAbbrev = hasText && persona.abbrevReply ? persona.abbrevReply(clean.text) : '';
    if (fixedAbbrev) {
      return { action: 'reply', key, msg, atMe, canned: fixedAbbrev, reason: 'abbrev' };
    }

    // 5) 只 @ 了一下、没说话（或只发了一串省略号/感叹号）
    if (!hasText || /^[?？!！.。…~～\s]+$/.test(clean.text || '')) {
      const rawText = String(msg.text || '');
      // 被用「乐乐 / 小乐乐」这种外号点名 → 当挑衅
      if (/乐乐/.test(rawText)) {
        return {
          action: 'reply',
          key,
          msg,
          atMe,
          canned: isMaster ? '主人你叫谁乐乐呢，哼' : '乐乐你叫谁呢',
          reason: 'nickname_provoke',
        };
      }
      return {
        action: 'reply',
        key,
        msg,
        atMe,
        canned: isGroup ? '在，怎么啦' : (isMaster ? '在呢主人，怎么啦' : '在，怎么了'),
        reason: 'bare_mention',
      };
    }

    // 群里被叫到一次后，接下来继续聊就接着回；换话题/沉默超时就不接了
    const engagedMinutes = Math.max(1, Number(this.config.group.engagedMinutes) || 6);
    if (isGroup) {
      if (atMe || msg.replyToBot) {
        state.engagedUntil = nowMs + engagedMinutes * 60000;
        state.engagedBy = String(msg.senderId || '');
      } else if (/(换个话题|不说这个|不聊这个|算了不聊|聊点别的|跳过这个话题|别聊了|没你事|跟你没关系|不关你事|没问你|别接话|不用接)/.test(clean.text || '')) {
        state.engagedUntil = 0;
        state.engagedBy = '';
      }
    }

    // 需要最新信息时联网搜一下
    let webText = '';
    const webCfg = this.config.websearch || {};
    const webOn = webCfg.enabled !== false;
    // 路由、定位、天气/热榜及补搜共享预算，不能每一步重新等一个完整超时。
    const webDeadline = Date.now() + Math.max(1, Number(webCfg.timeoutMs) || 8000);
    const webRemaining = () => Math.max(0, webDeadline - Date.now());
    // 注意：以前只认「查一下/最新/多少钱」这类词。用户问「苹果出到几了」「现在几代」这种
    // 口语问题时匹配不上，她就拿训练数据里的旧型号回答（实测把 iPhone 18 说成 16）。
    const searchPattern = new RegExp(
      [
        '(查一下|查查|搜一下|搜搜|帮我查|帮我看看|最新|热搜|新闻|发生了什么|怎么回事|多少钱|什么价格|几块钱)',
        '(什么时候|是谁|谁是|行情|报价|天气|下雨|下雪|气温|多少度|冷不冷|热不热|台风|雾霾|空气质量)',
        '(出到|出到哪|第几代|几代|什么型号|哪个型号|哪个版本|什么版本|现在还|现在最新|今年|去年)',
        '(苹果|iphone|ipad|华为|小米|三星|索尼|任天堂|switch|ps5|显卡|rtx|骁龙|麒麟|芯片|发布会)',
      ].join('|'),
      'i'
    );
    // 只按关键词触发，词库里没有的说法就永远不联网（「B站的热搜是什么」命中「热搜」，
    // 但取的是头条榜，答非所问）。补一条「问句形态」兜底：在问事实、不是闲聊、不是问观点。
    const ASK_FACT_RE = /(是什么|是谁|多少|几号|几点|怎么样|怎么|为什么|哪一?[个些张条]|哪个|有没有|是不是|能不能|会不会|可不可以|排行|排名|热搜|热榜|热门|最新|出到|第几)/;
    const CHITCHAT_RE = /^(在吗|在不在|你好|嗨|hi|哈喽|早安|晚安|睡了|吃饭了吗|吃了吗|你在干嘛|在干啥|干啥呢|干嘛呢)/i;
    const OPINION_RE = /(你觉得|你认为|你看|你怎么看|该不该|要不要|喜不喜欢|喜欢吗|讨厌|爱我吗|想我了吗)/;
    const looksLikeFactQuestion = ASK_FACT_RE.test(clean.text || '')
      && !CHITCHAT_RE.test(String(clean.text || '').trim())
      && !OPINION_RE.test(clean.text || '');
    // 主判断交给模型（语义），关键词只在模型不可用时兜底：
    // 「小蓝鲸是什么梗」这种词库里没有的说法也会查，「你觉得呢」「在吗」不会被误触发。
    let route = { need: false, query: '', site: '', failed: true };
    if (webOn && clean.text) {
      try {
        route = await searchRouter.route(this.llm, clean.text, {
          history: this.recentHeard({ msg, key }).filter((line) => line !== clean.text),
          timeoutMs: Math.min(2000, Math.max(1, webRemaining())),
        });
      } catch { route = { need: false, query: '', site: '', failed: true }; }
    }
    const keywordFallback = route.failed && (searchPattern.test(clean.text || '') || looksLikeFactQuestion);
    const shouldSearch = webOn && Boolean(clean.text) && (route.need || keywordFallback);
    if (shouldSearch) {
      try {
        const isWeather = /(天气|下雨|下雪|气温|多少度|冷不冷|热不热|台风|雾霾|空气)/.test(clean.text);
        // 模型给出的检索式已清洗；别再全局删除「吗/呢」等字符，可能属于专名。
        let q = String(route.need && route.query ? route.query : clean.text).trim().slice(0, 100);
        const site = /(b站|哔哩哔哩|bilibili)/i.test(clean.text) ? 'bilibili'
          : /(微博|weibo)/i.test(clean.text) ? 'weibo'
            : /(今日头条|头条)/.test(clean.text) ? 'toutiao' : route.site;
        const siteDomain = { bilibili: 'bilibili.com', weibo: 'weibo.com', toutiao: 'toutiao.com' }[site];
        if (isWeather) {
          // 天气走专门的接口（open-meteo）：Bing 摘要常常只有「多云」没温度，还爱串城市。
          // 对方话里没提城市就用配置里的 city；都没配就退回搜索引擎。
          const city = String(webCfg.city || '').trim();
          const hasCity = /(北京|上海|天津|重庆|广州|深圳|杭州|南京|成都|武汉|西安|苏州|长沙|郑州|青岛|沈阳|大连|厦门|福州|济南|合肥|昆明|南宁|贵阳|太原|A 城市|哈尔滨|长春|兰州|银川|西宁|乌鲁木齐|呼和浩特|拉萨|海口|三亚|宁波|无锡|东莞|佛山|温州|珠海|中山|惠州|台州|常州|徐州|烟台|洛阳|保定|唐山|香港|澳门|台北|[\u4e00-\u9fa5]{2,4}市)/;
          let weatherCity = '';
          const hit = String(clean.text).match(hasCity);
          if (hit) weatherCity = hit[0].replace(/市$/, '');
          if (!weatherCity && city) weatherCity = city;
          if (!weatherCity && webRemaining() > 0) {
            // 话里没说、配置也没填 → 按本机公网 IP 猜一下（否则会搜到随机城市，
            // 比如人在A 城市却答「B 城市今天晴」）。
            try { weatherCity = await websearch.ipCity(webRemaining()); } catch { /* 忽略 */ }
          }
          if (weatherCity && webRemaining() > 0) {
            try {
              webText = await websearch.weatherText(weatherCity, { timeoutMs: webRemaining() });
              if (webText && this.logger) {
                this.logger.info('天气查询：' + weatherCity);
              }
            } catch { /* 落到搜索引擎 */ }
          }
          if (!webText) {
            if (!hit && city) q = city + ' 天气';
            else if (!/天气/.test(q)) q = q + ' 天气';
          }
        }
        // 只有在问榜单/泛新闻时才取热榜；指定平台不等于要求该平台热搜。
        // 实测：「苹果现在出到几了」加 2026 后，新文章反而被官方首页挤掉，时效性交给 dropStaleResults。
        const wantsHotList = /(热搜|热榜|热点榜|排行榜|热门榜)/.test(clean.text)
          || /^(?:今天|今日|现在|最新)?(?:有)?(?:什么)?(?:新闻|热点|大事件|头条)(?:是什么|有哪些|发生了什么|[?？])?$/.test(clean.text)
          || /^(?:今天|今日|最近)?发生了什么[?？]?$/.test(clean.text);
        if (!webText && wantsHotList && webRemaining() > 0) {
          try {
            if (site === 'bilibili') {
              webText = await websearch.bilibiliHotText(10, webRemaining());
            } else if (site === 'weibo') {
              webText = await websearch.weiboHotText(10, webRemaining());
            } else {
              webText = await websearch.hotNewsText(8, webRemaining());
            }
          } catch { /* 同平台搜索兜底，不拿头条榜冒充 B站/微博榜 */ }
        }
        if (!webText && webRemaining() > 0) {
          if (siteDomain) q = q + ' site:' + siteDomain;
          webText = await websearch.searchText(q || String(clean.text).slice(0, 100), {
            limit: 4,
            timeoutMs: webRemaining(),
          });
        }
        if (webText) this.logger && this.logger.info('联网搜索：' + String(clean.text).slice(0, 30));
        // 联网结果只在这一轮的提示词里出现一次，下一轮就没了；
        // 记一条账，她才能回答「你刚才查的什么」「查到了吗」。
        this.store.appendEvent(key, {
          type: 'web',
          detail: String(clean.text || '').slice(0, 60),
          status: webText ? 'ok' : 'empty',
        });
      } catch { /* ignore */ }
    }
    // 搜到的东西必须真的送进提示词。以前只赋给局部变量、写了个日志就完事，
    // msg 上从没挂过 webText，于是 persona 里那段「【刚联网搜到的资料】」永远是空——
    // 表现就是「问她天气她不知道」，明明日志里已经搜到了。
    msg.webText = webText;
    // 空结果也要传递真实状态；不能让模型把「尝试过」说成「已查到」。
    msg.webSearchStatus = shouldSearch ? (webText ? 'ok' : 'empty') : '';
    // 现场问题：日志有「联网搜索」，回复却说「我记的是旧的」——光看日志分不清
    // 资料到底有没有进提示词。这里把注入长度也记下来，一眼能对上。
    if (webText && this.logger) this.logger.info('联网资料已注入提示词：' + String(webText).length + ' 字');

    // 认真讨论（不是随口闲聊）→ 允许说长一点、有观点
    const discussPattern = /(讨论|探讨|你觉得|你怎么看|你认为|为什么|该不该|要不要|是不是应该|如何选择|怎么选|怎么看|有道理吗|值得吗|价值观|人生|意义|观点|看法|利弊|优缺点)/;
    const discussUntil = Number(state.discussUntil) || 0;
    const discussion = Boolean(discussUntil > nowMs || (clean.text && clean.text.length >= 8 && discussPattern.test(clean.text)));
    if (discussion) state.discussUntil = nowMs + 10 * 60000; // 聊到一个话题就连续 10 分钟算讨论
    msg.discussion = discussion;

    // 6) 组装提示词
    // 按这句话挑最该被想起的几条（不再把全部便签一股脑塞进去）。
    // 挑中的会记一次「刚提过」，避免她接下来几条反复念同一件事。
    const noteLimit = Math.max(3, Number(this.config.memory.maxNotesPerUser) || 6);
    // 先按字面/同义词多取几条当候选，再让模型判断相关性（关掉开关就直接用字面结果）
    let pickedNotes = recall.pickNotes(profile.notes, clean.text, {
      now: nowMs,
      limit: Math.max(noteLimit + 2, 8),
    });
    // 候选太少时不值得多一次模型调用（只有一两条直接给它）
    const minCand = Math.max(2, Number(this.config.memory.semanticMinCandidates) || 3);
    if (features.isOn(this.config, 'memorySemantic')) {
      // 字面没命中的记忆进不了候选（比如记忆写「要去体检」、对方问「医院」），
      // 所以语义检索这一层直接给它较大的一批：最多 10 条，让模型自己挑。
      const all = (profile.notes || [])
        .map((n) => recall.normalizeNote(n, nowMs))
        .filter(Boolean)
        .slice(0, memorySemantic.MAX_CANDIDATES);
      const candidates = all.length > pickedNotes.length ? all : pickedNotes;
      if (candidates.length >= minCand) {
        const keep = await memorySemantic.rerank(this.llm, clean.text, candidates, {
          limit: noteLimit,
          logger: this.logger,
        });
        pickedNotes = Array.isArray(keep)
          ? keep.map((i) => candidates[i]).filter(Boolean)
          : candidates.slice(0, noteLimit);
      }
    }
    const notes = pickedNotes.map((n) => n.text);
    // 一天以上的「承诺 / 近况」可以在合适的时候被顺口提起
    const noteReminders = pickedNotes
      .filter((n) => (n.kind === 'promise' || n.kind === 'recent') && nowMs - n.createdAt > recall.DAY)
      .slice(0, 2)
      .map((n) => n.text);
    if (notes.length && msg.senderId) {
      this.store.touchNotes(key, msg.senderId, notes, nowMs);
    }
    // 群里用微信昵称区分说话人，避免用户改 profile.nickname 造成冒名；私聊仍沿用自报昵称。
    const displayName = isGroup ? (msg.senderName || profile.nickname) : (profile.nickname || msg.senderName);
    // 刚写入的当前消息是 history 的最后一条，先去掉，由 buildTurns 统一拼一次
    const histTurns = isGroup ? (this.config.chat.groupHistoryTurns || 6) : this.config.chat.historyTurns;
    const history = this.store.messages(key, histTurns);
    const groupParticipants = isGroup
      ? [...new Set(history.filter((m) => m.role === 'user' && m.name).map((m) => String(m.name)))].slice(-16)
      : [];
    // 群聊风格：从最近消息估计群友的句子长度和常用梗，让她跟着学
    let groupStyleText = '';
    if (isGroup) {
      try {
        const terms = persona.slangTerms ? persona.slangTerms(this.config) : [];
        const others = history.filter((m) => m.role !== 'assistant' && m.text).slice(-30);
        const avg = others.length ? Math.round(others.reduce((n, m) => n + String(m.text).length, 0) / others.length) : 0;
        const joined = others.map((m) => String(m.text)).join(' ');
        const hits = terms
          .map((t) => [t, joined.split(t).length - 1])
          .filter((pair) => pair[1] > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map((pair) => pair[0]);
        if (avg) groupStyleText = `这个群平均每句约 ${avg} 个字${hits.length ? '，最近常用：' + hits.join('、') : ''}。`;
      } catch { /* ignore */ }
    }
    // 被攻击 / 主人被骂 → 进入最大火力模式
    const insultRe = INSULT_RE;
    const dirtyRe = /操|草|妈|傻逼|婊|贱|死|滚|逼/;
    const heardText = String(clean.text || '');
    // 骂到她头上，或者骂到她主人头上，都算开战
    const masterNameList = (masterCfg.names || []).map((n) => String(n).toLowerCase()).filter(Boolean);
    const masterMentioned = /主人/.test(heardText) || masterNameList.some((n) => n && heardText.toLowerCase().includes(n));
    // 只有在「骂的是她」时才开火。以前这里是裸匹配：群里任何人抱怨一句
    // 「这天气真垃圾」「股票跌了滚蛋吧」，她都会以为在骂自己，然后跳出来对喷 ——
    // 表现就是「没人 @ 她，她还在说话」。
    // 注意「你」不能单独算数：群里说「张三你个傻逼」那个「你」指的是张三，不是她。
    // 只有在正跟她对话（@她 / 回复她 / 同一个人的接话窗口）时，「你」才指向她。
    const inConversationWithSender =
      Boolean(atMe || msg.replyToBot) ||
      (isGroup && String(state.engagedBy || '') === String(msg.senderId || '') && Number(state.engagedUntil) > nowMs);
    // 直接点名她/叫机器人，无论谁说的都算
    const namedHer = /(鲸鲸|小鲸|肥鱼|机器人|人机|bot)/i.test(heardText);
    // 正在跟她对话的人，哪怕只说「傻逼」两个字、不带「你」不带名字，也是在骂她；
    // 但「张三你个傻逼」里的「你」指的是张三，不在对话中就不算。
    const aimedAtHer = namedHer || inConversationWithSender;
    let fight = !isMaster && aimedAtHer && insultRe.test(heardText);
    let fightDirty = fight && dirtyRe.test(heardText);
    let fightOnMaster = Boolean(fight && masterMentioned);
    let fightTarget = null;
    // 主人说「有人骂我 / 帮我怼他」：翻最近的记录，把骂他的人揪出来当靶子
    if (isMaster && /(有人骂我|谁骂我|他骂我|她骂我|骂我了|刚才骂我|帮我骂|帮我怼|怼他|有人喷我)/.test(heardText)) {
      try {
        const recent = this.store.messages(key, 20).filter((m) => m.role === 'user' && m.uid && String(m.uid) !== String(msg.senderId));
        for (let i = recent.length - 1; i >= 0; i -= 1) {
          const line = String(recent[i].text || '');
          if (insultRe.test(line) || /臭|破|傻|烂|没用|闭嘴|烦人|装/.test(line)) {
            fightTarget = { name: recent[i].name || '那个人', text: line.slice(0, 60) };
            break;
          }
        }
      } catch { /* ignore */ }
      if (fightTarget) {
        fight = true;
        fightDirty = true;
        fightOnMaster = true;
      }
    }
    // buildTurns 也要知道在不在对喷：对喷时不洗掉脏话，否则模型看不见对面骂了啥
    msg.fight = fight;
    msg.fightReason = trigger.reason || '';
    msg.fightDirty = fightDirty;
    msg.fightTarget = fightTarget;
    msg.fightOnMaster = fightOnMaster;

    const system = persona.buildSystem({
      config: this.config,
      msg: { ...msg, senderName: displayName, chatTitle: msg.chatTitle || session.title, isMaster, atMe, addressedToBot: Boolean(atMe || msg.replyToBot), mentionedNames, groupParticipants, linkText, discussion, model: this.llm.model, provider: this.llm.providerLabel, groupStyleText, webText, fight, fightDirty, fightOnMaster },
      profile,
      notes,
      noteReminders,
      sessionSummary: (session && session.summary) || '',
      // 外部动作账本：她做过什么（发表情包、交给桥接、读链接、联网），
      // 不塞进去她就永远不知道自己的副作用，只能编。
      events: this.store.events(key, 12),
      now,
    });
    const turns = this.buildTurns(msg, hasText ? history.slice(0, -1) : history);

    // 对喷的台词交给模型自己现编；只有没配 Key 的演示模式才用本地库顶着
    if (fight && this.llm.isMock) {
      const kinds = persona.clapbackKinds({ dirty: true });
      const first = persona.clapbackPick(kinds, this.rng);
      if (first) {
        const combo = this.rng() < 0.6 ? persona.clapbackPick(['反问', '爹味'], this.rng) : '';
        const text = combo && combo !== first ? first + '，' + combo : first;
        return { action: 'reply', key, msg, atMe, canned: text, reason: 'clapback', system, turns };
      }
    }

    if (this.llm.isMock) {
      const text = persona.mockReply({
        text: clean.text,
        userName: displayName,
        chatType: msg.chatType,
        notes,
        rng: this.rng,
      });
      return { action: 'reply', key, msg, atMe, system, turns, mock: true, text, reason: trigger.reason };
    }
    return { action: 'reply', key, msg, atMe, system, turns, mock: false, reason: trigger.reason };
  }

  computeTrigger(args) {
    return trigger.computeTrigger(this, args);
  }

  /** 魔咒 + 管理员命令。返回 decision，或 null 表示继续走普通聊天流程 */
  handleAdmin({ msg, clean, key, state, isMaster, nowMs }) {
    const adminCfg = this.config.admin || {};
    const spell = String(adminCfg.spell || '').trim();
    const minutes = Math.max(1, Math.min(1440, Number(adminCfg.minutes) || 30));
    const allowAll = Boolean(adminCfg.allowAll);
    const text = String((clean && clean.text) || '').trim();
    const say = (msgText, commandType = 'admin') => ({
      action: 'command', commandType, key, msg, atMe: true, reason: 'admin', text: msgText,
    });

    // 1) 输入魔咒
    if (spell && text === spell) {
      if (!isMaster && !allowAll) {
        this.store.redactLastMessage(key, '（已隐藏：有人试图使用魔咒）');
        this.logger && this.logger.warn(`[admin] 非主人「${msg.senderName}」尝试使用魔咒，已忽略`);
        return { action: 'ignore', reason: 'not_owner', key, msg, atMe: Boolean(msg && msg.atMe) };
      }
      state.adminUntil = nowMs + minutes * 60000;
      this.store.redactLastMessage(key, '（已隐藏：管理员验证）');
      this.store.markDirty();
      this.logger && this.logger.info(`[admin] 主人 ${msg.senderName} 获得管理员权限 ${minutes} 分钟（会话 ${key}）`);
      const warn = msg.chatType === 'group' ? '（群里别人也能看到魔咒，下次建议私聊发）' : '';
      return say(
        `（魔咒生效）管理员权限 ${minutes} 分钟。可以发：状态 / 改模型 deepseek-reasoner / 演示模式 开|关 / 群聊主动接话 开|关 / 重置记忆 / 清空所有记忆 / 退出管理${warn}`,
        'admin_spell'
      );
    }

    // 2) 管理员命令：主人直接生效，不用开魔咒；allowAll=true 时任何人也能用
    if (!isMaster && !allowAll) return null;
    if (!isMaster && !allowAll && !(Number(state.adminUntil) > nowMs)) {
      const looksControl =
        /(禁言|解禁|静音)/.test(text) ||
        /^(?:别|不要|停止)(?:再)?(?:在)?\s*.+?群/.test(text) ||
        /^让\s*.+?群\s*(?:闭嘴|安静)/.test(text);
      if (looksControl) {
        return say('这个得先开管理员权限才能改：先发魔咒，再说「解除禁言 群名」。', 'admin_hint');
      }
      return null;
    }
    const remaining = Math.max(1, Math.round(((Number(state.adminUntil) || nowMs) - nowMs) / 60000));

    // —— 群禁言（让某个群安静） ——
    let mg;
    // 允许「你/请/帮我」开头，允许「暂时/先」前缀
    const mt = String(text).replace(/^(?:你|请|麻烦|帮我|能不能|可不可以|可以|先|暂时)+/, '').trim();
    if (/^(?:禁言列表|群聊禁言|禁言名单|黑名单)$/.test(text)) {
      const list = (this.config.group && this.config.group.mutedGroups) || [];
      return say(list.length ? '当前禁言：' + list.map((x) => (x === '*' ? '所有群' : x)).join('、') : '现在没有禁言的群。');
    }
    if ((mg = mt.match(/^(?:别|不要|停止|暂时不要)(?:再)?(?:在)?\s*(.+?)\s*(?:那个)?群(?:里|中|里面)?\s*(?:说话|发言|说)(?:了|啦|啊|呀|吧|嘛)?[。.!！~～]*$/))
        || (mg = mt.match(/^(?:禁言|屏蔽)\s*(.+?)$/))
        || (mg = mt.match(/^把\s*(.+?)\s*(?:群)?\s*禁言$/))
        || (mg = mt.match(/^让\s*(.+?)\s*(?:群)?\s*闭嘴$/))) {
      const g = String(mg[1]).replace(/[「」"'“”]/g, '').replace(/(那个|这个)?群$/, '').trim();
      if (g) {
        const list = Array.isArray(this.config.group.mutedGroups) ? this.config.group.mutedGroups.slice() : [];
        if (!list.some((x) => nameMatches(x, g))) list.push(g);
        personaStore.save(this.config, { mutedGroups: list });
        this.logger && this.logger.info('[admin] 群禁言：' + g);
        return say(`好，以后不在「${g}」群里说话了。（想恢复就发：解除禁言 ${g}）`);
      }
    }
    if (/^(?:所有群禁言|全部群禁言|只在私聊说话)$/.test(text)) {
      personaStore.save(this.config, { mutedGroups: ['*'] });
      return say('好，所有群都不说话了，只陪你私聊。');
    }
    if ((mg = mt.match(/^(?:解除禁言|取消禁言|允许)\s*(.+?)(?:了|啦|啊|吧|嘛)?[。.!！~～]*$/))
        || (mg = mt.match(/^解禁\s*(.+?)$/))
        || (mg = mt.match(/^解开\s*(.+?)\s*(?:群)?\s*的?禁言$/))
        || (mg = mt.match(/^解除对\s*(.+?)\s*的?禁言$/))
        || (mg = mt.match(/^让\s*(.+?)\s*(?:群)?\s*(?:可以|能)\s*说话$/))
        || (mg = mt.match(/^(?:恢复|放开)\s*(?!默认|语态|人设)(.+?)\s*(?:群)?\s*(?:说话)?$/))) {
      const g = String(mg[1]).replace(/[「」"'“”]/g, '').trim();
      const list = (Array.isArray(this.config.group.mutedGroups) ? this.config.group.mutedGroups : []).filter((x) => !nameMatches(x, g) && x !== '*');
      personaStore.save(this.config, { mutedGroups: list });
      return say(`好，「${g}」群恢复说话了。`);
    }
    if (/^(?:解除禁言|解开禁言|解禁|解除所有禁言|取消所有禁言)$/.test(text)) {
      personaStore.save(this.config, { mutedGroups: [] });
      return say('所有群的禁言都解开了。');
    }
    if (/^(?:解除所有群禁言|全部恢复|允许所有群)$/.test(text)) {
      personaStore.save(this.config, { mutedGroups: [] });
      return say('所有群都恢复说话了。');
    }

    // —— 上下文长度 / 人味开关 ——
    let mm2;
    if ((mm2 = text.match(/^(?:上下文|记忆长度|记忆条数)\s*(\d{1,3})$/))) {
      const n = Math.max(6, Math.min(120, Number(mm2[1])));
      const groupN = Math.min(n, 100);
      personaStore.save(this.config, { historyTurns: n, groupHistoryTurns: groupN });
      return say(`上下文长度改成 ${n} 条（群聊 ${groupN} 条）。`);
    }
    if ((mm2 = text.match(/^上下文\s*(短|中|长)$/))) {
      const map = { 短: 16, 中: 48, 长: 96 };
      const n = map[mm2[1]];
      const groupN = Math.min(n, 100);
      personaStore.save(this.config, { historyTurns: n, groupHistoryTurns: groupN });
      return say(`上下文调成「${mm2[1]}」：私聊 ${n} 条、群聊 ${groupN} 条。`);
    }
    if ((mm2 = text.match(/^(?:情绪|心情)\s*(开|打开|关|关闭)$/))) {
      const on = /开/.test(mm2[1]);
      personaStore.save(this.config, { emotions: on });
      return say(on ? '好，会带情绪说话。' : '好，语气收平，不太表露情绪。');
    }
    if ((mm2 = text.match(/^(?:主动|主动关心|主动找话题)\s*(开|打开|关|关闭)$/))) {
      const on = /开/.test(mm2[1]);
      personaStore.save(this.config, { proactive: on });
      return say(on ? '好，会主动关心你、接话题。' : '好，不主动找话题了，你问什么答什么。');
    }
    if ((mm2 = text.match(/^(?:观点|立场|主见)\s*(开|打开|关|关闭)$/))) {
      const on = /开/.test(mm2[1]);
      personaStore.save(this.config, { opinions: on });
      return say(on ? '好，会有自己的看法，也敢不同意你。' : '好，不输出立场，顺着你说。');
    }
    if ((mm2 = text.match(/^(?:互怼|骂主人|顶嘴|允许顶嘴)\s*(开|打开|关|关闭)$/))) {
      const on = /开/.test(mm2[1]);
      personaStore.save(this.config, { masterRoast: on });
      return say(on
        ? '行，那你骂我我就回嘴了，不带脏字那种。'
        : '好，那我挨骂就受着，不还口了。');
    }
    if ((mm2 = text.match(/^人味\s*(高|中|低)$/))) {
      const level = mm2[1];
      const patch = level === '高'
        ? { emotions: true, proactive: true, opinions: true }
        : level === '中'
          ? { emotions: true, proactive: false, opinions: true }
          : { emotions: false, proactive: false, opinions: false };
      personaStore.save(this.config, patch);
      return say(`人味调到「${level}」：${level === '高' ? '有情绪、会主动、有自己观点' : level === '中' ? '有情绪和观点，但不主动找话' : '平铺直叙，不主动、不表态'}`);
    }

    // —— 语态 / 长短 / 颜文字 / 能力（微信里直接调，持久保存） ——
    let mm;
    if ((mm = text.match(/^(?:语态|说话方式|风格|人设)\s*[:：]?\s*([\s\S]{1,120})$/))) {
      const v = mm[1].trim();
      personaStore.save(this.config, { text: v });
      this.logger && this.logger.info('[admin] 语态调整：' + v);
      return say(`好，说话方式记下了：${v}（一直生效，重启也保留）`);
    }
    if ((mm = text.match(/^(?:语气|口吻)\s*(温柔|活泼|可爱|高冷|毒舌|正经|抽象)$/))) {
      const map = {
        温柔: '温柔软一点，句子短，别端着',
        活泼: '活泼一点，多用语气词，可以开玩笑',
        可爱: '可爱一点，稍微卖萌但不腻',
        高冷: '高冷一点，话少、不主动卖萌、不撒娇',
        毒舌: '嘴可以毒一点，吐槽犀利但不人身攻击',
        正经: '正经一点，少用网络用语和颜文字',
        抽象: '短句、玩梗、装傻、游戏黑话，能五个字说完就别十个字',
      };
      personaStore.save(this.config, { preset: mm[1], text: map[mm[1]] });
      this.logger && this.logger.info('[admin] 语气切到 ' + mm[1]);
      return say(`语气切成「${mm[1]}」了：${map[mm[1]]}`);
    }
    if ((mm = text.match(/^(?:长度|字数)\s*(私聊|群聊)\s*([0-9]{2,4})$/))) {
      const n = Math.max(20, Math.min(600, Number(mm[2])));
      const patch = mm[1] === '私聊' ? { privateMaxChars: n } : { groupMaxChars: n };
      personaStore.save(this.config, patch);
      return say(`${mm[1]}回复上限改成 ${n} 字了。`);
    }
    if (/^回复\s*(短一点|再短点|长一点|再长点)$/.test(text)) {
      const shorter = /短/.test(text);
      const d = this.config.chat;
      const pv = shorter ? Math.max(40, Math.round(d.privateMaxChars * 0.7)) : Math.min(400, Math.round(d.privateMaxChars * 1.3));
      const gv = shorter ? Math.max(20, Math.round(d.groupMaxChars * 0.7)) : Math.min(150, Math.round(d.groupMaxChars * 1.3));
      personaStore.save(this.config, { privateMaxChars: pv, groupMaxChars: gv });
      return say(`好，${shorter ? '短' : '长'}一点：私聊 ${pv} 字、群聊 ${gv} 字。`);
    }
    if ((mm = text.match(/^颜文字\s*(关|少|正常|多)$/))) {
      personaStore.save(this.config, { emoji: mm[1] });
      return say(`颜文字用量：${mm[1]}。`);
    }
    if ((mm = text.match(/^能力\s*(链接|链接阅读|主动接话|群聊主动接话)\s*(开|打开|关|关闭)$/))) {
      const on = /开/.test(mm[2]);
      if (/链接/.test(mm[1])) {
        personaStore.save(this.config, { links: on });
        return say(`链接阅读已${on ? '打开' : '关闭'}。`);
      }
      personaStore.save(this.config, { freeChat: on });
      return say(`群聊主动接话已${on ? '打开' : '关闭'}。`);
    }
    if (/^(恢复默认|重置语态|恢复人设|清空设定)$/.test(text)) {
      personaStore.clear(this.config);
      this.logger && this.logger.info('[admin] 人设与能力恢复默认');
      return say('人设和能力的自定义都清空了，恢复默认。');
    }

    if (/^(状态|管理状态|查看状态)$/.test(text)) {
      const s = this.store.summary();
      const mock = this.llm.isMock;
      const muted = this.config.group.mutedGroups || [];
      return say(
        `管理员在线（剩 ${remaining} 分钟）｜模型：${mock ? '演示模式' : this.llm.providerLabel + ' · ' + this.llm.model}` +
        `｜记忆：${s.sessions} 个聊天 / ${s.messages} 条消息` +
        `｜上下文：${this.config.chat.historyTurns} 条` +
        `｜语态：${this.config.persona.stylePreset || '默认'}${this.config.persona.styleText ? '（' + this.config.persona.styleText.slice(0, 12) + '）' : ''}` +
        `｜人味：情绪${this.config.persona.emotions === false ? '关' : '开'}/主动${this.config.persona.proactive === false ? '关' : '开'}/观点${this.config.persona.opinions === false ? '关' : '开'}` +
        `｜长短：私聊${this.config.chat.privateMaxChars}/群聊${this.config.chat.groupMaxChars}字` +
        `｜禁言群：${muted.length ? muted.map((x) => (x === '*' ? '所有群' : x)).join('、') : '无'}` +
        `｜链接：${!this.config.links || this.config.links.enabled !== false ? '开' : '关'}`
      );
    }
    if (/^(管理)?帮助$/.test(text)) {
      return say('管理员命令：状态 / 上下文 20 / 人味 高|中|低 / 情绪 开|关 / 主动 开|关 / 观点 开|关 / 语态 <描述> / 语气 温柔|活泼|高冷|毒舌|正经 / 长度 私聊 120 / 回复 短一点 / 颜文字 少|多|关 / 能力 链接 开|关 / 能力 主动接话 开|关 / 改模型 <模型名> / 演示模式 开|关 / 重置记忆 / 清空所有记忆 / 恢复默认 / 退出管理');
    }
    if (/^演示模式\s*(开|打开|关|关闭|关掉)$/.test(text)) {
      const on = /开/.test(text);
      try { saveSettings(this.config, { mock: on }); } catch { /* 测试环境无路径 */ }
      this.llm.reload();
      this.logger && this.logger.info(`[admin] 演示模式 ${on ? '开' : '关'}`);
      return say(on ? '演示模式已打开：接下来用内置台词，不调用模型。' : `演示模式已关闭：用真模型 ${this.llm.model} 说话。`);
    }
    const m = text.match(/^(?:改模型|换模型|模型)\s+([A-Za-z0-9._\-\/:]{2,60})$/);
    if (m) {
      const model = m[1];
      // deepseek-* 自动切到 DeepSeek 官方接口，qwen-* 切回百炼，省得还要单独改服务商
      const lower = model.toLowerCase();
      let provider = '';
      let baseUrl = '';
      if (lower.startsWith('deepseek')) { provider = 'deepseek'; baseUrl = 'https://api.deepseek.com'; }
      else if (lower.startsWith('qwen') || lower.startsWith('qwq')) { provider = 'qwen'; baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1'; }
      else if (lower.startsWith('glm')) { provider = 'zhipu'; baseUrl = 'https://open.bigmodel.cn/api/paas/v4'; }
      try {
        saveSettings(this.config, provider ? { provider, model, baseUrl, mock: false } : { model, mock: false });
      } catch { /* ignore */ }
      this.llm.reload();
      this.logger && this.logger.info(`[admin] 模型切到 ${model}${provider ? '（服务商 ' + provider + '）' : ''}`);
      return say(`模型已切到 ${model}（服务：${this.llm.providerLabel}）。`);
    }
    // 「接 deepseek / 用千问 / 切智谱」：切换服务商，Key 从各自存档里取
    const providerAlias = {
      ds: 'deepseek', deepseek: 'deepseek', 深度求索: 'deepseek',
      qwen: 'qwen', 千问: 'qwen', 通义: 'qwen', 通义千问: 'qwen',
      glm: 'zhipu', zhipu: 'zhipu', 智谱: 'zhipu',
      siliconflow: 'siliconflow', 硅基: 'siliconflow', 硅基流动: 'siliconflow',
      ollama: 'ollama', 本地: 'ollama',
    };
    const pm = text.match(/^(?:接|用|切到|换成|切换到)?\s*([A-Za-z\u4e00-\u9fff]{1,12})(?:\s*(?:chat|v3|flash|plus))?$/i);
    if (pm) {
      const target = providerAlias[pm[1].toLowerCase()] || providerAlias[pm[1]];
      if (target) {
        const preset = { deepseek: ['https://api.deepseek.com', 'deepseek-chat'], qwen: ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'], zhipu: ['https://open.bigmodel.cn/api/paas/v4', 'glm-4-flash'], siliconflow: ['https://api.siliconflow.cn/v1', 'Qwen/Qwen2.5-7B-Instruct'], ollama: ['http://127.0.0.1:11434/v1', 'qwen2.5:7b'] }[target];
        try { saveSettings(this.config, { provider: target, baseUrl: preset[0], model: preset[1], mock: false }); } catch { /* ignore */ }
        this.llm.reload();
        this.logger && this.logger.info(`[admin] 切到服务商 ${target}`);
        const ok = !this.llm.isMock;
        return say(ok
          ? `好，切到 ${this.llm.providerLabel}，模型 ${this.llm.model}。`
          : `好，切到 ${this.llm.providerLabel} 了，但还没有这个服务的 Key：去设置页填，或把 Key 发我。`);
      }
    }
    if (/^(?:群聊)?主动接话\s*(开|打开|关|关闭|关掉)$/.test(text)) {
      const on = /开/.test(text);
      this.config.group.freeChat = on;
      this.logger && this.logger.info(`[admin] 群聊主动接话 ${on ? '开' : '关'}`);
      return say(on ? '群聊主动接话已打开（按概率接话，仍受冷却限制）。' : '群聊主动接话已关闭。');
    }
    if (/^重置记忆$/.test(text)) {
      this.store.resetSession(key);
      return say('这个聊天的记忆已清空。');
    }
    if (/^清空所有记忆$/.test(text)) {
      this.store.resetAll();
      return say('所有聊天的记忆已清空。');
    }
    if (/禁言|群.*(别说|不要|安静)|不要在.*群/.test(text)) {
      return say('这句我没听明白。改成「禁言 鼠标」或者「别在鼠标群说话」试试。');
    }
    if (/^(退出管理|结束管理|关闭管理|收起魔咒)$/.test(text)) {
      state.adminUntil = 0;
      this.store.markDirty();
      this.logger && this.logger.info('[admin] 管理员权限已关闭');
      return say('管理员权限已关闭。');
    }
    return null;
  }

  runCommand({ command, msg, key, profile, state, nowMs, atMe }) {
    const g = this.config.group;
    const finish = (text, extra = {}) => ({ action: 'command', commandType: command.type, key, msg, atMe, text, reason: 'command', ...extra });
    switch (command.type) {
      case 'help':
        return finish(COMMAND_HELP);
      case 'status': {
        const summary = this.store.summary();
        const mood = persona.moodFor(new Date(nowMs));
        const mode = this.llm.isMock ? '演示模式（未配置 API Key）' : `DeepSeek ${this.llm.model}`;
        return finish(
          `咕噜~ 人家现在心情${mood.name}，脑子用${mode}，记得 ${summary.sessions} 个聊天、${summary.notes} 条关于大家的小事。尾巴状态：良好。`
        );
      }
      case 'reset': {
        this.store.resetSession(key);
        return finish('呜…刚才的聊天人家忘掉啦（只清掉这个聊天框的记忆哦）🫧');
      }
      case 'memory': {
        const rows = this.store.listNotes(key);
        const mine = profile.notes || [];
        if (!rows.length && !mine.length) {
          return finish('人家还什么都没记住呢。想让我记住就说「记住：你怕黑」这种，我就能记好久…大概。');
        }
        const parts = rows.map((r) => `${r.name}——${r.notes.join('；')}`);
        return finish(`本鲸的小本本：${parts.join('｜')}`.slice(0, 400));
      }
      case 'remember': {
        if (!command.arg) return finish('记住什么呀？说「记住：你爱吃辣」这样，人家才记得住 (｡•̀ᴗ-)✧');
        const kind = /答应|明天|后天|下周|要记着|别忘|提醒/.test(command.arg)
          ? 'promise'
          : (/不喜欢|讨厌|别|怕|雷/.test(command.arg) ? 'taboo' : 'fact');
        const notes = this.store.addNote(key, msg.senderId, command.arg, { kind });
        return finish(`记住啦：${command.arg}。本鲸的记忆有 ${notes.length} 格，还够用~`);
      }
      case 'forget': {
        const { removed } = this.store.removeNote(key, msg.senderId, command.arg);
        return finish(removed ? `好，忘掉「${command.arg}」了。…刚刚是不是有人说话？` : '人家本来就没记这个呀，是不是记错鲸了？');
      }
      case 'name': {
        if (!command.arg) return finish('那你想让人家叫你什么？说「叫我小海」这样就行。');
        this.store.setNickname(key, msg.senderId, command.arg);
        return finish(`好呀，以后就叫你「${command.arg}」啦，写进小本本了 (｡•̀ᴗ-)✧`);
      }
      case 'mute': {
        const minutes = clampInt(command.arg || g.muteDefaultMinutes, 1, 1440, g.muteDefaultMinutes);
        this.store.setMuted(key, minutes * 60000);
        return finish(`好…人家闭嘴 ${minutes} 分钟，有急事就 @ 我，我会偷偷看一眼的（尾巴缩起来）`);
      }
      case 'unmute': {
        this.store.setMuted(key, 0);
        return finish('咕噜！人家回来了~ 想我了吗？');
      }
      default:
        return finish(COMMAND_HELP);
    }
  }

  /**
   * 流式生成回复文本片段（含演示模式）。
   */
  async *generate(decision, { signal } = {}) {
    if (decision.action === 'command') {
      yield decision.text;
      return;
    }
    if (decision.canned) {
      yield decision.canned;
      return;
    }
    if (decision.mock) {
      const text = decision.text || '';
      for (let i = 0; i < text.length; i += 2) {
        if (signal && signal.aborted) return;
        yield text.slice(i, i + 2);
        if (this.mockChunkDelayMs > 0) await sleep(this.mockChunkDelayMs);
      }
      return;
    }
    for await (const piece of this.llm.stream({ system: decision.system, turns: decision.turns, signal })) {
      yield piece;
    }
  }

  /** 偶尔在句尾补一个 emoji 或颜文字（由「颜文字用量」档位决定概率） */
  pickEmoji(text) {
    // 吵架大赛模式不发表情：正在喷人突然来个 🍚 很出戏
    const chance = (persona.fightModeOn && persona.fightModeOn(this.config)) ? 0 : persona.emojiChanceFor(this.config);
    if (!chance) return text;
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) return text;
    if (this.rng() > chance) return text;
    // 一半颜文字、一半 emoji：以前只有 emoji，所以调「颜文字」也看不到颜文字
    if (this.rng() < 0.5) return text + ' ' + persona.kaomojiPick(this.rng);
    const list = ['🐋', '🥺', '😭', '✨', '💧', '🫧'];
    return text + ' ' + list[Math.floor(this.rng() * list.length)];
  }

  /** 写入鲸鲸自己的回复，返回气泡数组 */
  /**
   * 这条回复要不要补一张表情包（实验性）。
   * 总闸关着直接返回 null，调用方不用判断。
   * @returns {{emotion: string, path: string}|null}
   */
  stickerFor(decision, text, request = '') {
    if (!stickers.isOn(this.config) || !this.stickerService) return null;
    const msg = (decision && decision.msg) || {};
    try {
      return this.stickerService.plan(msg, text, request);
    } catch (err) {
      if (this.logger) this.logger.warn('挑表情包失败：' + (err && err.message ? err.message : err));
      return null;
    }
  }

  finalize(decision, text, { error = false } = {}) {
    text = String(text == null ? '' : text).trim();
    // 正文里的 emoji 剥出来，单独发一条
    const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/gu;
    const foundEmoji = (text.match(emojiRe) || []).join('');
    if (foundEmoji) text = text.replace(emojiRe, '').replace(/[ \t]+$/g, '').trim();
    // 去掉波浪号、句号、感叹号，像真人打字一样干净
    text = text.replace(/[~～]+/g, '').replace(/[。！!]+/g, '。').replace(/[ \t]{2,}/g, ' ').trim();
    // 脏话换成年轻人的说法（对喷时保留原样，不然吵起来没劲）
    const fighting = Boolean(decision && decision.msg && decision.msg.fight) || (decision && decision.reason === 'clapback');
    if (!fighting) {
      text = text.replace(/我操|我靠|草泥马|操你/g, '我去').replace(/卧槽|卧超|我超|我焯|我擦/g, '我去，').replace(/^草[，,\\s]?/g, '我去');
    }
    // 弱模型爱说客服话，直接掐掉（免费模型尤其明显）
    const serviceTone = /(有什么(我)?能?可以?帮(你|您)的?吗?|需要我帮(你|您)|希望(这)?能帮到你|还有什么可以帮|作为一个(?:AI|语言模型)|随时告诉我)/;
    if (serviceTone.test(text) && !fighting) {
      const kept = text.split(/[，,。；;\n]/).map((s) => s.trim()).filter((s) => s && !serviceTone.test(s)).join('，').trim();
      if (kept.length >= 2) text = kept;
    }
    // 对方没聊吃的，就别把话题硬拐到米饭上；整条都在说饭就干脆不发
    const riceRe = /(大白饭|白米饭|米饭)/;
    const foodTopic = /(吃|饭|饿|干饭|外卖|好吃|零食|宵夜|早餐|午餐|午饭|晚餐|晚饭|食堂|菜|煮|炒|泡面|下厨|厨)/;
    const userText = String((decision && decision.msg && (decision.msg.cleanText || decision.msg.text)) || '');
    if (riceRe.test(text) && !foodTopic.test(userText)) {
      const kept = text.split(/[，,。；;\n]/).map((s) => s.trim()).filter((s) => s && !riceRe.test(s)).join('，').trim();
      text = kept.length >= 2 ? kept : '';
    }
    // 对喷时不许认输：模型一旦说软话，换成库里的狠话
    if (fighting && persona.SOFT_FIGHT_RE.test(text)) {
      const dirty = Boolean(decision && decision.msg && decision.msg.fightDirty);
      const line = persona.clapbackPick(dirty ? ['重', '爹味', '反问'] : ['轻', '典', '反问'], this.rng);
      if (line) text = line;
    }
    if (!decision || !decision.key || !text) return [];
    // handle() 要用最终文本当 reply，否则「软话被换掉」对外还是原文
    decision.finalText = text;
    // 最后的兜底：还在复读就整句重来，不能把别人的话或自己上一句原样发回去
    const heardList = (decision && decision.heardList) || [String((decision && decision.msg && (decision.msg.cleanText || decision.msg.text)) || '')];
    const ownList = (decision && decision.ownList) || [];
    if (heardList.some((h) => isEcho(text, h)) || ownList.some((h) => isEcho(text, h))) {
      const fightingNow = Boolean(decision && decision.msg && decision.msg.fight);
      const line = fightingNow
        ? persona.clapbackPick(['重', '爹味', '反问'], this.rng)
        : (this.rng() < 0.5 ? '你说呢' : '这话我听着都替你尴尬');
      if (line) text = line;
      decision.finalText = text;
    }
    const msg = decision.msg || {};
    // L3：开火了却说不清对方骂了啥（没引用原话片段）→ 大概率是自作多情，降级成一句「？」
    // 只对「没被叫到、只在群里听到脏话就开火」的情况做原话校验；
    // @她/点名的对喷不需要证明，别再把她嘴堵上。
    const autoFight = Boolean(msg.fight) && !msg.isMaster && String(msg.fightReason || '') === 'insulted';
    // 只在「连她名字都没提」的自动开火时校验；点名了就是在说她，别把人嘴堵上
    if (autoFight && !namedHerIn(msg.cleanText || msg.text || '') && features.isOn(this.config, 'fightQuoteCheck')) {
      const rawHeard = String(msg.cleanText || msg.text || '');
      const norm = (x) => String(x || '').replace(/[\s\p{P}\p{S}]/gu, '');
      const heardCore = norm(rawHeard);
      const replyCore = norm(text);
      let hit = false;
      for (let i = 0; i + 3 <= heardCore.length; i += 1) {
        if (replyCore.includes(heardCore.slice(i, i + 3))) { hit = true; break; }
      }
      if (!hit) {
        this.logger && this.logger.warn('开怼缺少原话依据，降级为「？」：' + String(text).slice(0, 30));
        text = '？';
        decision.finalText = text;
      }
    }
    // 主人告状说有人骂他：她在替主人出头，骂的是别人，不适用「对主人不许带脏字」
    if (msg.fightTarget && msg.fightTarget.name) {
      const name = msg.fightTarget.name;
      if (!String(text).includes(name)) {
        const attack = persona.clapbackPick(['重', '爹味', '反问'], this.rng) || '你算什么东西';
        text = `${name}，${attack}`;
        decision.finalText = text;
      }
    } else if (msg.isMaster) {
      const roastOn = Boolean(this.config.persona && this.config.persona.masterRoast);
      // 只有主人真的在数落她时才互怼；主人说「我生气了」这种要哄
      const masterSaid = String((decision.msg && (decision.msg.cleanText || decision.msg.text)) || '');
      const scolded = /(笨|傻|蠢|演我|废物|垃圾|烦|滚|闭嘴|特么|没用|不行|慢|搞错|到底|说了几遍)/.test(masterSaid);
      const rude = roastOn
        ? /(你妈|你爹|你他妈|他妈|傻逼|婊|操你|去死)/
        : /(你妈|你爹|你他妈|他妈|傻逼|狗东西|废物|滚蛋|滚出去|闭上你的嘴|没教养)/;
      const apology = /(对不起|抱歉|我错了|我知道错了|我知错|是我不对|下次一定|是我没做好|我会努力)/;
      const tooHostile = /(你算老几|贵物|小丑|废物|滚蛋|滚出去|闭嘴)/;
      const pickRoast = () => {
        const lines = persona.MASTER_ROAST_LINES || [];
        return lines.length ? lines[Math.floor(this.rng() * lines.length)] : '主人你骂我也没用，活儿还得我干';
      };
      // 已经按 ID 认证过主人，就不许再把 TA 当外人：
      // 模型偶尔还会顺着旧语气说「不是」「冒充」「就一个名字罢了」，直接改成认下来
      const denyMaster = /(不是你的?主人|不是你就对|冒充|自封|没你这号|认主系统|系统.{0,6}不认|不认你|就一个名字|光说没用|凭什么信你)/;
      if (denyMaster.test(text)) {
        this.logger && this.logger.warn('对主人说了否认身份的话，改掉：' + String(text).slice(0, 30));
        text = '是我主人啊，这还用问。';
        decision.finalText = text;
      }
      if (rude.test(text)) {
        this.logger && this.logger.warn('对主人回嘴越线，改掉：' + String(text).slice(0, 30));
        text = roastOn && scolded ? pickRoast() : '主人你骂我我也得听着，这次是我没做好';
        decision.finalText = text;
      } else if (roastOn && scolded && (apology.test(String(text)) || tooHostile.test(String(text)))) {
        // 主人在数落她，她却在道歉、或者骂得像仇人，换成撒泼式回嘴
        this.logger && this.logger.warn('主人让互怼，但语气不对，换掉：' + String(text).slice(0, 30));
        text = pickRoast();
        decision.finalText = text;
      }
    }
    this.store.appendMessage(decision.key, {
      role: 'assistant',
      name: this.config.persona.name,
      text,
      ts: this.now().getTime(),
      error,
    });
    const isGroup = msg.chatType === 'group';
    if (decision.action === 'command') return [text];
    const maxBubbles = Math.max(1, Number(this.config.chat.maxBubbles) || 2);
    const maxChars = msg.discussion ? (this.config.chat.discussionMaxChars || 400) : (isGroup ? this.config.chat.groupMaxChars : this.config.chat.privateMaxChars);
    let bubbles;
    if (decision.action === 'reply') {
      // 按逗号/句号拆成几条短消息，每条不带标点
      const clauses = (text.match(/[^，。！？!?；;\n]+/g) || [])
        .map((s) => s.trim().replace(/^[，。！？!?；;]+|[，。！？!?；;~～…]+$/g, ''))
        .filter(Boolean);
      if (clauses.length > 1 && clauses.length <= maxBubbles) {
        bubbles = clauses;
      } else {
        bubbles = persona.splitBubbles(text, { maxChars, maxBubbles })
          .map((b) => String(b || '').trim().replace(/[~～]+$/g, '').replace(/[。！!…]+$/g, ''))
          .filter(Boolean);
      }
    } else {
      bubbles = persona.splitBubbles(text, { maxChars, maxBubbles }).map((b) => String(b || '').trim()).filter(Boolean);
    }
    // emoji / 颜文字单独一条发，不粘在句末（概率由「颜文字用量」档位决定）
    const chance = persona.emojiChanceFor(this.config);
    if (!error && decision.action === 'reply' && chance > 0) {
      let extra = '';
      if (foundEmoji) extra = foundEmoji;
      else if (this.rng() <= chance) {
        // 颜文字和 emoji 各一半，这样「颜文字用量」调高后真的能看到颜文字
        extra = this.rng() < 0.5
          ? persona.kaomojiPick(this.rng)
          : ['🐋', '🥺', '😭', '✨', '💧', '🫧', '🍚'][Math.floor(this.rng() * 7)];
      }
      if (extra) {
        // 遵守 maxBubbles：气泡已经满了就并到最后一条，别偷偷多发一条
        if (bubbles.length < maxBubbles) bubbles.push(extra);
        else if (bubbles.length) bubbles[bubbles.length - 1] = (bubbles[bubbles.length - 1] + ' ' + extra).trim();
      }
    }
    return bubbles;
  }

  /**
   * 非流式的完整处理，给微信/抖音网关用。
   * @returns {{action: string, reply?: string, bubbles?: string[], reason: string, commandType?: string}}
   */
  async handle(rawMsg, { signal } = {}) {
    let decision;
    try {
      decision = await this.decide(rawMsg);
    } catch (err) {
      this.logger && this.logger.error('处理消息出错：' + (err && err.stack ? err.stack : err));
      return { action: 'ignore', reason: 'error' };
    }
    if (decision.action === 'ignore') {
      return { action: 'ignore', reason: decision.reason };
    }
    if (decision.action === 'command') {
      const bubbles = this.finalize(decision, decision.text);
      return { action: 'reply', reply: decision.text, bubbles, reason: 'command', commandType: decision.commandType };
    }
    let text = '';
    try {
      if (decision.canned) {
        text = decision.canned;
      } else if (decision.mock) {
        text = decision.text;
      } else {
        text = await this.llm.complete({ system: decision.system, turns: decision.turns });
        // 模型有时候只会把别人说过的话复读一遍，或者重复自己上一句，这种重写一次
        const heardList = this.recentHeard(decision);
        const ownList = this.recentOwn(decision);
        decision.heardList = heardList;
        decision.ownList = ownList;
        const repeatsSomeone = heardList.some((h) => isEcho(text, h));
        const repeatsSelf = ownList.some((h) => isEcho(text, h));
        if (repeatsSomeone || repeatsSelf) {
          const why = repeatsSelf ? '在重复你自己刚才说过的话' : '在复读别人的话';
          this.logger && this.logger.warn('回复' + why + '，重写一次：' + String(text).slice(0, 30));
          try {
            const retry = await this.llm.complete({
              system: decision.system + '\n\n【重写要求】你刚才的回答' + why + '，不合格。现在重写：换一个说法，给出新的信息或明确态度；不能出现对方原句，也不能重复你上面说过的话。',
              turns: decision.turns,
            });
            if (retry && !heardList.some((h) => isEcho(retry, h)) && !ownList.some((h) => isEcho(retry, h))) text = retry;
            else text = retry || text;
          } catch { /* 重写失败就沿用原文，后面还有兜底 */ }
        }
      }
    } catch (err) {
      const rawMsg = String((err && err.message) || '');
      const blocked = /敏感|不安全|安全|内容/.test(rawMsg) && /400/.test(rawMsg);
      this.logger && this.logger.error('生成回复失败：' + (err && err.message));
      let retried = null;
      // 钥匙失效 / 额度用完（429）/ 模型名不可用（404）→ 切到存过 Key 的备用服务商再试一次。
      // 千问的 qwen-turbo 免费额度经常先耗尽，用户会以为「Key 不能用」，这里直接兜住。
      const canFallback =
        /401|invalid|api key|Unauthorized|密钥|令牌/i.test(rawMsg) ||
        /\b429\b|rate.?limit|exceeded your current request limit/i.test(rawMsg) ||
        (/\b404\b/.test(rawMsg) && /model/i.test(rawMsg));
      if (canFallback && typeof this.llm.switchFallback === 'function') {
        const switched = this.llm.switchFallback();
        if (switched) {
          try {
            retried = await this.llm.complete({ system: decision.system, turns: decision.turns });
            this.logger && this.logger.warn(`已切到备用服务商 ${switched.label} 并重试成功`);
          } catch (err2) {
            this.logger && this.logger.error('备用服务商也失败了：' + (err2 && err2.message));
          }
        }
      }
      if (!retried && blocked) {
        try {
          const sys = sanitizeForModel(decision.system || '');
          const cur = sanitizeForModel((decision.msg && (decision.msg.cleanText || decision.msg.text)) || '');
          retried = await this.llm.complete({ system: sys, turns: cur ? [{ role: 'user', content: cur }] : [] });
          this.logger && this.logger.warn('内容审核拦截，已丢掉历史用精简上下文重试成功');
        } catch (err2) {
          this.logger && this.logger.error('精简重试仍失败：' + (err2 && err2.message));
        }
      }
      if (retried) {
        text = retried;
      } else {
        const friendly = blocked
          ? '这话我不敢接，换个说法'
          : (err instanceof LlmError ? err.userMessage : '呜…深海线路打结了，等会儿再来找人家嘛');
        this.finalize(decision, friendly, { error: true });
        return { action: 'reply', reply: friendly, bubbles: [friendly], reason: 'llm_error', error: true };
      }
    }
    text = String(text == null ? '' : text).trim();
    const bubbles = this.finalize(decision, text);
    if (!bubbles.length) return { action: 'ignore', reason: 'empty_reply' };
    // 群里骂人时要真 @ 到对方：优先用靶子，其次看正文开头有没有 @名字
    const finalText = decision.finalText || text;
    const atMatch = finalText.match(/^@\s*([^\s，,：:！!？?。]+)/);
    const mention = (decision.msg && decision.msg.fightTarget && decision.msg.fightTarget.name)
      || (atMatch ? atMatch[1] : '');
    // 攒够一批消息就让后台整理记忆（摘要 + 抽事实），不阻塞这条回复
    this.maybeDigest(decision.key, (decision.msg && decision.msg.senderId) || '');
    return {
      action: 'reply',
      reply: finalText,
      bubbles,
      mention: decision.msg && decision.msg.chatType === 'group' ? mention : '',
      reason: decision.reason,
      mock: decision.mock,
    };
  }

  /** 记忆整理：攒够一批消息就压摘要 + 抽事实，异步跑，失败不影响聊天 */
  maybeDigest(key, uid) {
    if (!this.llm || this.llm.isMock) return;
    if (!features.isOn(this.config, 'memoryDigest')) return;
    if (_digestInFlight.has(key)) return;
    _digestInFlight.add(key);
    const every = Number(this.config.memory && this.config.memory.digestEvery) || 12;
    Promise.resolve()
      .then(() => memoryDigest.digest(this.store, this.llm, key, { uid, logger: this.logger, every }))
      .then((done) => { if (done) this.store.sweep(); })
      .catch(() => null)
      .then(() => _digestInFlight.delete(key));
  }

  /** 切换 API Key 后调用 */
  reload() {
    if (this.llm && this.llm.reload) this.llm.reload();
  }

  stats() {
    return {
      ...this.store.summary(),
      mock: this.llm.isMock,
      model: this.llm.model,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }
}

module.exports = { Bot, extractCommand, COMMAND_HELP };
