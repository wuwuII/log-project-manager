import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { logChange } from '../lib/history';

/**
 * 提醒（Reminder）—— 日志页格子里「提前写好的文字」（2026-10-08 用户需求）
 *
 * 需求原话：「直接在日志这个页面，我想增加提醒功能，可以是指定某一天的提醒，或者是周期性的提醒，
 *           每周每月每年的某一天或者某几天，办什么事，也要设置时间范围，从什么时候开始到什么时候结束？
 *           添加完了内容之后，可以在日志这个界面，对应的那一天的那个格子里面就会有这个文字提示，
 *           就相当于提前输好了文字。」
 *
 * 用户拍板：**每张日志工作表各管各的**（按 table_id 存），按钮就在对应日志界面里。
 *
 * repeat 取值与 rule（JSON 文本）：
 *   once    → {"date":"2026-10-15"}                    只此一次
 *   weekly  → {"weekdays":[1,3,5]}                     1=周一 … 7=周日，可多选
 *   monthly → {"days":[1,15]}                          每月几号，可多选
 *   yearly  → {"dates":[{"month":10,"day":8}]}          每年几月几号，可多选
 * start_date / end_date：生效范围（含两端；留空=不限）。没删就一直按重复规则生效。
 */

/** 把 YYYY-MM-DD 拆成 {y,m,d,dow}；dow: 1=周一 … 7=周日 */
export function dateParts(dateStr: string) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  const dow = ((dt.getDay() + 6) % 7) + 1;
  return { y, m, d, dow };
}

/** 某条提醒在指定日期是否生效 */
export function reminderMatches(r: any, dateStr: string): boolean {
  if (!r || r.enabled === false || r.enabled === 0) return false;
  if (r.start_date && dateStr < r.start_date) return false;
  if (r.end_date && dateStr > r.end_date) return false;
  /**
   * ⚠️ 2026-10-08 实测踩到：`rule` 有两种形态 ——
   *   · 直接来自数据库时是 **JSON 字符串**；
   *   · 经过 GET 路由 map 之后是 **已解析的对象**（列表接口要给人看）。
   *   只写 JSON.parse(r.rule) 时，遇到对象会抛异常 → 被 catch 吞掉 → rule 变 {} → 所有日期都不匹配
   *   （症状：提醒建好了、列表也看得到，但格子里一个字都不显示）。
   *   所以这里两种都要吃得下。
   */
  let rule: any = {};
  if (r.rule && typeof r.rule === 'object') {
    rule = r.rule;
  } else {
    try {
      rule = JSON.parse(r.rule || '{}') || {};
    } catch {
      rule = {};
    }
  }
  const { m, d, dow } = dateParts(dateStr);
  switch (r.repeat) {
    case 'once':
      return rule.date === dateStr;
    case 'weekly':
      return Array.isArray(rule.weekdays) && rule.weekdays.map(Number).includes(dow);
    case 'monthly':
      return Array.isArray(rule.days) && rule.days.map(Number).includes(d);
    case 'yearly':
      return (
        Array.isArray(rule.dates) &&
        rule.dates.some((x: any) => Number(x.month) === m && Number(x.day) === d)
      );
    default:
      return false;
  }
}

const listDates = (from: string, to: string): string[] => {
  const out: string[] = [];
  const [y1, m1, d1] = from.split('-').map(Number);
  const cur = new Date(y1, m1 - 1, d1);
  let guard = 0;
  const pad = (n: number) => String(n).padStart(2, '0');
  while (guard < 4000) {
    const s = `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`;
    if (s > to) break;
    out.push(s);
    cur.setDate(cur.getDate() + 1);
    guard += 1;
  }
  return out;
};

const bodySchema = z.object({
  table_id: z.string().min(1),
  text: z.string().min(1).max(200),
  repeat: z.enum(['once', 'weekly', 'monthly', 'yearly']).default('once'),
  rule: z.any().optional(),
  start_date: z.string().nullish(),
  end_date: z.string().nullish(),
  enabled: z.boolean().optional(),
  color: z.string().max(20).nullish(),
});

