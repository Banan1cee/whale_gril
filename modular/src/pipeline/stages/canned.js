'use strict';

/**
 * 固定话术（canned）分支：命中就直接回一句，不调模型。
 *
 * 从 `pipeline/chat.js::decide()` 里原样搬出来的第一批。判断顺序、正则、返回字段
 * 都和原来一致 —— 这一步只挪位置，不改行为，所以 `tests/decide-snapshot.test.js`
 * 的快照能原样通过。
 *
 * 什么时候该放这里：**不需要模型、不需要上下文压缩、只靠一条正则就能决定**的回复。
 * 需要读历史/拼 prompt 的留在 decide() 里。
 */

const persona = require('../../persona');

/**
 * @param {object} bot  需要 bot.store / bot.config / bot.rng / bot.logger
 * @param {object} ctx
 * @param {object} ctx.msg
 * @param {string} ctx.text        清洗后的正文
 * @param {boolean} ctx.isGroup
 * @param {boolean} ctx.isMaster
 * @param {boolean} ctx.atMe
 * @param {object} ctx.state       会话状态（会写 consent / silentUntil 等）
 * @param {number} ctx.nowMs
 * @param {string} ctx.key
 * @returns {object|null} decision
 */
function cannedReply(bot, { msg, text, isGroup, isMaster, atMe, state, nowMs, key }) {
  const ask = String(text || '').trim();

  // 群成员名录
  if (isGroup && /(群里|群)?.{0,4}(都有谁|有谁|成员|谁最活跃)/.test(ask)) {
    const people = new Map();
    for (const m of bot.store.messages(key, 200)) {
      if (m.role === 'assistant' || !m.name) continue;
      people.set(m.name, (people.get(m.name) || 0) + 1);
    }
    const top = [...people.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const canned = top.length
      ? '群里常说话的就这些：' + top.map(([n, c]) => `${n}(${c})`).join('、')
      : '群里还没人说话';
    return { action: 'reply', key, msg, atMe, canned, reason: 'member_list' };
  }

  // 查自己的微信号（只告诉主人）
  if (/我(的)?微信(号)?(是)?(多少|啥|什么)/.test(ask)) {
    const canned = isMaster ? `你的微信号是 ${msg.senderId || '未知'}` : '这个不告诉你';
    return { action: 'reply', key, msg, atMe, canned, reason: 'self_wxid' };
  }

  // 「可以骂我吗」→ 记下 30 分钟授权
  if (/(可以|能)(损|骂)我|来(损|骂)我/.test(ask)) {
    state.consent = state.consent || {};
    state.consent[String(msg.senderName || msg.senderId || '')] = nowMs + 30 * 60000;
    return { action: 'reply', key, msg, atMe, canned: '行，那你别后悔', reason: 'consent' };
  }

  // 主人点名吐槽三句（对方必须先同意）
  if (isMaster && /(骂|损)/.test(ask) && /(三句|3句)/.test(ask)) {
    const m = ask.match(/@([^\s@]+)/);
    const target = m && m[1];
    if (!target) return { action: 'reply', key, msg, atMe, canned: '要骂谁？@他一下', reason: 'roast_no_target' };
    const until = Number((state.consent || {})[target] || 0);
    if (until <= nowMs) return { action: 'reply', key, msg, atMe, canned: `${target} 没同意，我不骂`, reason: 'roast_no_consent' };
    const three = [];
    // 主人点名吐槽走「轻」档：好笑但不下脏口，毕竟对方是自愿配合的
    for (let i = 0; i < 3; i += 1) {
      const line = persona.clapbackPick(['轻', '一般'], bot.rng);
      if (line && !three.includes(line)) three.push(line);
    }
    const canned = `@${target} ` + three.join('，');
    return { action: 'reply', key, msg, atMe, canned, reason: 'roast' };
  }

  // 「没你事儿了，走吧」→ 回一句就退场，之后不再接
  const dismissClean = ask.replace(/^[\s，,。.!！~～、]+|[\s，,。.!！~～、…]+$/g, '');
  const dismissHit =
    /(没你事儿|没你事了|没你事|这里没你事了|不关你事|不用你了|没问你|别接话)/.test(dismissClean) ||
    /(退下吧|一边去|忙你的去吧|去忙你的吧|你先去忙)/.test(dismissClean) ||
    (/(走了|走吧|散了|退下)/.test(dismissClean) && /(没你事|不用你|退下|一边去)/.test(dismissClean)) ||
    /^(你可以走了|你走吧|先退下吧|退下吧|退下|下去吧|走吧|走了|快走|行了你走吧)$/.test(dismissClean) ||
    /^(滚|滚蛋|滚开|滚出去|你滚|爬|爬开|走开|走远点|一边去|一边凉快去|哪凉快哪待着|消失|退下|下去|去忙你的|忙你的去|别在这|别在这碍眼|别烦我|别烦了|少说两句|别说了|闭嘴|安静|安静点|别吵|不需要你|不用你|没你事|没你事了|别接话|没问你)(?:吧|啊|呀|了|嘛|哦)*$/.test(dismissClean) ||
    // 第三人称：群里说「让她滚」「叫它闭嘴」「把机器人赶走」——也是在赶她走。
    // 以前只认「你滚/滚」这种直接命令，「让她滚」完全识别不到，于是不静默、还接着说话。
    // 只用「她 / 它 / 鲸鲸」这类明确指向她的词，别把「让他滚」（指别的男生）也当成赶她。
    /(让|叫|把|喊|请)(?:她|它|这货|这家伙|这玩意|这玩意儿|机器人|鲸鲸|小鲸|肥鱼|鲸)(?:赶紧|快点|马上)?(?:滚|滚蛋|滚开|滚出去|爬|走开|消失|退下|下去|闭嘴|安静|别说话|少说话|别接话|别插嘴|别吵|歇着)/.test(dismissClean);
  // 群友也能让她闭嘴（不用 @）：只要是在赶她走，就认。
  const dismissByGroup = isGroup && /(让她|叫她|让它|叫它|机器人|鲸鲸|小鲸|肥鱼)/.test(dismissClean);
  if (dismissHit && (isMaster || atMe || msg.replyToBot || !isGroup || dismissByGroup)) {
    state.engagedUntil = 0;
    state.engagedBy = '';
    state.dismissedAt = nowMs;
    state.silentUntil = nowMs + Math.max(1, Number(bot.config.group.silentMinutes) || 10) * 60000;
    return {
      action: 'reply',
      key,
      msg,
      atMe,
      canned: isMaster
        ? '好的主人，我走了'
        // 吵架大赛模式不接受「滚」：被赶更要顶回去，不许乖乖消失
        : (persona.fightModeOn && persona.fightModeOn(bot.config)
          ? persona.clapbackPick(['重', '反问'], bot.rng, bot.config)
          : persona.clapbackPick('叫滚', bot.rng, bot.config)),
      reason: 'dismissed',
    };
  }

  // 主人手动进入「休息模式」：回复先排队，等你回来
  if (isMaster && /^(?:我去玩了|去玩(?:了)?|我去打游戏(?:了)?|休息一下)$/.test(ask)) {
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      fs.writeFileSync(path.join(bot.config.paths.dataDir, 'away.json'), JSON.stringify({ until: Date.now() + 3 * 3600 * 1000, at: Date.now() }), 'utf8');
    } catch { /* ignore */ }
    bot.logger && bot.logger.info('[away] 主人去玩了，进入休息模式');
    return { action: 'command', commandType: 'away', key, msg, atMe: true, reason: 'away', text: '好，去玩吧，我先歇会儿，等你回来再聊～' };
  }
  if (isMaster && /^(?:我回来了|回来了|玩完了)$/.test(ask)) {
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      fs.unlinkSync(path.join(bot.config.paths.dataDir, 'away.json'));
    } catch { /* ignore */ }
    bot.logger && bot.logger.info('[away] 主人回来了，恢复回复');
    return { action: 'command', commandType: 'away_back', key, msg, atMe: true, reason: 'away', text: '欢迎回来～刚才的消息我慢慢补上。' };
  }

  return null;
}

module.exports = { cannedReply };
