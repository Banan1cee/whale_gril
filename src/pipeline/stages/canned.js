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
 *
 * 现在分成两步调用（M19）：
 *   dismissReply() —— 「让她滚/走吧/闭嘴」这类退场分支，chat.js 里**提前**调用：
 *       被赶走要先回一句再进静默，不能被静音/触发判断挡掉；
 *   cannedReply()  —— 其余固定话术，chat.js 里挪到**静音/禁言/限流闸门之后**调用：
 *       以前它们排在所有闸门前面，mute、禁言群、静默期、burst_limit 全挡不住。
 */

const persona = require('../../persona');

/** 授权条目的到期时间：兼容旧版「纯数字」存法和新版 { expires, name } 对象 */
function consentExpires(entry) {
  return Number(entry && typeof entry === 'object' ? entry.expires : entry) || 0;
}

/**
 * 吐槽授权表清理：删掉超过 30 分钟的过期键。
 * 以前这表只增不删，越聊越大（M26）；现在写入/读取时都顺手清一遍。
 */
function pruneConsent(consent, nowMs) {
  for (const k of Object.keys(consent)) {
    if (consentExpires(consent[k]) <= nowMs) delete consent[k];
  }
  return consent;
}

/**
 * 退场分支：「让她滚 / 走吧 / 闭嘴 / 安静」→ 回一句就进静默，之后不再接。
 * 必须在静音/禁言等闸门**之前**处理：被赶走也得先应一声，否则群里会永远没交代。
 *
 * @param {object} bot  需要 bot.store / bot.config / bot.rng / bot.logger
 * @param {object} ctx  同 cannedReply
 * @returns {object|null} decision
 */
function dismissReply(bot, { msg, text, isGroup, isMaster, atMe, state, nowMs, key }) {
  const ask = String(text || '').trim();

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
  return null;
}

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
  // 这些分支不看 atMe 就能触发，群里旁人随口一句话（子串就命中）会被误登记/误回答。
  // 群聊没 @ 不接，私聊照旧。
  const canAnswer = Boolean(atMe) || !isGroup;

  // 群成员发言次数排名已按用户要求删除：不再统计任何人说了几句，
  // 「群里都有谁 / 谁最活跃」交给模型正常回答。

  // 查自己的微信号（只告诉主人）
  if (canAnswer && /我(的)?微信(号)?(是)?(多少|啥|什么)/.test(ask)) {
    const canned = isMaster ? `你的微信号是 ${msg.senderId || '未知'}` : '这个不告诉你';
    return { action: 'reply', key, msg, atMe, canned, reason: 'self_wxid' };
  }

  // 「可以骂我吗」→ 记下 30 分钟授权。
  // 以前的坑（M26）：①按 senderName 存键，同名的人能冒用对方的授权；
  // ②授权表只增不删，越聊越大。现在键用 senderId（没有 id 才用昵称），
  // 昵称另外记进条目里供 @ 查找；写入时清掉超过 30 分钟的过期键。
  if (canAnswer && /(可以|能)(损|骂)我|来(损|骂)我/.test(ask)) {
    const consent = pruneConsent(state.consent = state.consent || {}, nowMs);
    const cid = String(msg.senderId || msg.senderName || '');
    consent[cid] = { expires: nowMs + 30 * 60000, name: String(msg.senderName || '') };
    return { action: 'reply', key, msg, atMe, canned: '行，那你别后悔', reason: 'consent' };
  }

  // 主人点名吐槽三句（对方必须先同意）
  if (canAnswer && isMaster && /(骂|损)/.test(ask) && /(三句|3句)/.test(ask)) {
    // @ 捕获收紧（M26）：以前 @[^\s@]+ 太贪，「@小明骂他三句」把整句尾巴吞进 target，
    // 授权键对不上、提示里还带着半句话。
    const m = ask.match(/@([^\s@，,。!？?]+)/);
    const target = m && m[1];
    if (!target) return { action: 'reply', key, msg, atMe, canned: '要骂谁？@他一下', reason: 'roast_no_target' };
    // 键是 senderId：@ 到的通常是昵称，直接查键查不到，再按登记时的昵称找一次
    const consent = pruneConsent(state.consent = state.consent || {}, nowMs);
    let until = consentExpires(consent[target]);
    if (!until) {
      for (const entry of Object.values(consent)) {
        if (entry && typeof entry === 'object' && entry.name === target) { until = consentExpires(entry); break; }
      }
    }
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

  // 「休息模式」（我去玩了 / 我回来了 / away.json 排队补发）已按用户要求整段删除：
  // 桥接不再因游戏或离开而暂停发送，也不再排队补发。

  return null;
}

module.exports = { cannedReply, dismissReply };
