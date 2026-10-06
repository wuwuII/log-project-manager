import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { logChange } from '../lib/history';
import { backupDbFile } from '../lib/backup';

/**
 * 回收站（2026-10-05）—— 统一管理全部**软删除**记录：查看 / 恢复 / 彻底删除。
 *
 * 设计口径（详见 `方案_回收站.md`）：
 *  ① 恢复「向上」：恢复子项时，若其父级（工作表/项目）仍处软删，一并恢复父级。
 *  ② 彻底删除「向下」：工作表 purge 连其下全部数据（项目/任务/待办/日志）一起物理删除；
 *     项目 purge 连其任务；任务 purge 连其全部后代任务。
 *  ③ 全程不动 `points_ledger`（积分是唯一真相，保积分）。
 *  ④ 唯一不在回收站的是 `log_entries`（无 deleted_at）：工作表彻底删除后日志不可找回。
 *
 * 范围补充：本实现按用户方向把 `people`（人员）也纳入回收站，作为第 5 类。
 *
 * 无外键（schema 里关联都是裸 String）→ 删除前先算全集、并置空 `todos.linked_*` 悬挂引用。
 */

type RecycleType = 'table' | 'project' | 'task' | 'todo' | 'person';

/** 类型 → Prisma 委托名 */
const DELEGATE: Record<RecycleType, string> = {
  table: 'tableMeta',
  project: 'project',
  task: 'projectTask',
  todo: 'todo',
  person: 'person',
};

/** 类型 → 显示名 */
const TYPE_LABEL: Record<RecycleType, string> = {
  table: '工作表',
  project: '项目',
  task: '任务',
  todo: '待办',
  person: '人员',
};

const idSchema = z.object({
  type: z.enum(['table', 'project', 'task', 'todo', 'person']),
  id: z.string().min(1),
});

/** 记录名（待办用 title，其余用 name） */
function nameOf(kind: RecycleType, row: any): string {
  if (!row) return '';
  return (kind === 'todo' ? row.title : row.name) || '';
}

/** 含已删在内的工作表 {id,name,deleted}（列表要显示父级名字，父级可能已删） */
async function tableInfoMap(client: any): Promise<Record<string, { name: string; deleted: boolean }>> {
  const rows = await client.tableMeta.findMany();
  const m: Record<string, { name: string; deleted: boolean }> = {};
  for (const r of rows) m[r.id] = { name: r.name, deleted: !!r.deleted_at };
  return m;
}

/** 含已删在内的项目 {id,name,deleted} */
async function projectInfoMap(client: any): Promise<Record<string, { name: string; deleted: boolean }>> {
  const rows = await client.project.findMany();
  const m: Record<string, { name: string; deleted: boolean }> = {};
  for (const r of rows) m[r.id] = { name: r.name, deleted: !!r.deleted_at };
  return m;
}

/** 某工作表下的全部子数据 id（**不看子行自身 deleted_at**：工作表 purge 连其下全部数据一起删） */
async function gatherTableSubtree(client: any, tableId: string) {
  const projects = await client.project.findMany({ where: { table_id: tableId } });
  const projectIds: string[] = projects.map((p: any) => p.id);
  const tasks = projectIds.length
    ? await client.projectTask.findMany({ where: { project_id: { in: projectIds } } })
    : [];
  const taskIds: string[] = tasks.map((t: any) => t.id);
  const todos = await client.todo.findMany({ where: { table_id: tableId } });
  const todoIds: string[] = todos.map((t: any) => t.id);
  const logs = await client.logEntry.findMany({ where: { table_id: tableId } });
  const logIds: string[] = logs.map((l: any) => l.id);
  return { projectIds, taskIds, todoIds, logIds };
}

