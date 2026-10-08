"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDbFile = getDbFile;
exports.switchDb = switchDb;
// ⚠️ 必须第一行：先加载 .env，再 new PrismaClient()
// （PrismaClient 运行时不会自己读 .env，不先加载会报 DATABASE_URL 找不到）
require("./env");
const client_1 = require("@prisma/client");
const path_1 = __importDefault(require("path"));
/**
 * 当前工程（= 一个 .db 文件）的绝对路径。
 *
 * ⚠️ Prisma 里 DATABASE_URL 相对路径的基准是 **schema.prisma 所在目录**（backend/prisma/），
 *    不是 cwd —— 这个坑 2026-10-02「备份路径」那次踩过，这里按同样的规则解析。
 *    __dirname：编译后 = backend/dist/lib，tsx 直跑 = backend/src/lib → 两种都是 ../../prisma。
 */
function resolveDbFile() {
    const url = process.env.DATABASE_URL || 'file:../../data/app.db';
    const raw = url.replace(/^file:/, '');
    if (path_1.default.isAbsolute(raw))
        return raw;
    return path_1.default.resolve(__dirname, '..', '..', 'prisma', raw);
}
let dbFile = resolveDbFile();
let client = new client_1.PrismaClient();
/** 当前工程文件（绝对路径） */
function getDbFile() {
    return dbFile;
}
/**
 * 切到另一个工程（.db 文件）。
 * 旧连接异步断开，不阻塞当前请求；新实例立刻可用。
 * 调用方负责先校验目标文件可用，并在失败时回滚（见 routes/workspace.ts）。
 */
function switchDb(absPath) {
    const old = client;
    dbFile = absPath;
    client = new client_1.PrismaClient({ datasources: { db: { url: 'file:' + absPath } } });
    try {
        void old.$disconnect();
    }
    catch {
        /* 断开失败无所谓，交给 GC */
    }
    return client;
}
/**
 * 默认导出用 Proxy 包一层：
 * 全项目路由都是 `prisma.xxx.yyy()` 的写法，这样切换工程时**不用改任何一处调用点**。
 */
const prisma = new Proxy({}, {
    get(_target, prop) {
        const v = client[prop];
        return typeof v === 'function' ? v.bind(client) : v;
    },
});
exports.default = prisma;