const normRule = (repeat: string, rule: any): string => {
  if (rule === undefined || rule === null || rule === '') rule = {};
  if (typeof rule === 'string') {
    try {
      JSON.parse(rule);
      return rule;
    } catch {
      return '{}';
    }
  }
  const r: any = { ...rule };
  // 统一把可选项都收敛成数组，避免前端传单值 / 传字符串数字
  if (repeat === 'weekly') r.weekdays = (r.weekdays || []).map((v: any) => Number(v)).filter((n: number) => n >= 1 && n <= 7).sort((a: number, b: number) => a - b);
  if (repeat === 'monthly') r.days = (r.days || []).map((v: any) => Number(v)).filter((n: number) => n >= 1 && n <= 31).sort((a: number, b: number) => a - b);
  if (repeat === 'yearly')
    r.dates = (r.dates || [])
      .map((x: any) => ({ month: Number(x?.month), day: Number(x?.day) }))
      .filter((x: any) => x.month >= 1 && x.month <= 12 && x.day >= 1 && x.day <= 31)
      .sort((a: any, b: any) => a.month - b.month || a.day - b.day);
  if (repeat === 'once') r.date = String(r.date || '').slice(0, 10);
  return JSON.stringify(r);
};

export default async function (app: FastifyInstance) {
  /** 列表 + （给了 from/to 时）按天展开 */
  app.get('/api/reminders', async (req) => {
    const { table_id, from, to } = req.query as any;
    if (!table_id) return { reminders: [], by_date: {} };
    const rows = await prisma.reminder.findMany({
      where: { table_id, deleted_at: null },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
    });
    const reminders = rows.map((r) => {
      let rule: any = {};
      try {
        rule = JSON.parse(r.rule || '{}');
      } catch {
        rule = {};
      }
      return { ...r, rule };
    });

    const byDate: Record<string, { id: string; text: string; color?: string | null; repeat: string }[]> = {};
    if (from && to) {
      for (const ds of listDates(String(from), String(to))) {
        for (const r of reminders) {
          if (reminderMatches(r, ds)) {
            if (!byDate[ds]) byDate[ds] = [];
            byDate[ds].push({ id: r.id, text: r.text, color: r.color, repeat: r.repeat });
          }
        }
      }
    }
    return { reminders, by_date: byDate };
  });

  /** 新增 */
  app.post('/api/reminders', async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败', detail: parsed.error.issues });
    const d = parsed.data;
    const max = await prisma.reminder.aggregate({
      where: { table_id: d.table_id, deleted_at: null },
      _max: { sort_order: true },
    });
    const r = await prisma.reminder.create({
      data: {
        table_id: d.table_id,
        text: d.text,
        repeat: d.repeat,
        rule: normRule(d.repeat, d.rule),
        start_date: d.start_date ?? null,
        end_date: d.end_date ?? null,
        enabled: d.enabled ?? true,
        color: d.color ?? null,
        sort_order: ((max._max.sort_order as number | null) ?? -1) + 1,
      },
    });
    await logChange({ table_id: d.table_id, record_id: r.id, entity: 'reminder', action: 'create', after: r });
    return r;
  });

  /** 编辑（只有传了的字段才改） */
  app.patch('/api/reminders/:id', async (req, reply) => {
    const { id } = req.params as any;
    const before = await prisma.reminder.findUnique({ where: { id } });
    if (!before || before.deleted_at) return reply.status(404).send({ error: '提醒不存在' });
    const parsed = bodySchema.partial().safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败' });
    const d: any = { ...parsed.data };
    if (d.repeat || d.rule !== undefined) {
      d.rule = normRule(d.repeat || before.repeat, d.rule === undefined ? JSON.parse(before.rule || '{}') : d.rule);
    }
    delete d.table_id; // 不许改归属
    const after = await prisma.reminder.update({ where: { id }, data: d });
    await logChange({ table_id: after.table_id, record_id: id, entity: 'reminder', action: 'update', before, after });
    return after;
  });

  /** 删除（软删除） */
  app.delete('/api/reminders/:id', async (req) => {
    const { id } = req.params as any;
    const before = await prisma.reminder.findUnique({ where: { id } });
    if (!before) return { ok: true };
    await prisma.reminder.update({ where: { id }, data: { deleted_at: new Date() } });
    await logChange({ table_id: before.table_id, record_id: id, entity: 'reminder', action: 'delete', before });
    return { ok: true };
  });
}
