'use strict';

/**
 * 鲸鲸 HTTP 服务入口（薄层）：
 *   - 组装运行时（src/app.js）
 *   - 挂路由（src/http/routes）
 *   - 启动 / 自检 / CLI
 *
 * 业务逻辑分别在 src/core、src/pipeline、src/services、src/adapters、src/http 中。
 *
 * 用法：node server.js            启动
 *       node server.js --doctor   环境自检
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');

const { ensureConfigFile, loadConfig, resolveRuntime, maskKey, projectRoot } = require('./src/infra/config');
const { createRuntime, VERSION } = require('./src/app');
const { createRouter } = require('./src/http/routes');
const { json } = require('./src/http/util');
const { debugState, debugSessions } = require('./src/services/debug');
const { statusPayload, replyChannelLabel } = require('./src/services/status');
const { applySettings } = require('./src/services/settings');

/* ------------------------------------------------------------------ */
/* 主处理函数                                                          */
/* ------------------------------------------------------------------ */

function createHandler(runtime) {
  const { logger } = runtime;
  const router = createRouter(runtime);
  return function handler(req, res) {
    return Promise.resolve(router.handle(req, res)).catch((err) => {
      logger.error('未捕获错误：' + (err && err.stack ? err.stack : err));
      try { json(res, 500, { ok: false, error: 'internal error' }); } catch { /* ignore */ }
    });
  };
}

/* ------------------------------------------------------------------ */
/* 启动 / 停止                                                         */
/* ------------------------------------------------------------------ */

function openBrowser(url, logger) {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err && logger) logger.warn('没能自动打开浏览器，请手动访问：' + url);
  });
}

async function startServer({ root = projectRoot(), env = process.env, port, host, openBrowser: shouldOpen } = {}) {
  const runtime = createRuntime({ root, env });
  const { config, logger } = runtime;
  const handler = createHandler(runtime);
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      logger.error('未捕获错误：' + (err && err.stack ? err.stack : err));
      try { json(res, 500, { ok: false, error: 'internal error' }); } catch { /* ignore */ }
    });
  });
  server.keepAliveTimeout = 5000;

  // 注意：port = 0 是「让系统分配随机端口」，不能被 || 吞掉
  const requestedPort = port !== undefined && port !== null ? Number(port) : Number(config.server.port);
  const listenPort = Number.isFinite(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 8787;
  let listenHost = host || config.server.host || '127.0.0.1';
  const loopback = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!loopback.has(String(listenHost).toLowerCase()) && !(config.server && config.server.allowRemote)) {
    logger.warn(
      `server.host=${listenHost} 会把控制台暴露给局域网/公网，已强制改回 127.0.0.1。` +
        '确实要远程访问：在 config.json 设 server.allowRemote=true，并把 gateway.wechat.inboundToken 改成随机串。'
    );
    listenHost = '127.0.0.1';
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, resolve);
  });
  const actualPort = server.address().port;
  // 把实际端口写盘：桥接优先读这个文件，避免「手动 --port=8788 后桥接还连 8787」满屏积极拒绝
  try {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'server-port.txt'), String(actualPort), 'utf8');
  } catch (err) {
    logger.warn('写 server-port.txt 失败（不影响服务）：' + err.message);
  }

  const url = `http://${listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost}:${actualPort}`;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // SSE / keep-alive 连接会让 server.close() 一直等，先强制断开空闲连接
    try { if (server.closeIdleConnections) server.closeIdleConnections(); } catch { /* ignore */ }
    setTimeout(() => {
      try { if (server.closeAllConnections) server.closeAllConnections(); } catch { /* ignore */ }
    }, 300).unref?.();
    await new Promise((resolve) => server.close(resolve));
    logger.close();
  };
  server.on('close', () => {
    clearInterval(runtime.snapshotTimer);
    runtime.stopConfigWatch?.();
    runtime.store.close();
  });

  const open = shouldOpen === undefined ? Boolean(config.server.openBrowser) : shouldOpen;
  if (open) setTimeout(() => openBrowser(url, logger), 400);

  return { server, runtime, port: actualPort, host: listenHost, url, close };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function printBanner(runtime, url) {
  const { llm, config } = runtime;
  const lines = [
    '',
    '  🐋  鲸鲸 · 深海聊天机器人  ',
    `  版本：       v${runtime.version}`,
    '  ────────────────────────────────────────────',
    `  网页聊天：   ${url}`,
    `  运行模式：   ${llm.isMock ? '演示模式（还没配置模型，用内置台词）' : `${llm.providerLabel} · ${llm.model}`}`,
    `  模型服务：   ${llm.providerLabel}${llm.needsKey ? (llm.apiKey ? '（Key 已配置）' : '（未填 Key）') : '（本地/免 Key）'}`,
    `  记忆文件：   ${config.paths.storeFile}`,
    `  回复发送：   ${replyChannelLabel(config)}`,
    `  接入微信：   POST ${url}/webhook/wechat   （见 docs/接入微信.md）`,
    `  接入抖音：   POST ${url}/webhook/douyin   （见 docs/接入抖音.md）`,
    '  ────────────────────────────────────────────',
    '  按 Ctrl+C 停止',
    '',
  ];
  console.log(lines.join('\n'));
}