/** 按 parent_id 建树，返回自身 + 全部后代 task id（防止删出悬挂 parent_id） */
async function gatherTaskDescendants(client: any, taskId: string): Promise<string[]> {
  const all = await client.projectTask.findMany({ select: { id: true, parent_id: true } });
  const children: Record<string, string[]> = {};
  for (const t of all) {
    if (t.parent_id) {
      if (!children[t.parent_id]) children[t.parent_id] = [];
      children[t.parent_id].push(t.id);
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [taskId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const c of children[cur] || []) stack.push(c);
  }
  return out;
}

export default async function (app: FastifyInstance) {
  // ══ 接口 1：角标计数 ══════════════════════════════════════════
  app.get('/api/recycle/summary', async () => {
    const [tables, projects, tasks, todos, people] = await Promise.all([
      prisma.tableMeta.count({ where: { deleted_at: { not: null } } }),
      prisma.project.count({ where: { deleted_at: { not: null } } }),
      prisma.projectTask.count({ where: { deleted_at: { not: null } } }),
      prisma.todo.count({ where: { deleted_at: { not: null } } }),
      prisma.person.count({ where: { deleted_at: { not: null } } }),
    ]);
    return { tables, projects, tasks, todos, people, total: tables + projects + tasks + todos + people };
  });

  // ══ 接口 2：列表（一次返回 5 类，减少老浏览器往返）═══════════════
  app.get('/api/recycle/list', async () => {
    const [tables, projects, tasks, todos, people, tInfo, pInfo] = await Promise.all([
      prisma.tableMeta.findMany({ where: { deleted_at: { not: null } }, orderBy: { deleted_at: 'desc' } }),
      prisma.project.findMany({ where: { deleted_at: { not: null } }, orderBy: { deleted_at: 'desc' } }),
      prisma.projectTask.findMany({ where: { deleted_at: { not: null } }, orderBy: { deleted_at: 'desc' } }),
      prisma.todo.findMany({ where: { deleted_at: { not: null } }, orderBy: { deleted_at: 'desc' } }),
      prisma.person.findMany({ where: { deleted_at: { not: null } }, orderBy: { deleted_at: 'desc' } }),
      tableInfoMap(prisma),
      projectInfoMap(prisma),
    ]);

    const rows = {
      tables: tables.map((t) => ({
        id: t.id, name: t.name, deleted_at: t.deleted_at,
        parent_id: null as string | null, parent_name: null as string | null, parent_deleted: false,
      })),
      projects: projects.map((p) => {
        const ti = tInfo[p.table_id];
        return {
          id: p.id, name: p.name, deleted_at: p.deleted_at,
          parent_id: p.table_id, parent_name: ti?.name ?? null, parent_deleted: ti?.deleted ?? false,
        };
      }),
      tasks: tasks.map((t) => {
        const pi = pInfo[t.project_id];
        return {
          id: t.id, name: t.name, deleted_at: t.deleted_at,
          parent_id: t.project_id, parent_name: pi?.name ?? null, parent_deleted: pi?.deleted ?? false,
        };
      }),
      todos: todos.map((t) => {
        const ti = tInfo[t.table_id];
        return {
          id: t.id, name: t.title, deleted_at: t.deleted_at,
          parent_id: t.table_id, parent_name: ti?.name ?? null, parent_deleted: ti?.deleted ?? false,
        };
      }),
      people: people.map((p) => ({
        id: p.id, name: p.name, deleted_at: p.deleted_at,
        parent_id: null as string | null, parent_name: null as string | null, parent_deleted: false,
      })),
    };

    const counts = {
      tables: rows.tables.length,
      projects: rows.projects.length,
      tasks: rows.tasks.length,
      todos: rows.todos.length,
      people: rows.people.length,
      total: rows.tables.length + rows.projects.length + rows.tasks.length + rows.todos.length + rows.people.length,
    };

    return { ...rows, counts };
  });

  // ══ 接口 3：恢复 ══════════════════════════════════════════════
  app.post('/api/recycle/restore', async (req, reply) => {
    const parsed = idSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败', detail: parsed.error.issues });
    const { type, id } = parsed.data;

    // 目标必须在回收站里（找不到 / 已是活数据 → 404）
    const main = await (prisma as any)[DELEGATE[type]].findUnique({ where: { id } });
    if (!main || !main.deleted_at) return reply.status(404).send({ error: '记录不在回收站' });

    const restored: { type: RecycleType; id: string; name: string }[] = [];
    // clearIfDeleted：天然幂等 —— 仅当行存在且 deleted_at 非空才清空并记录，绝不误清活数据
    const clearIfDeleted = async (tx: any, kind: RecycleType, rid: string) => {
      const row = await tx[DELEGATE[kind]].findUnique({ where: { id: rid } });
      if (row && row.deleted_at) {
        const u = await tx[DELEGATE[kind]].update({ where: { id: rid }, data: { deleted_at: null } });
        restored.push({ type: kind, id: rid, name: nameOf(kind, u) });
        return u;
      }
      return row;
    };

    await prisma.$transaction(async (tx: any) => {
      if (type === 'table' || type === 'person') {
        await clearIfDeleted(tx, type, id);
      } else if (type === 'project') {
        const p = await clearIfDeleted(tx, 'project', id);
        if (p?.table_id) await clearIfDeleted(tx, 'table', p.table_id);
      } else if (type === 'task') {
        const t = await clearIfDeleted(tx, 'task', id);
        // 一并恢复其仍处软删的后代任务（projects.ts 删任务时把子任务一起软删了）
        const desc = await gatherTaskDescendants(tx, id);
        for (const did of desc) {
          if (did === id) continue;
          await clearIfDeleted(tx, 'task', did);
        }
        if (t?.project_id) {
          const p = await clearIfDeleted(tx, 'project', t.project_id);
          if (p?.table_id) await clearIfDeleted(tx, 'table', p.table_id);
        }
      } else if (type === 'todo') {
        const td = await clearIfDeleted(tx, 'todo', id);
        if (td?.table_id) await clearIfDeleted(tx, 'table', td.table_id);
      }
    });

    await logChange({ record_id: id, entity: 'recycle_' + type, action: 'restore' });
    return { ok: true, restored };
  });

  // ══ 接口 4：彻底删除预览（只读，供确认框显示连带条数）═══════════
  app.post('/api/recycle/purge-preview', async (req, reply) => {
    const parsed = idSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败' });
    const { type, id } = parsed.data;

    if (type === 'table') {
      const s = await gatherTableSubtree(prisma, id);
      const total = s.logIds.length + s.todoIds.length + s.projectIds.length + s.taskIds.length;
      return {
        logs: s.logIds.length, todos: s.todoIds.length,
        projects: s.projectIds.length, tasks: s.taskIds.length, total,
      };
    }
    if (type === 'project') {
      const tasks = await prisma.projectTask.findMany({ where: { project_id: id }, select: { id: true } });
      return { tasks: tasks.length, total: tasks.length };
    }
    if (type === 'task') {
      const desc = await gatherTaskDescendants(prisma, id);
      return { tasks: desc.length, total: desc.length };
    }
    return { total: 0 };
  });

  // ══ 接口 5：彻底删除单条 ══════════════════════════════════════
  app.post('/api/recycle/purge', async (req, reply) => {
    const parsed = idSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败' });
    const { type, id } = parsed.data;

    const main = await (prisma as any)[DELEGATE[type]].findUnique({ where: { id } });
    if (!main) return reply.status(404).send({ error: '记录不存在' });
    // 守卫：只能彻底删除回收站里的记录，防误删活数据
    if (!main.deleted_at) return reply.status(400).send({ error: '只能彻底删除回收站里的记录' });

    // 破坏性操作前自动快照
    await backupDbFile();

    const deleted = await prisma.$transaction(async (tx: any) => {
      const out: Record<string, number> = {};

      if (type === 'table') {
        const s = await gatherTableSubtree(tx, id);
        // 先置空跨表悬挂引用
        if (s.projectIds.length) {
          await tx.todo.updateMany({ where: { linked_project_id: { in: s.projectIds } }, data: { linked_project_id: null } });
        }
        if (s.taskIds.length) {
          await tx.todo.updateMany({ where: { linked_task_id: { in: s.taskIds } }, data: { linked_task_id: null } });
        }
        // 再按「先算全集」的顺序物理删除
        if (s.taskIds.length) out.tasks = (await tx.projectTask.deleteMany({ where: { id: { in: s.taskIds } } })).count;
        if (s.projectIds.length) out.projects = (await tx.project.deleteMany({ where: { id: { in: s.projectIds } } })).count;
        out.todos = (await tx.todo.deleteMany({ where: { table_id: id } })).count;
        out.logs = (await tx.logEntry.deleteMany({ where: { table_id: id } })).count;
        out.tables = (await tx.tableMeta.deleteMany({ where: { id } })).count;
      } else if (type === 'project') {
        const tasks = await tx.projectTask.findMany({ where: { project_id: id }, select: { id: true } });
        const tids: string[] = tasks.map((t: any) => t.id);
        await tx.todo.updateMany({ where: { linked_project_id: id }, data: { linked_project_id: null } });
        if (tids.length) {
          await tx.todo.updateMany({ where: { linked_task_id: { in: tids } }, data: { linked_task_id: null } });
          out.tasks = (await tx.projectTask.deleteMany({ where: { id: { in: tids } } })).count;
        }
        out.projects = (await tx.project.deleteMany({ where: { id } })).count;
      } else if (type === 'task') {
        const set = await gatherTaskDescendants(tx, id);
        await tx.todo.updateMany({ where: { linked_task_id: { in: set } }, data: { linked_task_id: null } });
        out.tasks = (await tx.projectTask.deleteMany({ where: { id: { in: set } } })).count;
      } else if (type === 'todo') {
        out.todos = (await tx.todo.deleteMany({ where: { id } })).count;
      } else if (type === 'person') {
        // 🔴 2026-10-05 审查修复（唯一阻塞项）：人员被物理删除后必须置空引用，
        //   否则活着的待办/任务会留下悬空 assignee_id（UI 指派列空名、人员统计对不上）。
        //   schema 无外键，数据库不会帮我们兜。
        await tx.todo.updateMany({ where: { assignee_id: id }, data: { assignee_id: null } });
        await tx.projectTask.updateMany({ where: { assignee_id: id }, data: { assignee_id: null } });
        out.people = (await tx.person.deleteMany({ where: { id } })).count;
      }
      return out;
      // ⚠️ 口径③：全程不动 points_ledger（保积分），也不动 change_history。
    });

    await logChange({ record_id: id, entity: 'recycle_' + type, action: 'purge' });
    return { ok: true, deleted };
  });

  // ══ 接口 6：清空回收站 ════════════════════════════════════════
  app.post('/api/recycle/empty', async (req, reply) => {
    const schema = z.object({ confirm: z.string() });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败' });
    // 服务端二次校验，不只靠前端禁用
    if (parsed.data.confirm !== '删除') return reply.status(400).send({ error: '确认文字不匹配' });

    await backupDbFile();

    const result = await prisma.$transaction(async (tx: any) => {
      const tableIds = new Set<string>();
      const projectIds = new Set<string>();
      const taskIds = new Set<string>();
      const todoIds = new Set<string>();
      const personIds = new Set<string>();

      // ① 软删工作表的整棵子树（其下全部数据，不看子行 deleted_at）
      const delTables = await tx.tableMeta.findMany({ where: { deleted_at: { not: null } } });
      for (const t of delTables) {
        tableIds.add(t.id);
        const s = await gatherTableSubtree(tx, t.id);
        s.projectIds.forEach((x: string) => projectIds.add(x));
        s.taskIds.forEach((x: string) => taskIds.add(x));
        s.todoIds.forEach((x: string) => todoIds.add(x));
      }
      // ② 软删项目 ∪ 其任务
      const delProjects = await tx.project.findMany({ where: { deleted_at: { not: null } } });
      for (const p of delProjects) {
        if (projectIds.has(p.id)) continue;
        projectIds.add(p.id);
        const ts = await tx.projectTask.findMany({ where: { project_id: p.id }, select: { id: true } });
        ts.forEach((t: any) => taskIds.add(t.id));
      }
      // ③ 软删任务 ∪ 其后代
      const delTasks = await tx.projectTask.findMany({ where: { deleted_at: { not: null } }, select: { id: true } });
      for (const t of delTasks) {
        const set = await gatherTaskDescendants(tx, t.id);
        set.forEach((x) => taskIds.add(x));
      }
      // ④ 软删待办
      const delTodos = await tx.todo.findMany({ where: { deleted_at: { not: null } }, select: { id: true } });
      delTodos.forEach((t: any) => todoIds.add(t.id));
      // ⑤ 软删人员
      const delPeople = await tx.person.findMany({ where: { deleted_at: { not: null } }, select: { id: true } });
      delPeople.forEach((p: any) => personIds.add(p.id));

      const pIds = [...projectIds];
      const tIds = [...taskIds];
      const toIds = [...todoIds];
      const tbIds = [...tableIds];
      const peIds = [...personIds];

      // 置空跨表悬挂引用
      if (pIds.length) await tx.todo.updateMany({ where: { linked_project_id: { in: pIds } }, data: { linked_project_id: null } });
      if (tIds.length) await tx.todo.updateMany({ where: { linked_task_id: { in: tIds } }, data: { linked_task_id: null } });
      // 🔴 2026-10-05 审查修复：被物理删除的人员也要从活着的待办/任务上摘掉（assignee_id 悬空）
      if (peIds.length) {
        await tx.todo.updateMany({ where: { assignee_id: { in: peIds } }, data: { assignee_id: null } });
        await tx.projectTask.updateMany({ where: { assignee_id: { in: peIds } }, data: { assignee_id: null } });
      }

      const out = { tables: 0, projects: 0, tasks: 0, todos: 0, logs: 0, people: 0 };
      if (tIds.length) out.tasks = (await tx.projectTask.deleteMany({ where: { id: { in: tIds } } })).count;
      if (pIds.length) out.projects = (await tx.project.deleteMany({ where: { id: { in: pIds } } })).count;
      if (toIds.length) out.todos = (await tx.todo.deleteMany({ where: { id: { in: toIds } } })).count;
      if (tbIds.length) out.logs = (await tx.logEntry.deleteMany({ where: { table_id: { in: tbIds } } })).count;
      if (tbIds.length) out.tables = (await tx.tableMeta.deleteMany({ where: { id: { in: tbIds } } })).count;
      if (peIds.length) out.people = (await tx.person.deleteMany({ where: { id: { in: peIds } } })).count;
      return out;
    }, { timeout: 20000 });

    // ⚠️ 本接口不写 change_history（对齐方案 §1.3 接口6 与判据 B7「change_history 计数不变」）。
    // ⚠️ log_entries 无 deleted_at、不在回收站：工作表彻底删除后其日志物理丢失、不可找回。
    return { ok: true, deleted: result };
  });
}

/** 供前端/文档引用的类型标签（保留导出，避免 tree-shake 报未用） */
export const RECYCLE_TYPE_LABEL = TYPE_LABEL;
