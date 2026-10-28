'use strict';

/**
 * 兼容壳：HTTP 协议工具已经挪到 ./protocol.js。
 *
 * 背景：services 层需要 json / readBody / sseSend（它要直接写 HTTP 响应），
 * 但服务层不该依赖「HTTP 服务器的路由 / 安全闸 / 静态文件」那些东西。
 * 把纯协议部分单独成 protocol.js，依赖方向就变成
 *   services → http/protocol（协议）
 * 而不是
 *   services → http（服务器）
 */

module.exports = require('./protocol');
