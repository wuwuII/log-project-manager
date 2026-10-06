// ⚠️ 必须第一行：先加载 .env，再 new PrismaClient()
// （PrismaClient 运行时不会自己读 .env，不先加载会报 DATABASE_URL 找不到）
import './env';
import { PrismaClient } from '@prisma/client';
import path from 'path';

/**
 * 当前工程（= 一个 .db 文件）的绝对路径。
 *
 * ⚠️ Prisma 里 DATABASE_URL 相对路径的基准是 **schema.prisma 所在目录**（backend/prisma/），
 *    不是 cwd —— 这个坑 2026-10-02「备份路径」那次踩过，这里按同样的规则解析。
 *    __dirname：编译后 = backend/dist/lib，tsx 直跑 = backend/src/lib → 两种都是 ../../prisma。
 */
function resolveDbFile(): string {
  const url = process.env.DATABASE_URL || 'file:../../data/app.db';
  const raw = url.replace(/^file:/, '');
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(__dirname, '..', '..', 'prisma', raw);
}

let dbFile = resolveDbFile();
let client = new PrismaClient();

/** 当前工程文件（绝对路径） */
export function getDbFile(): string {
  return dbFile;
}

/**
 * 切到另一个工程（.db 文件）。
 * 旧连接异步断开，不阻塞当前请求；新实例立刻可用。
 * 调用方负责先校验目标文件可用，并在失败时回滚（见 routes/workspace.ts）。
 */
export function switchDb(absPath: string): PrismaClient {
  const old = client;
  dbFile = absPath;
  client = new PrismaClient({ datasources: { db: { url: 'file:' + absPath } } });
  try {
    void old.$disconnect();
  } catch {
    /* 断开失败无所谓，交给 GC */
  }
  return client;
}

/**
 * 默认导出用 Proxy 包一层：
 * 全项目路由都是 `prisma.xxx.yyy()` 的写法，这样切换工程时**不用改任何一处调用点**。
 */
const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop: string) {
    const v = (client as any)[prop];
    return typeof v === 'function' ? v.bind(client) : v;
  },
});

export default prisma;
