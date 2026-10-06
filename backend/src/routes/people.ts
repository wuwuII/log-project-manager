import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { logChange, recalcPersonPoints } from '../lib/history';
import { addDays, todayStr, ymd } from '../lib/date';

/** 20 色高对比调色板（照抄任务公会 Ranking.tsx 的 PALETTE） */
const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
  '#dcbeff', '#9a6324', '#800000', '#aaffc3', '#808000',
  '#ffd8b1', '#000075', '#e6beff', '#ffb469', '#8a2be2',
];

const round2 = (n: number) => Math.round(n * 100) / 100;

export default async function (app: FastifyInstance) {
  // ── 人员列表 ──────────────────────────────────────────────
  app.get('/api/people', async () => {
    const people = await prisma.person.findMany({
      where: { deleted_at: null },
      orderBy: [{ created_at: 'asc' }],
    });
    return { people };
  });

  // ── 增加人员 ──────────────────────────────────────────────
  app.post('/api/people', async (req, reply) => {
    const schema = z.object({
      name: z.string().min(1).max(50),
      role: z.string().max(50).nullish(),
      color: z.string().max(9).nullish(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败' });

    const dup = await prisma.person.findFirst({
      where: { name: parsed.data.name, deleted_at: null },
    });
    if (dup) return reply.status(400).send({ error: '同名人员已存在' });

    const p = await prisma.person.create({
      data: { name: parsed.data.name, role: parsed.data.role ?? null, color: parsed.data.color ?? null },
    });
    await logChange({ record_id: p.id, entity: 'person', action: 'create', after: p });
    return p;
  });

  // ── 编辑人员 ──────────────────────────────────────────────
  app.patch('/api/people/:id', async (req, reply) => {
    const { id } = req.params as any;
    const schema = z.object({
      name: z.string().min(1).max(50).optional(),
      role: z.string().max(50).nullish(),
      color: z.string().max(9).nullish(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败' });
    const before = await prisma.person.findUnique({ where: { id } });
    if (!before) return reply.status(404).send({ error: '人员不存在' });
    const after = await prisma.person.update({ where: { id }, data: parsed.data as any });
    await logChange({ record_id: id, entity: 'person', action: 'update', before, after });
    return after;
  });

  // ── 删除人员（软删除）─────────────────────────────────────
  app.delete('/api/people/:id', async (req) => {
    const { id } = req.params as any;
    const before = await prisma.person.findUnique({ where: { id } });
    await prisma.person.update({ where: { id }, data: { deleted_at: new Date() } });
    await logChange({ record_id: id, entity: 'person', action: 'delete', before });
    return { ok: true };
  });

  // ── 每日积分（人员工作量柱状图数据源）────────────────────────
  // 照任务公会 /api/points/daily 的模型，映射到本项目：
  //   expected（计划得到的）= 每个任务的 points 按 [plan_start, plan_end] 每天均摊
  //   actual  （已经得到的）= points_ledger 流水，按发生当天记
  //   每个「事项」一个固定颜色；按项目（=任务公会里的"团队"）分组
  app.get('/api/points/daily', async (req, reply) => {
    const { person_id, project_ids } = req.query as any;
    if (!person_id) return reply.status(400).send({ error: 'person_id 必填' });

    const person = await prisma.person.findUnique({ where: { id: person_id } });

    // ── 1. expected：该人的项目任务 ──
    const taskWhere: any = { assignee_id: person_id, deleted_at: null };
    if (project_ids) {
      const ids = String(project_ids).split(',').filter(Boolean);
      if (ids.length) taskWhere.project_id = { in: ids };
    }
    const tasks = await prisma.projectTask.findMany({
      where: taskWhere,
      orderBy: [{ plan_start: 'asc' }],
    });

    const projects = await prisma.project.findMany({ where: { deleted_at: null } });
    const projName: Record<string, string> = {};
    projects.forEach((p) => { projName[p.id] = p.name; });

    const colorByKey: Record<string, string> = {};
    let colorSeq = 0;
    const colorOf = (key: string) => {
      if (!colorByKey[key]) {
        colorByKey[key] = PALETTE[colorSeq % PALETTE.length];
        colorSeq += 1;
      }
      return colorByKey[key];
    };

    const taskMap: Record<string, any> = {};
    const expectedMap: Record<string, any[]> = {};

    for (const t of tasks) {
      if (!t.plan_start) continue;
      const key = 'T:' + t.id;
      const dur = Math.max(1, t.plan_duration || 1);
      const perDay = round2((t.points || 0) / dur);
      taskMap[key] = {
        title: t.name,
        color: colorOf(key),
        kind: 'task',
        project_id: t.project_id,
        project_name: projName[t.project_id] || '未命名项目',
        total_points: t.points || 0,
        progress: t.progress || 0,
      };
      for (let i = 0; i < dur; i++) {
        const ds = addDays(t.plan_start, i);
        if (!ds) continue;
        if (!expectedMap[ds]) expectedMap[ds] = [];
        expectedMap[ds].push({ key, title: t.name, points: perDay });
      }
    }

    // ── 2. actual：该人的积分流水 ──
    // 照任务公会做法：把每个「来源」的流水按时间区间**均摊到每一天**，
    // 这样图上看到的是"每天承接/挣到的工作量"，而不是记账当天的孤立尖峰。
    const ledger = await prisma.pointsLedger.findMany({
      where: { person_id },
      orderBy: { created_at: 'asc' },
    });

    const srcKeyOf = (l: any) => {
      if (l.source_id) {
        return (l.source_type === 'project_task' ? 'T:' : l.source_type === 'todo' ? 'D:' : 'X:') + l.source_id;
      }
      return 'M:' + (l.source_type || 'manual');
    };

    const actualMap: Record<string, any[]> = {};
    const addActual = (ds: string, key: string, pts: number) => {
      if (!actualMap[ds]) actualMap[ds] = [];
      actualMap[ds].push({ key, title: taskMap[key]?.title || '', points: round2(pts) });
    };

    // 按来源分组
    const bySource: Record<string, any[]> = {};
    for (const l of ledger) {
      if (!l.points) continue;
      const key = srcKeyOf(l);
      if (!taskMap[key]) {
        taskMap[key] = {
          title: l.reason || (l.source_type === 'manual' ? '手工调整' : l.source_type || '其他'),
          color: colorOf(key),
          kind: l.source_type || 'other',
          project_id: null,
          project_name:
            l.source_type === 'todo' ? '待办' : l.source_type === 'manual' ? '手工调整' : '其他',
        };
      }
      if (!bySource[key]) bySource[key] = [];
      bySource[key].push(l);
    }

    const midnight = (s: string) => new Date(s + 'T00:00:00');
    for (const key of Object.keys(bySource)) {
      const rows = bySource[key].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
      // 起始日：任务优先用它的计划开始日；但若计划开始日**晚于**第一条流水日
      // （数据不一致：还没开工就记了分），必须取较早者，否则均摊区间落到未来、
      // 这部分分会凭空丢失（真踩过：接口开发 16 分没进 actual）。
      let prevDate = ymd(new Date(rows[0].created_at));
      const tk = tasks.find((x) => 'T:' + x.id === key);
      if (tk?.plan_start && tk.plan_start < prevDate) prevDate = tk.plan_start;

      for (const l of rows) {
        const currDate = ymd(new Date(l.created_at));
        const d1 = midnight(prevDate);
        const d2 = midnight(currDate);
        const days = Math.max(1, Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1);
        const perDay = l.points / days;
        for (let d = new Date(d1); d <= d2; d.setDate(d.getDate() + 1)) {
          addActual(ymd(d), key, perDay);
        }
        prevDate = currDate;
      }
    }

    // ── 3. 组装连续日期区间 ──
    const allDates = [
      ...Object.keys(expectedMap),
      ...Object.keys(actualMap),
      todayStr(),
    ].sort();
    const minD = allDates[0];
    const maxD = allDates[allDates.length - 1];

    const today = todayStr();
    const expected: any[] = [];
    const actual: any[] = [];
    if (minD && maxD) {
      let cur = minD;
      let guard = 0;
      while (cur <= maxD && guard < 2000) {
        expected.push({ date: cur, tasks: expectedMap[cur] || [] });
        if (cur <= today) actual.push({ date: cur, tasks: actualMap[cur] || [] });
        const nxt = addDays(cur, 1);
        if (!nxt) break;
        cur = nxt;
        guard += 1;
      }
    }

    // ── 4. 汇总 ──
    const thisMonth = today.substring(0, 7);
    const expAll = Object.values(expectedMap).flat();
    const actAll = Object.values(actualMap).flat();
    const sum = (arr: any[]) => arr.reduce((s, x) => s + (x.points || 0), 0);
    const avg = (arr: any[]) => (arr.length ? Math.round(sum(arr) / arr.length) : 0);

    return {
      person: person
        ? { id: person.id, name: person.name, role: person.role, color: person.color }
        : null,
      summary: {
        task_count: tasks.length,
        done_count: tasks.filter((t) => t.status === 'done').length,
        avg_daily_expected: avg(expAll),
        total_expected_this_month: round2(
          Object.entries(expectedMap).filter(([d]) => d.startsWith(thisMonth)).flatMap(([, v]) => v).reduce((s, x) => s + x.points, 0)
        ),
        avg_daily_actual: avg(actAll),
        total_actual_this_month: round2(
          Object.entries(actualMap).filter(([d]) => d.startsWith(thisMonth)).flatMap(([, v]) => v).reduce((s, x) => s + x.points, 0)
        ),
        total_actual: round2(person?.total_points || 0),
      },
      from: minD || '',
      to: maxD || '',
      today,
      expected,
      actual,
      task_map: taskMap,
    };
  });

  // ── 积分汇总（柱状图数据源）────────────────────────────────
  app.get('/api/points/summary', async (req) => {
    const { person_ids, from, to } = req.query as any;
    const where: any = {};
    if (person_ids) {
      const ids = String(person_ids).split(',').filter(Boolean);
      if (ids.length) where.person_id = { in: ids };
    }
    if (from || to) {
      where.created_at = {};
      if (from) where.created_at.gte = new Date(from + 'T00:00:00');
      if (to) where.created_at.lte = new Date(to + 'T23:59:59');
    }

    const rows = await prisma.pointsLedger.groupBy({
      by: ['person_id'],
      where,
      _sum: { points: true },
    });
    const people = await prisma.person.findMany({ where: { deleted_at: null } });
    const pMap = Object.fromEntries(people.map((p) => [p.id, p]));
    const items = people.map((p) => {
      const hit = rows.find((r) => r.person_id === p.id);
      return {
        person_id: p.id,
        name: p.name,
        role: p.role,
        color: p.color,
        total_points: Math.round((p.total_points || 0) * 100) / 100,
        range_points: Math.round(((hit?._sum.points || 0)) * 100) / 100,
      };
    });
    return { items };
  });

  // ── 积分流水 ──────────────────────────────────────────────
  app.get('/api/points/ledger', async (req) => {
    const { person_id, limit } = req.query as any;
    const where: any = {};
    if (person_id) where.person_id = person_id;
    const rows = await prisma.pointsLedger.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: Math.min(Number(limit) || 200, 1000),
    });
    return { ledger: rows };
  });

  // ── 重算某人积分（纠错用，流水是唯一真相）────────────────────
  app.post('/api/points/recalc/:person_id', async (req) => {
    const { person_id } = req.params as any;
    const total = await recalcPersonPoints(person_id);
    return { ok: true, total_points: total };
  });

  // ── 手工加减分 ────────────────────────────────────────────
  app.post('/api/points/manual', async (req, reply) => {
    const schema = z.object({
      person_id: z.string().min(1),
      points: z.number(),
      reason: z.string().max(200).optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败' });
    const { addPoints } = await import('../lib/history');
    await addPoints({
      person_id: parsed.data.person_id,
      points: parsed.data.points,
      source_type: 'manual',
      reason: parsed.data.reason ?? '手工调整',
    });
    const p = await prisma.person.findUnique({ where: { id: parsed.data.person_id } });
    return p;
  });
}
