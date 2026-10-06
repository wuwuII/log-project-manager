/**
 * 心跳接口 + 关页自动退出看门狗 —— 方案 C3 第 3 块
 *
 * 机制：
 *   · 页面每 10 秒 `POST /api/heartbeat` 一次，后端记录「最后一次心跳时间」；
 *   · 后端每 10 秒检查一次，**连续 90 秒**没收到心跳 → 优雅退出；
 *   · 退出前先落盘：SQLite `PRAGMA wal_checkpoint(TRUNCATE)` + `prisma.$disconnect()`。
 *
 * 90 秒容差：刷新页面、短暂卡顿、切窗口都不会误停。
 *
 * 🔴 安全阀：看门狗**只在环境变量 `LPM_WATCHDOG=1` 时启用**。
 *    否则本地开发、`curl` 冒烟测试会因为不发心跳被误杀。启动器脚本负责带上这个变量。
 */
import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

const WATCHDOG = process.env.LPM_WATCHDOG === '1';
const CHECK_INTERVAL_MS = 10 * 1000; // 每 10 秒检查一次
const IDLE_TIMEOUT_MS = 90 * 1000; // 连续 90 秒无心跳 → 退出

let lastBeat = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

/** 记录一次心跳 */
export function beat(): void {
  lastBeat = Date.now();
}

export function watchdogEnabled(): boolean {
  return WATCHDOG;
}

export function msSinceLastBeat(): number {
  return Date.now() - lastBeat;
}

/**
 * 优雅退出：先落盘，再结束进程。可被看门狗、SIGINT/SIGTERM 共用；
 * 用 shuttingDown 保证只会真正执行一次（多次触发只生效一次）。
 */
export async function gracefulShutdown(reason: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  console.log(`[LPM] 退出中（${reason}），先落盘…`);
  try {
    // WAL 里可能还有未合并进主库的数据；TRUNCATE 把它写回主库并清空 WAL。
    // ⚠️ 这个 PRAGMA 会**返回一行结果**，必须用 $queryRawUnsafe：
    //    用 $executeRawUnsafe 会报 "Execute returned results, which is not allowed in SQLite"
    //    （2026-10-06 实测踩到）。本库当前 journal_mode=delete 时它是安全空操作。
    await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);');
    console.log('[LPM] SQLite WAL checkpoint 完成');
  } catch (e) {
    console.error('[LPM] WAL checkpoint 失败：', e);
  }
  try {
    await prisma.$disconnect();
    console.log('[LPM] Prisma 已断开');
  } catch (e) {
    console.error('[LPM] Prisma 断开失败：', e);
  }
  process.exit(code);
}

export default async function (app: FastifyInstance) {
  // 心跳路由：无论看门狗开没开都注册（否则前端心跳会 404）
  app.post('/api/heartbeat', async () => {
    beat();
    return { ok: true, ts: Date.now(), watchdog: WATCHDOG };
  });

  if (!WATCHDOG) {
    app.log.info('[LPM] 心跳看门狗未启用（LPM_WATCHDOG != 1）');
    return;
  }

  // 启动即视为收到一次心跳，避免「刚启动还没等到页面」就被判超时
  beat();
  timer = setInterval(() => {
    const idle = msSinceLastBeat();
    if (idle >= IDLE_TIMEOUT_MS) {
      void gracefulShutdown(`连续约 ${Math.round(idle / 1000)} 秒无心跳`);
    }
  }, CHECK_INTERVAL_MS);

  app.log.info('[LPM] 心跳看门狗已启用：每 10s 检查，90s 无心跳则优雅退出');
}
