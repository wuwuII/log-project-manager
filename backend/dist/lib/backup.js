"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.dbFilePath = dbFilePath;
exports.backupsDir = backupsDir;
exports.backupDbFile = backupDbFile;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/**
 * 备份基础设施 —— 2026-10-05 从 `routes/data.ts` 原样抽出，供回收站（recycle）复用，
 * 避免两处复制粘贴造成逻辑漂移。
 *
 * ⚠️ 路径基准：Prisma 把 `DATABASE_URL` 的**相对路径**解释为「相对 schema.prisma 所在目录」
 *    （即 backend/prisma/），不是 cwd。本文件编译后位于 `backend/dist/lib/`，
 *    tsx 直跑位于 `backend/src/lib/`，两种情况下
 *    `path.resolve(__dirname, '..', '..', 'prisma')` 都解析到 `backend/prisma`
 *    —— 与抽取前 `routes/data.ts`（dists: dist/routes、src: src/routes）的解析结果完全一致。
 */
/** 数据库文件位置（照 Prisma 的解析规则，保证与 Prisma 实际使用的是同一个文件） */
function dbFilePath() {
    const url = process.env.DATABASE_URL || 'file:../../data/app.db';
    const rel = url.replace(/^file:/, '');
    if (path_1.default.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel))
        return rel; // 绝对路径（含 Windows 盘符）
    const schemaDir = path_1.default.resolve(__dirname, '..', '..', 'prisma'); // backend/prisma
    return path_1.default.resolve(schemaDir, rel);
}
/** 备份目录（data/backups） */
function backupsDir() {
    return path_1.default.join(path_1.default.dirname(dbFilePath()), 'backups');
}
/** 备份数据库文件，返回备份路径（保留最近 20 份，逻辑与抽取前一致） */
async function backupDbFile() {
    const dir = backupsDir();
    fs_1.default.mkdirSync(dir, { recursive: true });
    const src = dbFilePath();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let dst = path_1.default.join(dir, `app-${ts}.db`);
    // ⚠️ 2026-10-05 审查意见：同一秒内第二次破坏性操作不能覆盖前一次的备份，补毫秒后缀
    if (fs_1.default.existsSync(dst)) {
        const ms = String(new Date().getMilliseconds()).padStart(3, '0');
        dst = path_1.default.join(dir, `app-${ts}-${ms}.db`);
    }
    if (fs_1.default.existsSync(src)) {
        fs_1.default.copyFileSync(src, dst);
        // 只保留最近 20 份
        const all = fs_1.default.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
        while (all.length > 20) {
            const old = all.shift();
            try {
                fs_1.default.unlinkSync(path_1.default.join(dir, old));
            }
            catch { }
        }
    }
    return dst;
}
