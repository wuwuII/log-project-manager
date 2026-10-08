"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const prisma_1 = __importDefault(require("./lib/prisma"));
const date_1 = require("./lib/date");
const tables_1 = __importDefault(require("./routes/tables"));
const logs_1 = __importDefault(require("./routes/logs"));
const todos_1 = __importDefault(require("./routes/todos"));
const projects_1 = __importDefault(require("./routes/projects"));
const people_1 = __importDefault(require("./routes/people"));
const data_1 = __importDefault(require("./routes/data"));
const workspace_1 = __importDefault(require("./routes/workspace"));
const recycle_1 = __importDefault(require("./routes/recycle"));
const reminders_1 = __importDefault(require("./routes/reminders")); // 2026-10-08 提醒功能
// ── 方案 C3 新增 ──────────────────────────────────────────────
const static_1 = __importDefault(require("./lib/static"));
const heartbeat_1 = __importStar(require("./routes/heartbeat"));
const project_state_1 = require("./lib/project-state");
const app = (0, fastify_1.default)({ logger: true, trustProxy: true });
async function ensureDefaultTables() {
    const n = await prisma_1.default.tableMeta.count({ where: { deleted_at: null } });
    if (n > 0)
        return;
    const defaults = [
        { name: '日志', type: 'log', sort_order: 0 },
        { name: '项目计划', type: 'project', sort_order: 1 },
        { name: '人员', type: 'people', sort_order: 2 },
    ];
    for (const d of defaults) {
        await prisma_1.default.tableMeta.create({ data: { ...d, config: '{}' } });
    }
    // 项目计划表配一个默认项目，否则甘特图是空的
    const projTable = await prisma_1.default.tableMeta.findFirst({ where: { type: 'project', deleted_at: null } });
    if (projTable) {
        const p = await prisma_1.default.project.create({
            data: { table_id: projTable.id, name: '默认项目', status: 'active', start_date: (0, date_1.todayStr)() },
        });
        await prisma_1.default.tableMeta.update({ where: { id: projTable.id }, data: { config: JSON.stringify({ project_id: p.id }) } });
    }
    console.log('[init] 已创建默认工作表：日志 / 项目计划 / 人员');
}
/**
 * 启动时兜底补表（2026-10-08 新增）
 *
 * 为什么需要：新版加了「日志提醒」，多了一张 `reminders` 表。把新版推到用户机器时，
 * 用户手上那个 app.db 是旧的、没有这张表；Prisma 不像 Rails 那样会自动迁移，
 * 结果一用提醒就报 "no such table"。用户机器上没有 node/npm/prisma CLI，
 * 也不该让用户去双击迁移脚本 —— 所以在启动时用 CREATE TABLE IF NOT EXISTS 兜一下。
 *
 * 特点：幂等（已存在就什么都不做）、不需要任何外部工具、以后再加表照这个套路写即可。
 */
async function ensureRuntimeSchema() {
    try {
        await prisma_1.default.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "reminders" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "table_id" TEXT NOT NULL,
        "text" TEXT NOT NULL,
        "repeat" TEXT NOT NULL DEFAULT 'once',
        "rule" TEXT NOT NULL DEFAULT '{}',
        "start_date" TEXT,
        "end_date" TEXT,
        "enabled" BOOLEAN NOT NULL DEFAULT true,
        "color" TEXT,
        "sort_order" INTEGER NOT NULL DEFAULT 0,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME NOT NULL,
        "deleted_at" DATETIME
      )`);
        await prisma_1.default.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "reminders_table_id_idx" ON "reminders"("table_id")`);
    }
    catch (e) {
        // 补表失败不拦住启动（老库仍然可用），但要把原因打出来，方便排查
        console.error('[LPM] 兜底补表失败（不影响旧功能）：', e?.message || e);
    }
}
/**
 * 工程文件缺失时，仍然放行的接口：
 *   health/heartbeat 让前端页面能正常跑起来、能上报心跳；
 *   workspace/browse|open|new 让用户能在页面上重新选一个 .db（否则没法自救）。
 * 其它 /api/* 一律 409，避免任何一次数据库连接把空库「静默建出来」。
 */
const ALLOW_WHEN_MISSING = new Set([
    '/api/health',
    '/api/heartbeat',
    '/api/workspace/browse',
    '/api/workspace/open',
    '/api/workspace/new',
]);
async function start() {
    await app.register(cors_1.default, { origin: true });
    // 全局处理空 JSON body（axios 不带 data 的 POST/PATCH/DELETE 会被 Fastify 框架层拦成 400）
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
        try {
            done(null, body.length > 0 ? JSON.parse(body) : {});
        }
        catch (err) {
            err.statusCode = 400;
            done(err, undefined);
        }
    });
    app.get('/api/health', async () => ({ status: 'ok', service: 'lpm', ts: Date.now() }));
    await app.register(tables_1.default);
    await app.register(logs_1.default);
    await app.register(todos_1.default);
    await app.register(projects_1.default);
    await app.register(people_1.default);
    await app.register(data_1.default);
    await app.register(workspace_1.default);
    await app.register(recycle_1.default);
    await app.register(reminders_1.default); // 2026-10-08 提醒功能
    await app.register(heartbeat_1.default); // 方案 C3：心跳 + 看门狗
    // ── 方案 C3 第 5 块：工程文件缺失保护 ──────────────────────
    // 关键：文件不在时**绝不** ensureDefaultTables（那会静默建空库），也不放行业务接口。
    const missing = (0, project_state_1.refreshProjectState)();
    if (missing) {
        console.error(`[LPM] ⚠️ 当前工程文件不存在：${(0, project_state_1.projectMissingPath)()}`);
        console.error('[LPM] 已进入「工程文件缺失」保护模式：不会静默新建空库；请在页面里选一个新位置。');
    }
    else {
        await ensureDefaultTables();
        // 老库缺新表（如 reminders）时在这里补上，幂等
        await ensureRuntimeSchema();
    }
    app.addHook('onRequest', async (req, reply) => {
        if (!(0, project_state_1.isProjectMissing)())
            return;
        if (req.method === 'OPTIONS')
            return;
        const url = (req.raw.url || '').split('?')[0];
        if (!url.startsWith('/api/'))
            return;
        if (ALLOW_WHEN_MISSING.has(url))
            return;
        reply.status(409).send({
            error: 'project_file_missing',
            current_path: (0, project_state_1.projectMissingPath)(),
            message: '工程文件没找到，请选一下新位置',
        });
    });
    // ── 方案 C3 第 1 块：静态托管前端（必须最后注册，通配路由兜底）──
    await app.register(static_1.default);
    const port = Number(process.env.PORT) || 3000;
    try {
        await app.listen({ port, host: '0.0.0.0' });
        console.log(`LPM backend running on :${port}`);
    }
    catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}
// ── 方案 C3：进程退出钩子做落盘（与看门狗共用 gracefulShutdown）──
process.on('SIGINT', () => {
    void (0, heartbeat_1.gracefulShutdown)('SIGINT');
});
process.on('SIGTERM', () => {
    void (0, heartbeat_1.gracefulShutdown)('SIGTERM');
});
start();
