'use strict';

/** 从「我…」自述里抽出可长期记住的事实（每条不超过 30 字） */
function extractSelfFacts(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 60) return [];
  const rules = [
    /^(?:我叫|我的名字是|叫我)\s*([\u4e00-\u9fffA-Za-z0-9_]{1,12})$/,
    /^我(?:是|在)\s*([\u4e00-\u9fffA-Za-z0-9]{2,14})(?:上班|工作|读书|上学|的人)$/,
    /^我住在\s*([\u4e00-\u9fffA-Za-z0-9]{2,14})$/,
    /^我(?:喜欢|爱|讨厌|害怕|不吃|不能吃)\s*([\u4e00-\u9fffA-Za-z0-9]{1,16})$/,
    /^我(?:的)?生日(?:是)?\s*(\d{1,2}\s*月\s*\d{1,2}\s*[日号]?)$/,
    /^我(?:在|做)\s*([\u4e00-\u9fffA-Za-z0-9]{2,14})(?:工作|上班|读|学)$/,
  ];
  const out = [];
  for (const re of rules) {
    const m = s.match(re);
    if (m && m[1]) out.push(s.slice(0, 30));
  }
  return out;
}

module.exports = { extractSelfFacts };
