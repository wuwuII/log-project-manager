import Fastify from 'fastify';
import cors from '@fastify/cors';
import prisma from './lib/prisma';
import { todayStr } from './lib/date';
import tablesRoutes from './routes/tables';
import logsRoutes from './routes/logs';
import todosRoutes from './routes/todos';
import projectsRoutes from './routes/projects';
import peopleRoutes from './routes/people';
import dataRoutes from './routes/data';
import workspaceRoutes from './routes/workspace';
import recycleRoutes from './routes/recycle';
import remindersRoutes from './routes/reminders'; // 2026-10-08 提醒功能
// ── 方案 C3 新增 ──────────────────────────────────────────────
import staticPlugin from './lib/static';
import heartbeatRoutes, { gracefulShutdown } from './routes/heartbeat';
import { refreshProjectState, isProjectMissing, projectMissingPath } from './lib/project-state';

const app = Fastify({ logger: true, trustProxy: true });

async function ensureDefaultTables() {
  const n = await prisma.tableMeta.count({ where: { deleted_at: null } });
  if (n > 0) return;
  const defaults = [
    { name: '日志', type: 'log', sort_order: 0 },
    { name: '项目计划', type: 'project', sort_order: 1 },
    { name: '人员', type: 'people', sort_order: 2 },
  ];
  for (const d of defaults) {
    await prisma.tableMeta.create({ data: { ...d, config: '{}' } });
  }
  // 项目计划表配一个默认项目，否则甘特图是空的
  const projTable = await prisma.tableMeta.findFirst({ where: { type: 'project', deleted_at: null } });
  if (projTable) {
    const p = await prisma.project.create({
      data: { table_id: projTable.id, name: '默认项目', status: 'active', start_date: todayStr() },
    });
    await prisma.tableMeta.update({ where: { id: projTable.id }, data: { config: JSON.stringify({ project_id: p.id }) } });
  }
  console.log('[init] 已创建默认工作表：日志 / 项目计划 / 人员');
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
  await app.register(cors, { origin: true });

  // 全局处理空 JSON body（axios 不带 data 的 POST/PATCH/DELETE 会被 Fastify 框架层拦成 400）
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body: string, done) => {
    try {
      done(null, body.length > 0 ? JSON.parse(body) : {});
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.get('/api/health', async () => ({ status: 'ok', service: 'lpm', ts: Date.now() }));

  await app.register(tablesRoutes);
  await app.register(logsRoutes);
  await app.register(todosRoutes);
  await app.register(projectsRoutes);
  await app.register(peopleRoutes);
  await app.register(dataRoutes);
  await app.register(workspaceRoutes);
  await app.register(recycleRoutes);
  await app.register(remindersRoutes); // 2026-10-08 提醒功能
  await app.register(heartbeatRoutes); // 方案 C3：心跳 + 看门狗

  // ── 方案 C3 第 5 块：工程文件缺失保护 ──────────────────────
  // 关键：文件不在时**绝不** ensureDefaultTables（那会静默建空库），也不放行业务接口。
  const missing = refreshProjectState();
  if (missing) {
    console.error(`[LPM] ⚠️ 当前工程文件不存在：${projectMissingPath()}`);
    console.error('[LPM] 已进入「工程文件缺失」保护模式：不会静默新建空库；请在页面里选一个新位置。');
  } else {
    await ensureDefaultTables();
  }

  app.addHook('onRequest', async (req, reply) => {
    if (!isProjectMissing()) return;
    if (req.method === 'OPTIONS') return;
    const url = (req.raw.url || '').split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (ALLOW_WHEN_MISSING.has(url)) return;
    reply.status(409).send({
      error: 'project_file_missing',
      current_path: projectMissingPath(),
      message: '工程文件没找到，请选一下新位置',
    });
  });

  // ── 方案 C3 第 1 块：静态托管前端（必须最后注册，通配路由兜底）──
  await app.register(staticPlugin);

  const port = Number(process.env.PORT) || 3000;
  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`LPM backend running on :${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// ── 方案 C3：进程退出钩子做落盘（与看门狗共用 gracefulShutdown）──
process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});

start();
