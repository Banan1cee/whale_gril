'use strict';

/**
 * 聊天内小命令的解析（/reset、/mute、记住…）。
 * 只做「文本 → {type, arg}」，执行逻辑留在 pipeline / services。
 */

const COMMAND_HELP = [
  '咕噜~ 人家会的：聊天、记住你说过的事、被 @ 的时候浮上来说话。',
  '小命令：/reset 清空这个聊天的记忆；/mute 30 闭麦半小时；/unmute 开麦；/remember 记住：xxx；/forget 忘掉 xxx；/help 再看一遍。',
].join('\n');

/** 从文本里识别命令；返回 {type, arg} 或 null */
function extractCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const slash = raw.match(/^[/／!！]\s*([a-zA-Z]+)\s*([\s\S]*)$/);
  if (slash) {
    const cmd = slash[1].toLowerCase();
    const arg = slash[2].trim();
    const map = {
      help: 'help', h: 'help', '帮助': 'help',
      reset: 'reset', clear: 'reset', '重置': 'reset',
      mute: 'mute', '闭麦': 'mute', '静音': 'mute',
      unmute: 'unmute', '开麦': 'unmute',
      forget: 'forget', '忘掉': 'forget',
      remember: 'remember', '记住': 'remember',
      name: 'name', '名字': 'name',
      status: 'status', '状态': 'status',
    };
    if (map[cmd]) return { type: map[cmd], arg, raw };
    return null;
  }
  const t = raw.replace(/^[\s，,。.]+|[\s。.！!~～]+$/g, '');

  if (/^(?:help|帮助|菜单|怎么用|会什么|能做什么)$/i.test(t)) return { type: 'help', arg: '', raw };
  if (/^(?:status|状态|情况)$/i.test(t)) return { type: 'status', arg: '', raw };

  let m = t.match(/^(?:记住|记一下|帮我记住|记下)[：:\s]*([\s\S]{1,60})$/);
  if (m) return { type: 'remember', arg: m[1].trim(), raw };
  m = t.match(/^(?:忘掉|忘记|删掉|别记)[：:\s]*([\s\S]{1,60})$/);
  if (m) return { type: 'forget', arg: m[1].trim(), raw };
  m = t.match(/^(?:我叫|叫我|以后叫我)[：:\s]*([\s\S]{1,20})$/);
  if (m) return { type: 'name', arg: m[1].trim().replace(/[。.!！~～]+$/, ''), raw };

  if (/^(?:你记得我什么|你记得什么|你记得啥|你的记忆|记忆|记性)$/.test(t)) return null; // 不提供记忆清单
  if (/^(?:重置|清空|清除|忘掉刚才|重置记忆|清空记忆|清除记忆)(?:一下)?(?:记忆|聊天记录|上下文)?$/.test(t)) {
    return { type: 'reset', arg: '', raw };
  }
  m = t.match(/^(?:闭麦|安静点|安静|别说话|消停)[：:\s]*(\d{1,4})?\s*(?:分钟)?$/);
  if (m || /^(?:闭麦|安静点|别说话|消停)$/.test(t)) {
    return { type: 'mute', arg: m && m[1] ? m[1] : '', raw };
  }
  if (/^(?:开麦|出来吧|说话吧|解禁)$/.test(t)) return { type: 'unmute', arg: '', raw };
  return null;
}

module.exports = { COMMAND_HELP, extractCommand };
