'use strict';

/**
 * 统一的提示词拼装工具（测试专用）。
 *
 * 改造后「模型看到的东西」分两块：
 *   system  —— 静态：人设 / 规则 / 群聊规则 / 硬性要求 / 日期行
 *   尾部    —— 本轮状态：心情、说话人、字数、@、梗、联网资料、动作账本……
 * 尾部挂在最后一条 user 消息里（正文 → 记忆块 → 本轮状态）。
 *
 * 所以断言提示词内容时不要只看 buildSystem 的返回值，也别在测试里各写各的拼接：
 * 一律用 assemblePrompt() / promptOf(decision)。
 */
const persona = require('../../src/persona');
const { buildTurns } = require('../../src/core/context');

/**
 * @param {{config:object,msg:object,profile?:object,notes?:string[],events?:object[],now?:Date}} ctx
 * @param {{history?:object[],memoryBlock?:string}} [opts]
 * @returns {{system:string, tail:string, turns:object[], prompt:string}}
 */
function assemblePrompt(ctx = {}, { history, memoryBlock = '' } = {}) {
  const msg = { ...(ctx.msg || {}) };
  if (!msg.ts) msg.ts = (ctx.now instanceof Date ? ctx.now : new Date()).getTime();
  // history 既可以直接写在 ctx 里，也可以作为第二个参数传，省得调用方记两个位置
  const past = Array.isArray(history) ? history : (Array.isArray(ctx.history) ? ctx.history : []);
  const parts = persona.buildPromptParts({ ...ctx, msg });
  const turns = buildTurns(msg, past, memoryBlock, parts.tail);
  return {
    system: parts.system,
    tail: parts.tail,
    turns,
    prompt: [parts.system, ...turns.map((t) => t.content)].filter(Boolean).join('\n\n'),
  };
}

/** 从 Bot.decide() / /api/debug/prompt 的结果拼出模型真正看到的全文 */
function promptOf(decision) {
  const system = (decision && decision.system) || '';
  const turns = (decision && decision.turns) || [];
  return [system, ...turns.map((t) => t.content)].filter(Boolean).join('\n\n');
}

module.exports = { assemblePrompt, promptOf };
