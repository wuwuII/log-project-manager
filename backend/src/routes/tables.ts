import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { logChange } from '../lib/history';
import { todayStr } from '../lib/date';

export default async function (app: FastifyInstance) {
  // ── 所有工作表（永久工作表栏的数据源）─────────────────────────
  app.get('/api/tables', async () => {
    const tables = await prisma.tableMeta.findMany({
      where: { deleted_at: null },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
    });
    return { tables };
  });

  // ── 新建工作表 ────────────────────────────────────────────
  app.post('/api/tables', async (req, reply) => {
    const schema = z.object({
      name: z.string().min(1).max(100),
      type: z.enum(['log', 'project', 'people']).default('log'),
      config: z.any().optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败', detail: parsed.error.issues });

    const max = await prisma.tableMeta.aggregate({ _max: { sort_order: true } });
    const t = await prisma.tableMeta.create({
      data: {
        name: parsed.data.name,
        type: parsed.data.type,
        config: JSON.stringify(parsed.data.config || {}),
        sort_order: (max._max.sort_order ?? -1) + 1,
      },
    });
    // 项目类型的工作表自动带一个项目，否则页面没内容
    if (t.type === 'project') {
      const p = await prisma.project.create({
        data: { table_id: t.id, name: parsed.data.name, status: 'active', start_date: todayStr() },
      });
      const updated = await prisma.tableMeta.update({
        where: { id: t.id },
        data: { config: JSON.stringify({ project_id: p.id }) },
      });
      await logChange({ table_id: t.id, action: 'create', entity: 'table', after: updated });
      return updated;
    }
    await logChange({ table_id: t.id, action: 'create', entity: 'table', after: t });
    return t;
  });

  // ── 拖动排序：批量写 sort_order（工作表栏拖完 / 右键「左移右移」后
  //    前端把整串新顺序发过来）─────────────────────────────────────
  // 🔴 2026-10-06 新增。照抄 backend/src/routes/todos.ts 的 /api/todos/reorder：
  //    入参 {ordered_ids: string[]}，按数组下标写 sort_order，一个事务批量 update，
  //    用现有 logChange 记一条。返回 {ok,count}。
  app.patch('/api/tables/reorder', async (req, reply) => {
    const schema = z.object({ ordered_ids: z.array(z.string().min(1)).min(1) });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败' });
    const ids = parsed.data.ordered_ids;
    await prisma.$transaction(
      ids.map((id, i) => prisma.tableMeta.updateMany({ where: { id }, data: { sort_order: i } })),
    );
    await logChange({ entity: 'table', action: 'update', after: { reorder_count: ids.length } });
    return { ok: true, count: ids.length };
  });

  // ── 重命名 / 改配置 / 调顺序 ─────────────────────────────────
  app.patch('/api/tables/:id', async (req, reply) => {
    const { id } = req.params as any;
    const schema = z.object({
      name: z.string().min(1).max(100).optional(),
      config: z.any().optional(),
      sort_order: z.number().optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败' });

    const before = await prisma.tableMeta.findUnique({ where: { id } });
    if (!before) return reply.status(404).send({ error: '工作表不存在' });

    const data: any = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.config !== undefined) data.config = JSON.stringify(parsed.data.config);
    if (parsed.data.sort_order !== undefined) data.sort_order = parsed.data.sort_order;

    const after = await prisma.tableMeta.update({ where: { id }, data });
    await logChange({ table_id: id, action: 'update', entity: 'table', before, after });
    return after;
  });

  // ── 复制工作表（连同表内数据）──────────────────────────────────
  app.post('/api/tables/:id/duplicate', async (req, reply) => {
    const { id } = req.params as any;
    const src = await prisma.tableMeta.findUnique({ where: { id } });
    if (!src || src.deleted_at) return reply.status(404).send({ error: '工作表不存在' });

    const max = await prisma.tableMeta.aggregate({ _max: { sort_order: true } });
    const copy = await prisma.tableMeta.create({
      data: {
        name: src.name + ' 副本',
        type: src.type,
        config: src.config,
        sort_order: (max._max.sort_order ?? -1) + 1,
      },
    });

    // 数据复制
    if (src.type === 'log') {
      const entries = await prisma.logEntry.findMany({ where: { table_id: id } });
      for (const e of entries) {
        await prisma.logEntry.create({
          data: { table_id: copy.id, entry_date: e.entry_date, content: e.content, created_by: e.created_by },
        });
      }
      const todos = await prisma.todo.findMany({ where: { table_id: id, deleted_at: null } });
      for (const t of todos) {
        await prisma.todo.create({
          data: {
            table_id: copy.id, title: t.title, assignee_id: t.assignee_id, points: t.points,
            status: t.status, record_time: t.record_time, completed_at: t.completed_at, sort_order: t.sort_order,
          },
        });
      }
    } else if (src.type === 'project') {
      const srcCfg = JSON.parse(src.config || '{}');
      const srcProject = srcCfg.project_id
        ? await prisma.project.findUnique({ where: { id: srcCfg.project_id } })
        : await prisma.project.findFirst({ where: { table_id: id, deleted_at: null } });
      if (srcProject) {
        const np = await prisma.project.create({
          data: {
            table_id: copy.id, name: srcProject.name + ' 副本', description: srcProject.description,
            start_date: srcProject.start_date, end_date: srcProject.end_date, status: srcProject.status,
          },
        });
        const tasks = await prisma.projectTask.findMany({ where: { project_id: srcProject.id, deleted_at: null } });
        // 两轮：先建（保住旧的 parent 映射），再补 parent_id
        const idMap: Record<string, string> = {};
        for (const t of tasks) {
          const nt = await prisma.projectTask.create({
            data: {
              project_id: np.id, parent_id: null, name: t.name, plan_start: t.plan_start,
              plan_duration: t.plan_duration, plan_end: t.plan_end, actual_start: t.actual_start,
              actual_end: t.actual_end, progress: t.progress, assignee_id: t.assignee_id,
              points: t.points, earned_points: t.earned_points, status: t.status, sort_order: t.sort_order,
            },
          });
          idMap[t.id] = nt.id;
        }
        for (const t of tasks) {
          if (t.parent_id && idMap[t.parent_id]) {
            await prisma.projectTask.update({ where: { id: idMap[t.id] }, data: { parent_id: idMap[t.parent_id] } });
          }
        }
        await prisma.tableMeta.update({ where: { id: copy.id }, data: { config: JSON.stringify({ project_id: np.id }) } });
      }
    }

    await logChange({ table_id: copy.id, action: 'create', entity: 'table_duplicate', after: copy });

    /**
     * 🔴 修（2026-10-02 测试发现）：project 类型复制时，第 140 行把 copy 的 config
     * 更新成了新 project_id，但 `copy` 这个内存对象是第 83 行创建的、config 还是旧的。
     * 直接 return copy 会把过期的 config（指向源项目）返回给前端，
     * 前端若拿返回值切表就会打开错误的项目。这里统一重新查一次再返回。
     */
    const fresh = await prisma.tableMeta.findUnique({ where: { id: copy.id } });
    return fresh ?? copy;
  });

  // ── 软删除工作表 ───────────────────────────────────────────
  app.delete('/api/tables/:id', async (req) => {
    const { id } = req.params as any;
    const before = await prisma.tableMeta.findUnique({ where: { id } });
    await prisma.tableMeta.update({ where: { id }, data: { deleted_at: new Date() } });
    await logChange({ table_id: id, action: 'delete', entity: 'table', before });
    return { ok: true };
  });

  // ── 单个工作表详情 ─────────────────────────────────────────
  app.get('/api/tables/:id', async (req, reply) => {
    const { id } = req.params as any;
    const t = await prisma.tableMeta.findUnique({ where: { id } });
    if (!t) return reply.status(404).send({ error: '工作表不存在' });
    return t;
  });
}
