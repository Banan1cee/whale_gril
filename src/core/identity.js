'use strict';

/**
 * 身份纠错：把「她否认主人」的整段问答从历史里剔掉（只影响这一轮喂给模型的内容，记忆文件不动）。
 * 不这么做的话：主人名单刚配对，她会顺着几十条「你不是主人」的历史继续否认，
 * 提示词里的【主人】段压不住 —— 实测 51 轮这种历史，连问两遍都还是「不是」。
 */

/** 她在「还没认证主人」时期说过的否认：这些话会把她拽回旧立场，主人本人对话时不能再喂给模型 */
const MASTER_DENIAL_RE = /冒充|不是你的?主人|不是你就对|没你这号|认主系统|系统.{0,8}不认|不认你|自封|普通网友|光说没用|这招我熟|真主人不是|别磨|别绕了|凭什么信|不认。/;
/** 对方在问「我是不是你主人」：这类追问整段都要从历史里拿掉，不管她当时怎么答 */
const MASTER_ASK_RE = /我是你.{0,2}主人|我是主人|我算不算|你的?主人.{0,4}(是|叫|谁)|你主人是谁|我是谁|我不是么|不认我|认我当|认主/;

function stripMasterDispute(history) {
  const out = [];
  let dropping = false; // 正在丢一段「你是不是主人」的争执
  for (const m of history || []) {
    if (!m || m.error) { out.push(m); dropping = false; continue; }
    if (m.role === 'user') {
      dropping = MASTER_ASK_RE.test(String(m.text || ''));
      if (!dropping) out.push(m);
      continue;
    }
    if (dropping) continue; // 追问之后她那几句否认，一起丢掉
    if (MASTER_DENIAL_RE.test(String(m.text || ''))) {
      // 她自己主动否认（前面没有对应追问）也丢掉，别留下「我不认你」的立场
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user') out.pop();
      continue;
    }
    out.push(m);
  }
  return out;
}

module.exports = { MASTER_DENIAL_RE, MASTER_ASK_RE, stripMasterDispute };
