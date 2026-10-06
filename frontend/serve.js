// serve.js — 纯 Node.js，无额外依赖 (ES Module)
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv[2]) || 5174;
const API_PORT = 3000;
const DIST = path.join(__dirname, 'dist');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function proxyAPI(req, res) {
  const opts = {
    hostname: '127.0.0.1', port: API_PORT, path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `localhost:${API_PORT}`,
      'x-forwarded-for': req.socket.remoteAddress,
    },
  };
  const proxy = http.request(opts, (pres) => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  proxy.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(proxy);
}

function serveStatic(req, res) {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html';
  let filePath = path.join(DIST, rel);

  /**
   * 🔴 踩过的坑（2026-10-02 用户机器上出现「打开就页面崩溃/白屏」）：
   *  ① 旧版这里对任何找不到的路径都回 index.html（200 + text/html）。
   *     当浏览器还缓存着旧 index.html、而它引用的 index-xxxx.js 已被新版替换时，
   *     请求那个不存在的 js 会拿到 HTML —— 浏览器按模块脚本解析 HTML 直接报错/白屏。
   *     → 现在 /assets/ 下找不到就老实回 404。
   *  ② 旧版没有任何缓存头，浏览器按启发式规则缓存 index.html，
   *     导致「明明更新了前端，刷新还是旧的」。
   *     → 现在 index.html 一律 no-store；带 hash 的静态资源也顺带 no-cache，本地零成本。
   */
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    if (rel.startsWith('assets/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('asset not found: ' + rel);
      return;
    }
    filePath = path.join(DIST, 'index.html');
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'text/plain',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return proxyAPI(req, res);
  serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`前端 :${PORT} (API → :${API_PORT})`);
});
