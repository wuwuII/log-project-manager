"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 极简 .env 加载器（不依赖 dotenv，离线可用）
 *
 * ⚠️ 为什么必须手动做：Prisma **CLI** 会自动读 .env，
 *    但 **PrismaClient 运行时不会** —— 双击启动时 DATABASE_URL 为空，
 *    Prisma 会报 "Environment variable not found: DATABASE_URL"。
 *
 * 本模块必须在 `new PrismaClient()` 之前执行，所以在 lib/prisma.ts
 * 顶部第一行以副作用方式 import。
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
function loadEnv() {
    // 编译后 __dirname = backend/dist/lib；tsx 直跑时 = backend/src/lib
    // 两种情况下 '../..' 都指向 backend/
    const candidates = [
        path_1.default.resolve(__dirname, '..', '..', '.env'),
        path_1.default.resolve(process.cwd(), '.env'),
        path_1.default.resolve(process.cwd(), '..', '.env'),
    ];
    for (const p of candidates) {
        if (!fs_1.default.existsSync(p))
            continue;
        try {
            const text = fs_1.default.readFileSync(p, 'utf-8');
            for (const raw of text.split(/\r?\n/)) {
                const line = raw.trim();
                if (!line || line.startsWith('#'))
                    continue;
                const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
                if (!m)
                    continue;
                const key = m[1];
                if (process.env[key] !== undefined)
                    continue; // 不覆盖已有环境变量
                let val = m[2].trim();
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                process.env[key] = val;
            }
            return;
        }
        catch {
            /* 读失败就继续找下一个候选 */
        }
    }
}
loadEnv();
// 兜底：万一 .env 丢了，也不至于起不来（默认库路径与 .env 里一致）
if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'file:../../data/app.db';
}
if (!process.env.PORT) {
    process.env.PORT = '3000';
}
