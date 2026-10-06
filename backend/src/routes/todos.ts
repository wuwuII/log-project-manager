import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { logChange, addPoints } from '../lib/history';
import { calcPlanEnd, deriveTaskStatus } from '../lib/points';

export default async function (app: FastifyInstance) {
  // ── 待办列表 ──────────────────────────────────────────────
  app.get('/api/todos', async (req) => {
    const { table_id } = req.query as any;
    const where: any = { deleted_at: null };
    if (table_id) where.table_id = table_id;
    const todos = await prisma.todo.findMany({
      where,
      orderBy: [{ status: 'asc' }, { sort_order: 'asc' }, { created_at: 'desc' }],
    });
    return { todos };
  });

  // ── 新增待办 ──────────────────────────────────────────────
  app.post('/api/todos', async (req, reply) => {
    const schema = z.object({
      table_id: z.string().min(1),
      title: z.string().min(1).max(200),
      assignee_id: z.string().nullish(),
      points: z.number().int().default(0),
      note: z.string().nullish(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败', detail: parsed.error.issues });

    // 2026-10-06 用户要求：新建的待办要排在最上面 → 取当前最小值 -1
    const min = await prisma.todo.aggregate({
      where: { table_id: parsed.data.table_id, deleted_at: null },
      _min: { sort_order: true },
    });
    const t = await prisma.todo.create({
      data: {
        table_id: parsed.data.table_id,
        title: parsed.data.title,
        points: parsed.data.points,
        assignee_id: parsed.data.assignee_id ?? null,
        note: parsed.data.note ?? null,
        sort_order: (min._min.sort_order ?? 1) - 1,
      },
    });
    await logChange({ table_id: t.table_id, record_id: t.id, entity: 'todo', action: 'create', after: t });
    return t;
  });

  // ── 【必须在 /api/todos/:id 之前】待办 → 项目计划 ─────────────
  app.post('/api/todos/:id/to-project', async (req, reply) => {
    const { id } = req.params as any;
    const schema = z.object({
      project_id: z.string().min(1),
      parent_id: z.string().nullish(),
      plan_start: z.string().nullish(),
      plan_duration: z.number().int().min(1).default(1),
      assignee_id: z.string().nullish(),
      points: z.number().int().default(0),
      note: z.string().nullish(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败', detail: parsed.error.issues });

    const todo = await prisma.todo.findUnique({ where: { id } });
    if (!todo || todo.deleted_at) return reply.status(404).send({ error: '待办不存在' });

    const d = parsed.data;
    const planEnd = calcPlanEnd(d.plan_start, d.plan_duration);

    /**
     * 🔴 踩过的坑（2026-10-02 用户在真机上发现）：
     * 不写 sort_order 时数据库默认给 0，会和已有的第 0 号任务撞号，
     * 列表顺序变得不稳定（拖动排序后可能错位）。
     * 正确做法：取同项目现存最大值 +1，排到末尾。
     */
    const maxSort = await prisma.projectTask.aggregate({
      where: { project_id: d.project_id, deleted_at: null },
      _max: { sort_order: true },
    });
    const nextSort = ((maxSort._max.sort_order as number | null) ?? -1) + 1;

    const task = await prisma.projectTask.create({
      data: {
        project_id: d.project_id,
        parent_id: d.parent_id ?? null,
        name: todo.title,
        plan_start: d.plan_start ?? null,
        plan_duration: d.plan_duration,
        plan_end: planEnd,
        progress: 0,
        assignee_id: d.assignee_id ?? todo.assignee_id ?? null,
        points: d.points || todo.points || 0,
        earned_points: 0,
        status: deriveTaskStatus(0, planEnd),
        note: d.note ?? null,
        sort_order: nextSort,
      },
    });

    const updated = await prisma.todo.update({
      where: { id },
      data: {
        transferred: true,
        linked_project_id: d.project_id,
        linked_task_id: task.id,
      },
    });

    await logChange({ table_id: todo.table_id, record_id: id, entity: 'todo', action: 'update', before: todo, after: updated });
    await logChange({ table_id: todo.table_id, record_id: task.id, entity: 'project_task', action: 'create', after: task });
    return { todo: updated, task };
  });

  // ── 更新待办（编辑 / 完成 / 取消完成）────────────────────────
  app.patch('/api/todos/:id', async (req, reply) => {
    const { id } = req.params as any;
    const schema = z.object({
      title: z.string().min(1).max(200).optional(),
      assignee_id: z.string().nullish(),
      points: z.number().int().optional(),
      status: z.enum(['pending', 'done']).optional(),
      sort_order: z.number().int().optional(),
      note: z.string().nullish(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败' });

    const before = await prisma.todo.findUnique({ where: { id } });
    if (!before) return reply.status(404).send({ error: '待办不存在' });

    const d: any = { ...parsed.data };
    const goingDone = d.status === 'done' && before.status !== 'done';
    const goingBack = d.status === 'pending' && before.status === 'done';

    if (goingDone) d.completed_at = new Date();
    if (goingBack) {
      d.completed_at = null;
      // 2026-10-06 用户要求：从"已完成"放回，等同于新建一个待办 → 排待办中第一个
      const mn = await prisma.todo.aggregate({
        where: { table_id: before.table_id, deleted_at: null },
        _min: { sort_order: true },
      });
      d.sort_order = (mn._min.sort_order ?? 1) - 1;
    }

    const after = await prisma.todo.update({ where: { id }, data: d });

    // 完成 → 有负责人且积分>0 才记流水
    if (goingDone && after.assignee_id && after.points) {
      await addPoints({
        person_id: after.assignee_id,
        points: after.points,
        source_type: 'todo',
        source_id: after.id,
        reason: `完成待办：${after.title}`,
      });
    }
    // 取消完成 → 冲回
    if (goingBack && before.assignee_id && before.points) {
      await addPoints({
        person_id: before.assignee_id,
        points: -before.points,
        source_type: 'todo',
        source_id: before.id,
        reason: `取消完成待办：${before.title}`,
      });
    }

    await logChange({
      table_id: after.table_id,
      record_id: after.id,
      entity: 'todo',
      action: goingDone ? 'complete' : 'update',
      before,
      after,
    });
    return after;
  });

  // ── 删除待办（软删除）─────────────────────────────────────
  // ── 拖动排序：批量写 sort_order（前端拖完把新顺序整串发过来）──
  app.patch('/api/todos/reorder', async (req, reply) => {
    const schema = z.object({ ordered_ids: z.array(z.string().min(1)).min(1) });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败' });
    const ids = parsed.data.ordered_ids;
    await prisma.$transaction(
      ids.map((id, i) => prisma.todo.updateMany({ where: { id }, data: { sort_order: i } })),
    );
    await logChange({ entity: 'todo', action: 'update', after: { reorder_count: ids.length } });
    return { ok: true, count: ids.length };
  });

  app.delete('/api/todos/:id', async (req) => {
    const { id } = req.params as any;
    const before = await prisma.todo.findUnique({ where: { id } });
    await prisma.todo.update({ where: { id }, data: { deleted_at: new Date() } });
    await logChange({ table_id: before?.table_id, record_id: id, entity: 'todo', action: 'delete', before });
    return { ok: true };
  });
}
