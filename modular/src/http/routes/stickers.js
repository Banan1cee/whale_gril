'use strict';

/**
 * 表情包（实验性）路由。
 *
 * 三个安全边界（和 server.js 里的原实现一致）：
 *   1. 总开关关着 → 整个前缀 404（不读盘、不列目录、不给 UI 用）；
 *   2. 管理接口只允许本机访问（远程写已经在 security.js 拦过一层，这里再收紧）；
 *   3. 桥接用的 pending / claim / ack 必须带对的 gateway token
 *      —— 否则同机的其它程序能把别人待发的表情包领走。
 */

const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');

const stickers = require('../../adapters/stickers');
const { json, readBody, MIME } = require('../protocol');
const { isLoopbackRequest } = require('../security');

const BRIDGE_ONLY = new Set(['/api/stickers/pending', '/api/stickers/claim', '/api/stickers/ack']);

function stickerPath(config, emotion, name) {
  const dir = stickers.stickerDir(config, config.root);
  const safeName = path.basename(String(name || ''));
  const folder = stickers.EMOTIONS[emotion];
  if (!safeName || !folder) return null;
  const file = path.join(dir, folder, safeName);
  return stickers.regularFile(file, dir) ? { dir, file } : null;
}

module.exports = function register(router) {
  router.pattern(/^\/api\/stickers(?:\/.*)?$/, (runtime, req, res, info) => {
    const { config, logger } = runtime;
    const service = runtime.stickerService;
    if (!service) return json(res, 404, { ok: false, error: '表情包功能未开启' });
    // 关着就当作这个接口不存在：不读盘、不列目录、不给 UI 用
    service.requireEnabled();
    const generation = service.generation;
    const pathname = info.pathname;
    const method = req.method || 'GET';

    if (!isLoopbackRequest(req)) {
      return json(res, 403, { ok: false, error: '表情包管理仅允许本机访问' });
    }
    if (BRIDGE_ONLY.has(pathname)) {
      const gw = runtime.gateways && runtime.gateways.get && runtime.gateways.get('wechat');
      if (!gw || !gw.verifyToken(req, null)) {
        return json(res, 403, { ok: false, error: '桥接 token 不正确' });
      }
    }

    if (pathname === '/api/stickers/status' && method === 'GET') return json(res, 200, service.status());

    // 控制台缩略图：只回传表情包目录里的真图，不能读任意文件
    if (pathname === '/api/stickers/image' && method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const hit = stickerPath(config, url.searchParams.get('emotion'), url.searchParams.get('name'));
      if (!hit) return json(res, 404, { ok: false, error: '找不到这张表情包' });
      const type = MIME[path.extname(hit.file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return fs.createReadStream(hit.file).pipe(res);
    }

    if (pathname === '/api/stickers/delete' && method === 'POST') {
      return (async () => {
        const body = await readBody(req);
        const hit = stickerPath(config, body && body.emotion, body && body.name);
        if (!hit) return json(res, 404, { ok: false, error: '找不到这张表情包（可能已经删掉了）' });
        try {
          fs.unlinkSync(hit.file);
        } catch (err) {
          return json(res, 500, { ok: false, error: '删除失败：' + ((err && err.message) || err) });
        }
        logger.info(`表情包已删除：${path.basename(path.dirname(hit.file))}/${path.basename(hit.file)}`);
        return json(res, 200, { ok: true, emotions: service.status().emotions });
      })();
    }

    // 在本机资源管理器里打开表情包目录（只打开这一个固定目录）
    if (pathname === '/api/stickers/open-folder' && method === 'POST') {
      const dir = stickers.stickerDir(config, config.root);
      fs.mkdirSync(dir, { recursive: true });
      if (process.platform === 'win32' && process.env.WHALE_TEST_NO_SHELL !== '1') {
        try {
          exec(`explorer.exe "${dir}"`, () => {});
        } catch (err) {
          return json(res, 500, { ok: false, error: '打开文件夹失败：' + ((err && err.message) || err) });
        }
      }
      return json(res, 200, { ok: true, dir });
    }

    if (pathname === '/api/stickers/upload' && method === 'POST') {
      return (async () => {
        const body = await readBody(req, 29 * 1024 * 1024);
        // 上传大文件期间开关可能被关掉
        service.requireEnabled();
        if (generation !== service.generation) {
          return json(res, 409, { ok: false, error: '开关已变化，请重新上传' });
        }
        const uploaded = stickers.upload(config, config.root, body && body.emotion, body && body.files);
        return json(res, 200, { ok: true, uploaded });
      })();
    }

    if (pathname === '/api/stickers/test' && method === 'POST') {
      return (async () => {
        const body = await readBody(req);
        service.requireEnabled();
        if (generation !== service.generation) {
          return json(res, 409, { ok: false, error: '开关已变化，请重新排队' });
        }
        const queued = service.enqueue(
          (body && body.emotion) || 'happy',
          body && body.chat !== undefined ? body.chat : (config.sticker && config.sticker.testChat) || '文件传输助手'
        );
        return json(res, 200, { ok: true, queued });
      })();
    }

    if (pathname === '/api/stickers/pending' && method === 'GET') {
      return json(res, 200, { ok: true, items: service.pending() });
    }

    if (pathname === '/api/stickers/claim' && method === 'POST') {
      return (async () => {
        const body = await readBody(req);
        return json(res, 200, { ok: true, item: service.claim(body && body.id) });
      })();
    }

    if (pathname === '/api/stickers/ack' && method === 'POST') {
      return (async () => {
        const body = await readBody(req);
        return json(res, 200, { ok: true, item: service.ack(body && body.id, body && body.status, body && body.error) });
      })();
    }

    return json(res, 404, { ok: false, error: 'not found' });
  });
};
