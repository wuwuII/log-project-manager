import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { logChange } from '../lib/history';

const upsertLog = async (body: any) => {
  const schema = z.object({
    table_id: z.string().min(1),
    entry_date: z.string().min(8).max(10),
    content: z.string().default(''),
    created_by: z.string().nullish(),
  });
  const parsed = schema.safeParse(body || {});
  if (!parsed.success) return { error: '参数校验失败', detail: parsed.error.issues };
  const { table_id, entry_date, content, created_by } = parsed.data;

  const before = await prisma.logEntry.findUnique({
    where: { table_id_entry_date: { table_id, entry_date } },
  });
  const after = await prisma.logEntry.upsert({
    where: { table_id_entry_date: { table_id, entry_date } },
    create: { table_id, entry_date, content, created_by: created_by ?? null },
    update: { content },
  });
  await logChange({
    table_id,
    record_id: after.id,
    entity: 'log_entry',
    action: before ? 'update' : 'create',
    before,
    after,
  });
  return after;
};

export default async function (app: FastifyInstance) {
  // ── 日志列表（按工作表 + 日期范围）──────────────────────────
  app.get('/api/logs', async (req) => {
    const { table_id, from, to } = req.query as any;
    if (!table_id) return { logs: [] };
    const where: any = { table_id };
    if (from || to) {
      where.entry_date = {};
      if (from) where.entry_date.gte = from;
      if (to) where.entry_date.lte = to;
    }
    const logs = await prisma.logEntry.findMany({
      where,
      orderBy: { entry_date: 'asc' },
    });
    return { logs };
  });

  // ── 新增/更新日志 ─────────────────────────────────────────
  app.post('/api/logs', async (req, reply) => {
    const r = await upsertLog(req.body);
    if ((r as any).error) return reply.status(400).send(r);
    return r;
  });

  // ── 自动保存端点（前端 debounce / 失焦 / sendBeacon 都打这里）────
  app.post('/api/logs/autosave', async (req, reply) => {
    const r = await upsertLog(req.body);
    if ((r as any).error) return reply.status(400).send(r);
    return { ok: true, saved: r };
  });

  // ── 更新日志（按 id）──────────────────────────────────────
  app.patch('/api/logs/:id', async (req, reply) => {
    const { id } = req.params as any;
    const schema = z.object({ content: z.string() });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败' });
    const before = await prisma.logEntry.findUnique({ where: { id } });
    if (!before) return reply.status(404).send({ error: '日志不存在' });
    const after = await prisma.logEntry.update({ where: { id }, data: { content: parsed.data.content } });
    await logChange({ table_id: after.table_id, record_id: id, entity: 'log_entry', action: 'update', before, after });
    return after;
  });
}
