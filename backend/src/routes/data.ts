import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import prisma from '../lib/prisma';
import { logChange } from '../lib/history';
import { todayStr } from '../lib/date';
import { backupDbFile, backupsDir, dbFilePath } from '../lib/backup';

/** 导出时各 sheet 的固定名字（导入按它匹配） */
const SHEETS = {
  tables: '工作表',
  logs: '日志',
  todos: '待办',
  projects: '项目',
  projectTasks: '项目任务',
  people: '人员',
  ledger: '积分流水',
  history: '操作历史',
  reminders: '提醒', // 2026-10-08 新增：导出/导入都要带上，否则导出再导回来提醒会丢
};

export default async function (app: FastifyInstance) {
  // ══ 导出为 Excel（每个 table 一个 sheet）══════════════════════
  app.get('/api/export/excel', async (req, reply) => {
    /* 🔴 2026-10-05 新增：单表导出。
       背景：用户反馈工作表右键「导出该表」点了没反应——原来前端只做「切表+弹提示」（空壳），
       后端也只有全库导出。现在带 ?table_id= 时只导这一张工作表的内容。 */
    const onlyId = (req.query as any)?.table_id as string | undefined;
    if (onlyId) {
      const one = await prisma.tableMeta.findUnique({ where: { id: onlyId } });
      if (!one) return reply.status(404).send({ error: '工作表不存在' });
      const wb2 = XLSX.utils.book_new();
      const add2 = (name: string, rows2: any[]) =>
        XLSX.utils.book_append_sheet(wb2, XLSX.utils.json_to_sheet(rows2.length ? rows2 : [{}]), name.slice(0, 31));
      const safeName = one.name.replace(/[\\/?*[\]:]/g, '_');
      add2('说明', [
        { 项: '这个文件是什么', 说明: `单表导出：「${one.name}」（类型：${one.type}）。` },
        { 项: '导出时间', 说明: todayStr() },
      ]);
      const ppl = await prisma.person.findMany({ where: { deleted_at: null } });
      const pMap2 = Object.fromEntries(ppl.map((p) => [p.id, p.name]));
      if (one.type === 'log') {
        const myLogs = await prisma.logEntry.findMany({ where: { table_id: one.id }, orderBy: { entry_date: 'asc' } });
        const myTodos = await prisma.todo.findMany({ where: { table_id: one.id, deleted_at: null } });
        const myRems = await prisma.reminder.findMany({ where: { table_id: one.id, deleted_at: null }, orderBy: { sort_order: 'asc' } });
        add2(SHEETS.logs, myLogs.map((l) => ({ id: l.id, entry_date: l.entry_date, content: l.content, updated_at: l.updated_at })));
        add2(SHEETS.todos, myTodos.map((t) => ({
          id: t.id, title: t.title, assignee_id: t.assignee_id, assignee_name: pMap2[t.assignee_id || ''] || '',
          points: t.points, status: t.status, record_time: t.record_time, completed_at: t.completed_at,
        })));
        add2(SHEETS.reminders, myRems.map((r) => ({
          id: r.id, text: r.text, repeat: r.repeat, rule: r.rule,
          start_date: r.start_date, end_date: r.end_date, enabled: r.enabled,
        })));
      } else if (one.type === 'project') {
        const projs = await prisma.project.findMany({ where: { table_id: one.id, deleted_at: null } });
        const pids = projs.map((p) => p.id);
        const myTasks = pids.length
          ? await prisma.projectTask.findMany({
              where: { project_id: { in: pids }, deleted_at: null },
              orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
            })
          : [];
        const projMap2 = Object.fromEntries(projs.map((p) => [p.id, p.name]));
        add2(SHEETS.projects, projs.map((p) => ({
          id: p.id, name: p.name, description: p.description, start_date: p.start_date, end_date: p.end_date, status: p.status,
        })));
        add2(SHEETS.projectTasks, myTasks.map((t) => ({
          id: t.id, project_name: projMap2[t.project_id] || '', parent_id: t.parent_id, name: t.name,
          plan_start: t.plan_start, plan_duration: t.plan_duration, plan_end: t.plan_end,
          actual_start: t.actual_start, actual_end: t.actual_end, progress: t.progress,
          assignee_id: t.assignee_id, assignee_name: pMap2[t.assignee_id || ''] || '',
          points: t.points, earned_points: t.earned_points, status: t.status,
        })));
      } else {
        add2(SHEETS.people, ppl.map((p) => ({
          id: p.id, name: p.name, role: p.role, total_points: p.total_points, created_at: p.created_at,
        })));
      }
      const buf2 = XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' });
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', `attachment; filename="sheet.xlsx"; filename*=UTF-8''${encodeURIComponent('单表-' + safeName)}.xlsx`);
      return reply.send(buf2);
    }

    const wb = XLSX.utils.book_new();

    const tables = await prisma.tableMeta.findMany({ where: { deleted_at: null }, orderBy: { sort_order: 'asc' } });
    const logs = await prisma.logEntry.findMany({ orderBy: { entry_date: 'asc' } });
    const todos = await prisma.todo.findMany({ where: { deleted_at: null } });
    const projects = await prisma.project.findMany({ where: { deleted_at: null } });
    const tasks = await prisma.projectTask.findMany({ where: { deleted_at: null } });
    const people = await prisma.person.findMany({ where: { deleted_at: null } });
    const ledger = await prisma.pointsLedger.findMany({ orderBy: { created_at: 'asc' } });
    const history = await prisma.changeHistory.findMany({ orderBy: { created_at: 'desc' }, take: 5000 });
    const reminders = await prisma.reminder.findMany({
      where: { deleted_at: null },
      orderBy: [{ table_id: 'asc' }, { sort_order: 'asc' }],
    });

    const tMap = Object.fromEntries(tables.map((t) => [t.id, t.name]));
    const pMap = Object.fromEntries(people.map((p) => [p.id, p.name]));
    const projMap = Object.fromEntries(projects.map((p) => [p.id, p.name]));

    const add = (name: string, rows: any[]) => {
      const safe = name.slice(0, 31);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{}]), safe);
    };

    /**
     * 第一个 sheet 放「说明」——用户反馈「导出的第一页是什么东西，ID 好长看不懂」。
     * 说明 sheet 只给人看：导入是按 sheet 名匹配的，多这一页会被忽略，不影响导入回环。
     */
    add('说明', [
      { 项: '这个文件是什么', 说明: '「日志与项目管理」整库导出。每张工作表 → 一个 sheet，用 Excel 直接就能看。' },
      { 项: '想恢复数据怎么用', 说明: '程序里点「导入 Excel」选这个文件：合并导入=按内部 ID 覆盖同一条记录、不动其它；清空后导入=先清空再写入。导入前会自动备份当前库。' },
      { 项: '带「内部ID」的列是什么', 说明: '每条记录的内部编号（一串字母数字），导入时靠它对上号，日常不用看、也不要改。' },
      { 项: 'sheet 对照', 说明: '说明 / 工作表目录 / 日志 / 待办 / 提醒 / 项目 / 项目任务 / 人员 / 积分流水 / 操作历史' },
      { 项: '「整库备份」是什么', 说明: '程序里点「整库备份」= 把数据库文件整份复制到 data\\backups\\，出问题可用它整库回滚。' },
      { 项: '「提醒」是什么', 说明: '日志页格子里的「提前写好的文字」：支持只此一次 / 每周几 / 每月几号 / 每年几月几号，可限定生效的起止日期。' },
      { 项: '「操作记录」是什么', 说明: '每一次新增/修改/删除的流水账（时间、对象、改动内容），用于追溯谁在什么时候改了什么。' },
      { 项: '导出时间', 说明: todayStr() },
    ]);

    add(SHEETS.tables, tables.map((t) => ({
      id: t.id, name: t.name, type: t.type, config: t.config,
      sort_order: t.sort_order, created_at: t.created_at, updated_at: t.updated_at,
    })));
    add(SHEETS.logs, logs.map((l) => ({
      id: l.id, table_id: l.table_id, table_name: tMap[l.table_id] || '',
      entry_date: l.entry_date, content: l.content, updated_at: l.updated_at,
    })));
    add(SHEETS.todos, todos.map((t) => ({
      id: t.id, table_id: t.table_id, table_name: tMap[t.table_id] || '',
      title: t.title, assignee_id: t.assignee_id, assignee_name: pMap[t.assignee_id || ''] || '',
      points: t.points, status: t.status, record_time: t.record_time, completed_at: t.completed_at,
      transferred: t.transferred,
    })));
    add(SHEETS.reminders, reminders.map((r) => ({
      id: r.id, table_id: r.table_id, table_name: tMap[r.table_id] || '',
      text: r.text, repeat: r.repeat, rule: r.rule,
      start_date: r.start_date, end_date: r.end_date, enabled: r.enabled,
    })));
    add(SHEETS.projects, projects.map((p) => ({
      id: p.id, table_id: p.table_id, table_name: tMap[p.table_id] || '',
      name: p.name, description: p.description, start_date: p.start_date, end_date: p.end_date, status: p.status,
    })));
    add(SHEETS.projectTasks, tasks.map((t) => ({
      id: t.id, project_id: t.project_id, project_name: projMap[t.project_id] || '',
      parent_id: t.parent_id, name: t.name, plan_start: t.plan_start, plan_duration: t.plan_duration,
      plan_end: t.plan_end, actual_start: t.actual_start, actual_end: t.actual_end,
      progress: t.progress, assignee_id: t.assignee_id, assignee_name: pMap[t.assignee_id || ''] || '',
      points: t.points, earned_points: t.earned_points, status: t.status,
    })));
    add(SHEETS.people, people.map((p) => ({
      id: p.id, name: p.name, role: p.role, total_points: p.total_points, created_at: p.created_at,
    })));
    add(SHEETS.ledger, ledger.map((l) => ({
      id: l.id, person_id: l.person_id, person_name: l.person_name, source_type: l.source_type,
      source_id: l.source_id, points: l.points, reason: l.reason, created_at: l.created_at,
    })));
    add(SHEETS.history, history.map((h) => ({
      id: h.id, table_id: h.table_id, record_id: h.record_id, entity: h.entity, action: h.action,
      before: h.before, after: h.after, created_at: h.created_at,
    })));

    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    const fname = `lpm-export-${todayStr()}.xlsx`;
    await prisma.importExportJob.create({ data: { kind: 'export', status: 'done', detail: fname } });
    await logChange({ action: 'export', entity: 'excel', after: { file: fname } });

    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${fname}"`)
      .header('Cache-Control', 'no-cache, no-store, must-revalidate');
    return reply.send(Buffer.from(buf));
  });

  // ══ 导入 Excel（前端已解析成 JSON；mode = replace | merge）══════
  app.post('/api/import/excel', async (req, reply) => {
    const schema = z.object({
      mode: z.enum(['replace', 'merge']).default('merge'),
      sheets: z.record(z.array(z.record(z.any()))),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败', detail: parsed.error.issues });
    const { mode, sheets } = parsed.data;

    // 导入前自动备份数据库文件（安全规则要求）
    const backupPath = await backupDbFile();

    const counts: Record<string, number> = {};
    const P = (v: any) => (v === undefined || v === '' ? null : v);
    const num = (v: any) => (v === undefined || v === '' || v === null ? 0 : Number(v) || 0);
    const dt = (v: any) => {
      if (!v) return null;
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    };

    if (mode === 'replace') {
      await prisma.changeHistory.deleteMany({});
      await prisma.pointsLedger.deleteMany({});
      await prisma.projectTask.deleteMany({});
      await prisma.project.deleteMany({});
      await prisma.todo.deleteMany({});
      await prisma.reminder.deleteMany({});
      await prisma.logEntry.deleteMany({});
      await prisma.person.deleteMany({});
      await prisma.tableMeta.deleteMany({});
    }

    // ① 工作表
    for (const r of sheets[SHEETS.tables] || []) {
      if (!r.id || !r.name) continue;
      await prisma.tableMeta.upsert({
        where: { id: String(r.id) },
        create: {
          id: String(r.id), name: String(r.name), type: String(r.type || 'log'),
          config: String(r.config || '{}'), sort_order: num(r.sort_order),
        },
        update: { name: String(r.name), type: String(r.type || 'log'), config: String(r.config || '{}') },
      });
      counts.tables = (counts.tables || 0) + 1;
    }
    // ② 人员
    for (const r of sheets[SHEETS.people] || []) {
      if (!r.id || !r.name) continue;
      await prisma.person.upsert({
        where: { id: String(r.id) },
        create: { id: String(r.id), name: String(r.name), role: P(r.role), total_points: num(r.total_points) },
        update: { name: String(r.name), role: P(r.role), total_points: num(r.total_points) },
      });
      counts.people = (counts.people || 0) + 1;
    }
    // ③ 日志
    for (const r of sheets[SHEETS.logs] || []) {
      if (!r.table_id || !r.entry_date) continue;
      await prisma.logEntry.upsert({
        where: { table_id_entry_date: { table_id: String(r.table_id), entry_date: String(r.entry_date) } },
        create: {
          table_id: String(r.table_id), entry_date: String(r.entry_date),
          content: String(r.content ?? ''),
        },
        update: { content: String(r.content ?? '') },
      });
      counts.logs = (counts.logs || 0) + 1;
    }
    // ④ 待办
    for (const r of sheets[SHEETS.todos] || []) {
      if (!r.title || !r.table_id) continue;
      const data: any = {
        table_id: String(r.table_id), title: String(r.title),
        assignee_id: P(r.assignee_id), points: num(r.points),
        status: String(r.status || 'pending'),
        record_time: dt(r.record_time) || new Date(),
        completed_at: dt(r.completed_at),
        transferred: r.transferred === true || r.transferred === 'true',
      };
      if (r.id) {
        await prisma.todo.upsert({ where: { id: String(r.id) }, create: { id: String(r.id), ...data }, update: data });
      } else {
        await prisma.todo.create({ data });
      }
      counts.todos = (counts.todos || 0) + 1;
    }
    // ④b 提醒（2026-10-08 新增；导入时按内部 ID 对上号）
    for (const r of sheets[SHEETS.reminders] || []) {
      if (!r.text || !r.table_id) continue;
      const data: any = {
        table_id: String(r.table_id),
        text: String(r.text),
        repeat: String(r.repeat || 'once'),
        rule: typeof r.rule === 'string' ? r.rule : JSON.stringify(r.rule || {}),
        start_date: P(r.start_date),
        end_date: P(r.end_date),
        enabled: !(r.enabled === false || r.enabled === 'false' || r.enabled === 0 || r.enabled === '0'),
      };
      if (r.id) {
        await prisma.reminder.upsert({ where: { id: String(r.id) }, create: { id: String(r.id), ...data }, update: data });
      } else {
        await prisma.reminder.create({ data });
      }
      counts.reminders = (counts.reminders || 0) + 1;
    }
    // ⑤ 项目
    for (const r of sheets[SHEETS.projects] || []) {
      if (!r.id || !r.name) continue;
      const data: any = {
        table_id: String(r.table_id || ''), name: String(r.name), description: P(r.description),
        start_date: P(r.start_date), end_date: P(r.end_date), status: String(r.status || 'active'),
      };
      await prisma.project.upsert({ where: { id: String(r.id) }, create: { id: String(r.id), ...data }, update: data });
      counts.projects = (counts.projects || 0) + 1;
    }
    // ⑥ 项目任务
    for (const r of sheets[SHEETS.projectTasks] || []) {
      if (!r.id || !r.name || !r.project_id) continue;
      const data: any = {
        project_id: String(r.project_id), parent_id: P(r.parent_id), name: String(r.name),
        plan_start: P(r.plan_start), plan_duration: num(r.plan_duration) || 1, plan_end: P(r.plan_end),
        actual_start: P(r.actual_start), actual_end: P(r.actual_end), progress: num(r.progress),
        assignee_id: P(r.assignee_id), points: num(r.points), earned_points: num(r.earned_points),
        status: String(r.status || 'not_started'),
      };
      await prisma.projectTask.upsert({ where: { id: String(r.id) }, create: { id: String(r.id), ...data }, update: data });
      counts.projectTasks = (counts.projectTasks || 0) + 1;
    }
    // ⑦ 积分流水
    for (const r of sheets[SHEETS.ledger] || []) {
      if (!r.person_id) continue;
      const data: any = {
        person_id: String(r.person_id), person_name: P(r.person_name),
        source_type: String(r.source_type || 'manual'), source_id: P(r.source_id),
        points: num(r.points), reason: P(r.reason),
        created_at: dt(r.created_at) || new Date(),
      };
      if (r.id) {
        await prisma.pointsLedger.upsert({ where: { id: String(r.id) }, create: { id: String(r.id), ...data }, update: data });
      } else {
        await prisma.pointsLedger.create({ data });
      }
      counts.ledger = (counts.ledger || 0) + 1;
    }

    await prisma.importExportJob.create({
      data: { kind: 'import', status: 'done', detail: `mode=${mode} ${JSON.stringify(counts)}` },
    });
    await logChange({ action: 'import', entity: 'excel', after: { mode, counts, backup: backupPath } });

    return { ok: true, mode, counts, backup: path.basename(backupPath) };
  });

  // ══ 操作历史 ═══════════════════════════════════════════════
  app.get('/api/history', async (req) => {
    const { table_id, limit } = req.query as any;
    const where: any = {};
    if (table_id) where.table_id = table_id;
    const list = await prisma.changeHistory.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: Math.min(Number(limit) || 100, 1000),
    });
    return { history: list };
  });

  // ══ 清理操作历史（口径④，2026-10-05 回收站方案新增）══════════════
  // 默认只保留最近 500 条，删掉更早的（keep 可传，clamp 100..5000）。
  // 取「第 keep+1 新」那行的 created_at 作为切点，删 `created_at < cut`。
  // ⚠️ 同一毫秒并列时 `lt` 可能多留几条（结果 ≤ keep + 并列数），可接受。
  app.post('/api/history/trim', async (req, reply) => {
    const schema = z.object({ keep: z.number().int().optional() });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败' });
    const keep = Math.max(100, Math.min(5000, parsed.data.keep ?? 500));

    const cut = await prisma.changeHistory.findMany({
      orderBy: { created_at: 'desc' },
      skip: keep,
      take: 1,
    });
    if (!cut.length) return { ok: true, deleted: 0, keep };

    const r = await prisma.changeHistory.deleteMany({
      where: { created_at: { lt: cut[0].created_at } },
    });
    return { ok: true, deleted: r.count, keep };
  });

  // ══ 手工备份数据库 ═════════════════════════════════════════
  /**
   * 2026-10-08 用户反馈：「点了整库备份应该是没什么反应，我不知道它备份到哪去了」。
   * 原来只返回 { file }，前端也只弹一个 toast（在微信里/忙的时候很容易没看到）。
   * 现在补上 dir（备份存放目录）与 count（现有份数），前端据此弹窗把「存到哪、存了哪些」直接摆出来。
   */
  app.post('/api/backup', async () => {
    const p = await backupDbFile();
    const dir = backupsDir();
    let count = 0;
    try {
      count = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).length;
    } catch {
      count = 0;
    }
    return { ok: true, file: path.basename(p), path: p, dir, count };
  });

  app.get('/api/backups', async () => {
    const dir = backupsDir();
    if (!fs.existsSync(dir)) return { backups: [] };
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, size: st.size, mtime: st.mtime };
      })
      .sort((a, b) => +new Date(b.mtime) - +new Date(a.mtime));
    return { backups: files };
  });
}

