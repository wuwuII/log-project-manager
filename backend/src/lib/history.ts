import prisma from './prisma';

/**
 * 写操作历史。历史记录失败绝不影响主流程 —— 全部 try/catch 吞掉。
 */
export async function logChange(opts: {
  table_id?: string | null;
  record_id?: string | null;
  entity?: string | null;
  action: 'create' | 'update' | 'delete' | 'complete' | 'import' | 'export' | string;
  before?: any;
  after?: any;
  changed_by?: string | null;
}): Promise<void> {
  try {
    await prisma.changeHistory.create({
      data: {
        table_id: opts.table_id ?? null,
        record_id: opts.record_id ?? null,
        entity: opts.entity ?? null,
        action: opts.action,
        before: opts.before === undefined ? null : JSON.stringify(opts.before),
        after: opts.after === undefined ? null : JSON.stringify(opts.after),
        changed_by: opts.changed_by ?? null,
      },
    });
  } catch (e) {
    console.error('[history] 写历史失败（已忽略）:', e);
  }
}

/**
 * 记积分流水，并同步更新 people.total_points 缓存。
 * delta 为本次变动值（可为负）。
 */
export async function addPoints(opts: {
  person_id: string;
  points: number;
  source_type: 'todo' | 'project_task' | 'manual' | string;
  source_id?: string | null;
  reason?: string | null;
}): Promise<void> {
  const person = await prisma.person.findUnique({ where: { id: opts.person_id } });
  if (!person) return;
  await prisma.pointsLedger.create({
    data: {
      person_id: opts.person_id,
      person_name: person.name,
      source_type: opts.source_type,
      source_id: opts.source_id ?? null,
      points: opts.points,
      reason: opts.reason ?? null,
    },
  });
  await prisma.person.update({
    where: { id: opts.person_id },
    data: { total_points: (person.total_points || 0) + opts.points },
  });
}

/**
 * 重算某人的积分缓存（把流水求和覆盖 total_points）。
 * 用于纠错 —— 流水是唯一真相，缓存可随时重建。
 */
export async function recalcPersonPoints(person_id: string): Promise<number> {
  const agg = await prisma.pointsLedger.aggregate({
    where: { person_id },
    _sum: { points: true },
  });
  const total = Math.round((agg._sum.points || 0) * 100) / 100;
  await prisma.person.update({ where: { id: person_id }, data: { total_points: total } });
  return total;
}
