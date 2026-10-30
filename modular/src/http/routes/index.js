'use strict';

const { Router } = require('../router');

const modules = [
  require('./status'),
  require('./features'),
  require('./memory'),
  require('./settings'),
  require('./vision'),
  require('./share'),
  require('./persona'),
  require('./wechat'),
  require('./config'),
  require('./debug'),
  require('./care'),
  require('./chat'),
  require('./bridge'),
  require('./stickers'),
  require('./digest'),
];

/** 组装路由表：每个领域一个文件，server 只负责启动。 */
function createRouter(runtime) {
  const router = new Router(runtime);
  for (const register of modules) register(router);
  return router;
}

module.exports = { createRouter };
