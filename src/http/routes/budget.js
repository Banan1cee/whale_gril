'use strict';

const { estimate } = require('../../services/budget');
const { json } = require('../util');

module.exports = function register(router) {
  // 启动器「高级模式 → 高级 → 对话预算」下方的说明用：只读估算，不联网、不发请求
  router.get('/api/budget/estimate', (runtime, req, res, info) => {
    const params = info && info.url ? info.url.searchParams : new URLSearchParams();
    const out = Number(params.get('outputTokens')) || 0;
    const budget = Number(params.get('dialogueBudget')) || 0;
    return json(res, 200, estimate(runtime.config, {
      ...(out > 0 ? { outputTokens: out } : {}),
      ...(budget > 0 ? { dialogueBudget: budget } : {}),
    }));
  });
};