function runDoctor() {
  const root = projectRoot();
  ensureConfigFile(root);
  const config = loadConfig({ root });
  const rt = resolveRuntime(config);
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok, detail });

  push('Node 版本', parseInt(process.version.slice(1), 10) >= 18, process.version);
  push('web 目录', fs.existsSync(path.join(root, 'web', 'index.html')), path.join(root, 'web', 'index.html'));
  push('config.json', fs.existsSync(config.paths.configFile), config.paths.configFile);
  push(
    '模型服务',
    !rt.mock || !rt.needsKey,
    `${rt.providerLabel} · ${rt.model}${rt.needsKey ? (rt.apiKey ? '（Key 已配置）' : '（未填 Key → 演示模式，可在设置里换免费模型）') : '（本地/免 Key，不需要 Key）'}`
  );
  push('API Key', Boolean(rt.apiKey) || !rt.needsKey, rt.apiKey ? maskKey(rt.apiKey) + '（来自设置/配置/环境变量）' : rt.needsKey ? '未配置' : '不需要');
  try {
    fs.mkdirSync(config.paths.dataDir, { recursive: true });
    const probe = path.join(config.paths.dataDir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    push('数据目录可写', true, config.paths.dataDir);
  } catch (err) {
    push('数据目录可写', false, err.message);
  }
  push('端口可用', true, `${config.server.host}:${config.server.port}（启动时会再确认）`);
  for (const [platform, gw] of Object.entries(config.gateway || {})) {
    push(
      `${platform} 网关`,
      Boolean(gw && gw.enabled),
      gw && gw.enabled ? (gw.outboundUrl ? `outbound: ${gw.outboundUrl}` : '已启用，但未配置 outboundUrl（只打印不发送）') : '未启用（可在 config.json 里开启）'
    );
  }
  console.log('\n🐋 鲸鲸 · 环境自检\n');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '⚠️ '} ${c.name.padEnd(12, ' ')} ${c.detail}`);
  console.log('\n提示：没有 Key 也能启动——网页里可以选免费的智谱 GLM-4-Flash，或本地 Ollama，全程不花钱。\n');
  return checks.every((c) => c.ok);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--doctor') || args.includes('doctor')) {
    runDoctor();
    process.exit(0);
  }
  if (args.includes('--debug-info')) {
    const rt = createRuntime({});
    console.log(JSON.stringify({ state: debugState(rt), sessions: debugSessions(rt) }, null, 2));
    rt.store.close();
    process.exit(0);
  }
  const portArg = args.find((a) => /^--port=\d+$/.test(a));
  const port = portArg ? Number(portArg.split('=')[1]) : undefined;
  const noBrowser = args.includes('--no-browser');

  let instance;
  try {
    instance = await startServer({ port, openBrowser: noBrowser ? false : undefined });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ 端口被占用了（${err.port || '默认端口'}）。换个端口：node server.js --port=8788\n`);
    } else {
      console.error('\n❌ 启动失败：', err && err.stack ? err.stack : err, '\n');
    }
    process.exit(1);
  }
  printBanner(instance.runtime, instance.url);
  instance.runtime.logger.info(`服务已启动 ${instance.url}，模式=${instance.runtime.llm.isMock ? '演示' : '真实 API'}`);

  const shutdown = async () => {
    console.log('\n🌊 鲸鲸要潜回深海了…');
    await instance.close();
    process.exit(0);
  };
  // 启动器通过专属标准输入管道请求正常退出，无需暴露 HTTP 控制接口。
  if (process.env.WHALE_CONTROL_STDIN === '1') {
    const readline = require('node:readline');
    const control = readline.createInterface({ input: process.stdin });
    let stopping = false;
    control.on('line', (line) => {
      if (line === 'shutdown' && !stopping) { stopping = true; void shutdown(); }
    });
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = { startServer, createRuntime, createHandler, statusPayload, applySettings, VERSION };
