'use strict';

const bilibili = require('../adapters/bilibili');

/* ---------------- 主动分享：从群聊热点找视频 ---------------- */

async function shareForChat(runtime, chatId) {
  const key = chatId ? `wechat:g:${chatId}` : '';
  let texts = [];
  if (key) {
    try {
      texts = runtime.store
        .messages(key, 30)
        .filter((m) => m.role === 'user' && m.text)
        .map((m) => String(m.text).slice(0, 120));
    } catch {
      texts = [];
    }
  }
  let topic = '';
  if (texts.length >= 3) {
    try {
      const out = await runtime.llm.complete({
        system: '你只输出 1 个适合去视频网站搜的中文话题词，不超过 8 个字，不要解释、不要标点。',
        turns: [{ role: 'user', content: texts.slice(-20).join('\n').slice(0, 1500) }],
      });
      topic = String(out).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 12);
    } catch {
      topic = '';
    }
  }
  // 来源：以前这个配置项没人读，写什么都是硬抓 B 站。现在至少让它真的能关。
  const sources = Array.isArray(runtime.config.share && runtime.config.share.sources)
    ? runtime.config.share.sources.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
    : ['bilibili'];
  if (!sources.includes('bilibili')) {
    return { ok: true, video: null, topic, reason: 'no_source', sources };
  }
  let video = topic ? await bilibili.pickByKeyword(runtime.config, topic) : null;
  if (!video) video = await bilibili.pickVideo(runtime.config);
  if (!video) return { ok: true, video: null, topic };
  const comments = await bilibili.fetchComments(video.bvid, 5);
  let comment = '';
  try {
    const sys = '你叫鲸鲸，爱刷视频的女生。看完这个视频，用第一人称说一句自己的感悟或吐槽（跟自己的生活、心情有关），10~20 字；不要复述标题、不要解释、不要提 AI/模型/token/提示词。';
    const user = `话题：${topic || '随便'}\n标题：${video.title}\n评论：${comments.slice(0, 3).join(' / ')}`;
    comment = String(await runtime.llm.complete({ system: sys, turns: [{ role: 'user', content: user }] }))
      .trim()
      .slice(0, 60);
  } catch {
    comment = '';
  }
  return { ok: true, video, topic, comments: comments.slice(0, 3), comment };
}

module.exports = { shareForChat };
