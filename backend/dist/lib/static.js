"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = default_1;
/**
 * 静态托管前端构建产物（`frontend/dist`）—— 方案 C3 第 1 块
 *
 * 目标：**后端一个进程、一个端口 5174** 同时提供页面和 `/api`（同源，不再需要
 * `frontend/serve.js` 那个手写代理）。
 *
 * 实现严格照抄现成的 `frontend/serve.js`（零依赖，只用 node 内置 fs/path），
 * 踩过的坑也一并搬过来：
 *   ① **未命中不要一律回 index.html**：只有当请求的不是 `assets/` 下的东西时
 *      才回退 index.html。`assets/` 下找不到就老实回 404 —— 否则浏览器缓存着
 *      旧 index.html、它引用的旧哈希 JS 已被替换，请求那个 js 会拿到 HTML，
 *      浏览器按模块脚本解析 HTML 直接报错/白屏（2026-10-02 用户真机事故）。
 *   ② **index.html 必须禁止缓存**：否则浏览器按启发式规则缓存 index.html，
 *      出现「明明更新了前端、刷新还是旧的」。这里统一 `no-store`（本地零成本）。
 *
 * 与 serve.js 的差异：这里挂在 Fastify 上（通配路由 `/*`），不是裸 http server；
 * 另外补了目录穿越防护（serve.js 没做，内网工具也无所谓，顺手补上）。
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
};
/**
 * 定位前端构建目录。
 * `__dirname`：编译后 = `backend/dist/lib`；tsx 直跑 = `backend/src/lib`
 * —— 两种情况往上是 **3 层** = 工程根，再进 `frontend/dist`（源码树与离线包布局一致）。
 */
function resolveDist() {
    const candidates = [];
    if (process.env.LPM_FRONTEND_DIST)
        candidates.push(process.env.LPM_FRONTEND_DIST);
    candidates.push(path_1.default.resolve(__dirname, '..', '..', '..', 'frontend', 'dist'));
    candidates.push(path_1.default.resolve(process.cwd(), 'frontend', 'dist'));
    candidates.push(path_1.default.resolve(process.cwd(), '..', 'frontend', 'dist'));
    for (const c of candidates) {
        try {
            if (fs_1.default.existsSync(path_1.default.join(c, 'index.html')))
                return c;
        }
        catch {
            /* 试下一个 */
        }
    }
    return candidates[0];
}
async function default_1(app) {
    const DIST = resolveDist();
    console.log(`[LPM] 静态托管目录：${DIST}`);
    const handle = (req, reply) => {
        const rawUrl = req.raw.url || '/';
        const rel = decodeURIComponent(rawUrl.split('?')[0]).replace(/^\/+/, '') || 'index.html';
        let filePath = path_1.default.normalize(path_1.default.join(DIST, rel));
        // 目录穿越防护：解析后必须仍在 DIST 之内
        if (filePath !== DIST && !filePath.startsWith(DIST + path_1.default.sep)) {
            reply.status(403).type('text/plain; charset=utf-8').send('forbidden');
            return;
        }
        const isAsset = rel.startsWith('assets/');
        if (!fs_1.default.existsSync(filePath) || fs_1.default.statSync(filePath).isDirectory()) {
            // assets 下找不到 → 老实 404（见文件头坑①），绝不回 HTML
            if (isAsset) {
                reply
                    .header('Cache-Control', 'no-store')
                    .status(404)
                    .type('text/plain; charset=utf-8')
                    .send('asset not found: ' + rel);
                return;
            }
            // 其它路径 → 回退 index.html（SPA）
            const idx = path_1.default.join(DIST, 'index.html');
            if (!fs_1.default.existsSync(idx)) {
                reply
                    .status(503)
                    .type('text/plain; charset=utf-8')
                    .send('前端未构建：找不到 ' + idx);
                return;
            }
            filePath = idx;
        }
        const ext = path_1.default.extname(filePath).toLowerCase();
        reply
            .header('Content-Type', MIME[ext] || 'application/octet-stream')
            // 坑②：一律禁止缓存，保证刷新一定拿到最新 index.html / 哈希资源
            .header('Cache-Control', 'no-store, no-cache, must-revalidate')
            .header('Pragma', 'no-cache')
            .header('Expires', '0')
            .status(200);
        reply.send(fs_1.default.createReadStream(filePath));
    };
    // 通配路由：只在其它更精确的 /api/* 路由都没命中时接手。
    // （Fastify 的 find-my-way 路由树会优先匹配静态 / 参数化路由，通配永远是兜底。）
    app.get('/*', (req, reply) => {
        const url = (req.raw.url || '').split('?')[0];
        if (url.startsWith('/api/')) {
            // 未定义的接口：回 JSON 404，别把 HTML 塞给 fetch
            reply.status(404).send({ error: 'not_found', path: url });
            return;
        }
        handle(req, reply);
    });
}
