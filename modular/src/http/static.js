'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { json, MIME } = require('./util');

/** 静态文件：/ → index.html，/debug → debug.html，/persona → persona.html */
function serveStatic(runtime, req, res, urlPath) {
  const { config } = runtime;
  const webDir = config.paths.webDir;
  const rel = urlPath === '/' ? 'index.html' : urlPath === '/debug' ? 'debug.html' : urlPath === '/persona' ? 'persona.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(webDir, rel);
  if (!filePath.startsWith(webDir)) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (urlPath === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }
      return json(res, 404, { ok: false, error: 'not found' });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

module.exports = { serveStatic };
