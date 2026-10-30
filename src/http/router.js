'use strict';

const { json } = require('./util');
const { checkRequest, applySecurityHeaders } = require('./security');
const { serveStatic } = require('./static');

/**
 * 极简声明式路由：精确路径 + 正则模式，无依赖。
 * handler(ctx, req, res, info) ；info = { url, pathname, method, params }
 */
class Router {
  constructor(runtime) {
    this.runtime = runtime;
    this.routes = [];
    this.patterns = [];
  }

  add(method, path, handler) {
    this.routes.push({ method: String(method).toUpperCase(), path, handler });
    return this;
  }

  get(path, handler) { return this.add('GET', path, handler); }
  post(path, handler) { return this.add('POST', path, handler); }
  any(path, handler) { return this.add('*', path, handler); }

  pattern(regex, handler) {
    this.patterns.push({ regex, handler });
    return this;
  }

  /** 匹配精确路由；返回 { handler, params } / 'method_miss' / null */
  match(method, pathname) {
    let pathHit = false;
    for (const r of this.routes) {
      if (r.path !== pathname) continue;
      pathHit = true;
      if (r.method === '*' || r.method === method) return { handler: r.handler, params: {} };
    }
    return pathHit ? 'method_miss' : null;
  }

  async handle(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return json(res, 400, { ok: false, error: 'bad url' });
    }
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method || 'GET';
    const info = { url, pathname, method, params: {} };
    const { runtime } = this;

    try {
      applySecurityHeaders(res);
      const denied = checkRequest(runtime, req, info);
      if (denied) return json(res, denied.status, { ok: false, error: denied.error });

      if (pathname === '/healthz') return json(res, 200, { ok: true, up: true });

      const hit = this.match(method, pathname);
      if (hit && hit !== 'method_miss') return await hit.handler(runtime, req, res, info);

      for (const p of this.patterns) {
        const m = pathname.match(p.regex);
        if (!m) continue;
        return await p.handler(runtime, req, res, { ...info, params: m.slice(1) });
      }

      if (hit === 'method_miss') return json(res, 405, { ok: false, error: 'method not allowed' });

      if (method === 'GET' || method === 'HEAD') return serveStatic(runtime, req, res, pathname);
      return json(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      const status = err.statusCode || 500;
      // 关掉的表情包接口 / 被拒绝的测试是预期行为，不该刷 ERROR
      if (!(pathname.startsWith('/api/stickers') && status < 500)) {
        runtime.logger.error(`${method} ${pathname} 出错：` + (err && err.stack ? err.stack : err));
      }
      if (status === 500) return json(res, 500, { ok: false, error: '服务器打了个结，请看控制台日志' });
      return json(res, status, { ok: false, error: err.message });
    }
  }
}

module.exports = { Router };
