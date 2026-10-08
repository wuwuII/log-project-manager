"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RECYCLE_TYPE_LABEL = void 0;
exports.default = default_1;
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../lib/prisma"));
const history_1 = require("../lib/history");
const backup_1 = require("../lib/backup");
/** 类型 → Prisma 委托名 */
const DELEGATE = {
    table: 'tableMeta',
    project: 'project',
    task: 'projectTask',
    todo: 'todo',
    person: 'person',
};
/** 类型 → 显示名 */
const TYPE_LABEL = {
    table: '工作表',
    project: '项目',
    task: '任务',
    todo: '待办',
    person: '人员',
};
const idSchema = zod_1.z.object({
    type: zod_1.z.enum(['table', 'project', 'task', 'todo', 'person']),
    id: zod_1.z.string().min(1),
});
/** 记录名（待办用 title，其余用 name） */
function nameOf(kind, row) {
    if (!row)
        return '';
    return (kind === 'todo' ? row.title : row.name) || '';
}
/** 含已删在内的工作表 {id,name,deleted}（列表要显示父级名字，父级可能已删） */
async function tableInfoMap(client) {
    const rows = await client.tableMeta.findMany();
    const m = {};
    for (const r of rows)
        m[r.id] = { name: r.name, deleted: !!r.deleted_at };
    return m;
}
/** 含已删在内的项目 {id,name,deleted} */
async function projectInfoMap(client) {
    const rows = await client.project.findMany();
    const m = {};
    for (const r of rows)
        m[r.id] = { name: r.name, deleted: !!r.deleted_at };
    return m;
}
/** 某工作表下的全部子数据 id（**不看子行自身 deleted_at**：工作表 purge 连其下全部数据一起删） */
async function gatherTableSubtree(client, tableId) {
    const projects = await client.project.findMany({ where: { table_id: tableId } });
    const projectIds = projects.map((p) => p.id);
    const tasks = projectIds.length
        ? await client.projectTask.findMany({ where: { project_id: { in: projectIds } } })
        : [];
    const taskIds = tasks.map((t) => t.id);
    const todos = await client.todo.findMany({ where: { table_id: tableId } });
    const todoIds = todos.map((t) => t.id);
    const logs = await client.logEntry.findMany({ where: { table_id: tableId } });
    const logIds = logs.map((l) => l.id);
    return { projectIds, taskIds, todoIds, logIds };
}
/** 按 parent_id 建树，返回自身 + 全部后代 task id（防止删出悬挂 parent_id） */
async function gatherTaskDescendants(client, taskId) {
    const all = await client.projectTask.findMany({ select: { id: true, parent_id: true } });
    const children = {};
    for (const t of all) {
        if (t.parent_id) {
            if (!children[t.parent_id])
                children[t.parent_id] = [];
            children[t.parent_id].push(t.id);
        }
    }
    const out = [];
    const seen = new Set();
    const stack = [taskId];
    while (stack.length) {
        const cur = stack.pop();
        if (seen.has(cur))
            continue;
        seen.add(cur);
        out.push(cur);
        for (const c of children[cur] || [])
            stack.push(c);
    }
    return out;
}
async function default_1(app) {
    // ══ 接口 1：角标计数 ══════════════════════════════════════════
    app.get('/api/recycle/summary', async () => {
        const [tables, projects, tasks, todos, people] = await Promise.all([
            prisma_1.default.tableMeta.count({ where: { deleted_at: { not: null } } }),
            prisma_1.default.project.count({ where: { deleted_at: { not: null } } }),
            prisma_1.default.projectTask.count({ where: { deleted_at: { not: null } } }),
            prisma_1.default.todo.count({ where: { deleted_at: { not: null } } }),
            prisma_1.default.person.count({ where: { deleted_at: { not: null } } }),
        ]);
        return { tables, projects, tasks, todos, people, total: tables + projects + tasks + todos + people };
    });
    // ══ 接口 2：列表（一次返回 5 类，减少老浏览器往返）═══════════════
    app.get('/api/recycle/list', async () => {
        const [tables, projects, tasks, todos, people, tInfo, pInfo] = await Promise.all([
            prisma_1.default.tableMeta.findMany({ where: { deleted_at: { not: null } }, orderBy: { deleted_at: 'desc' } }),
            prisma_1.default.project.findMany({ where: { deleted_at: { not: null } }, orderBy: { deleted_at: 'desc' } }),
            prisma_1.default.projectTask.findMany({ where: { deleted_at: { not: null } }, orderBy: { deleted_at: 'desc' } }),
            prisma_1.default.todo.findMany({ where: { deleted_at: { not: null } }, orderBy: { deleted_at: 'desc' } }),
            prisma_1.default.person.findMany({ where: { deleted_at: { not: null } }, orderBy: { deleted_at: 'desc' } }),
            tableInfoMap(prisma_1.default),
            projectInfoMap(prisma_1.default),
        ]);
        const rows = {
            tables: tables.map((t) => ({
                id: t.id, name: t.name, deleted_at: t.deleted_at,
                parent_id: null, parent_name: null, parent_deleted: false,
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
                parent_id: null, parent_name: null, parent_deleted: false,
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
        if (!parsed.success)
            return reply.status(400).send({ error: '参数校验失败', detail: parsed.error.issues });
        const { type, id } = parsed.data;
        // 目标必须在回收站里（找不到 / 已是活数据 → 404）
        const main = await prisma_1.default[DELEGATE[type]].findUnique({ where: { id } });
        if (!main || !main.deleted_at)
            return reply.status(404).send({ error: '记录不在回收站' });
        const restored = [];
        // clearIfDeleted：天然幂等 —— 仅当行存在且 deleted_at 非空才清空并记录，绝不误清活数据
        const clearIfDeleted = async (tx, kind, rid) => {
            const row = await tx[DELEGATE[kind]].findUnique({ where: { id: rid } });
            if (row && row.deleted_at) {
                const u = await tx[DELEGATE[kind]].update({ where: { id: rid }, data: { deleted_at: null } });
                restored.push({ type: kind, id: rid, name: nameOf(kind, u) });
                return u;
            }
            return row;
        };
        await prisma_1.default.$transaction(async (tx) => {
            if (type === 'table' || type === 'person') {
                await clearIfDeleted(tx, type, id);
            }
            else if (type === 'project') {
                const p = await clearIfDeleted(tx, 'project', id);
                if (p?.table_id)
                    await clearIfDeleted(tx, 'table', p.table_id);
            }
            else if (type === 'task') {
                const t = await clearIfDeleted(tx, 'task', id);
                // 一并恢复其仍处软删的后代任务（projects.ts 删任务时把子任务一起软删了）
                const desc = await gatherTaskDescendants(tx, id);
                for (const did of desc) {
                    if (did === id)
                        continue;
                    await clearIfDeleted(tx, 'task', did);
                }
                if (t?.project_id) {
                    const p = await clearIfDeleted(tx, 'project', t.project_id);
                    if (p?.table_id)
                        await clearIfDeleted(tx, 'table', p.table_id);
                }
            }
            else if (type === 'todo') {
                const td = await clearIfDeleted(tx, 'todo', id);
                if (td?.table_id)
                    await clearIfDeleted(tx, 'table', td.table_id);
            }
        });
        await (0, history_1.logChange)({ record_id: id, entity: 'recycle_' + type, action: 'restore' });
        return { ok: true, restored };
    });
    // ══ 接口 4：彻底删除预览（只读，供确认框显示连带条数）═══════════
    app.post('/api/recycle/purge-preview', async (req, reply) => {
        const parsed = idSchema.safeParse(req.body || {});
        if (!parsed.success)
            return reply.status(400).send({ error: '参数校验失败' });
        const { type, id } = parsed.data;
        if (type === 'table') {
            const s = await gatherTableSubtree(prisma_1.default, id);
            const total = s.logIds.length + s.todoIds.length + s.projectIds.length + s.taskIds.length;
            return {
                logs: s.logIds.length, todos: s.todoIds.length,
                projects: s.projectIds.length, tasks: s.taskIds.length, total,
            };
        }
        if (type === 'project') {
            const tasks = await prisma_1.default.projectTask.findMany({ where: { project_id: id }, select: { id: true } });
            return { tasks: tasks.length, total: tasks.length };
        }
        if (type === 'task') {
            const desc = await gatherTaskDescendants(prisma_1.default, id);
            return { tasks: desc.length, total: desc.length };
        }
        return { total: 0 };
    });
    // ══ 接口 5：彻底删除单条 ══════════════════════════════════════
    app.post('/api/recycle/purge', async (req, reply) => {
        const parsed = idSchema.safeParse(req.body || {});
        if (!parsed.success)
            return reply.status(400).send({ error: '参数校验失败' });
        const { type, id } = parsed.data;
        const main = await prisma_1.default[DELEGATE[type]].findUnique({ where: { id } });
        if (!main)
            return reply.status(404).send({ error: '记录不存在' });
        // 守卫：只能彻底删除回收站里的记录，防误删活数据
        if (!main.deleted_at)
            return reply.status(400).send({ error: '只能彻底删除回收站里的记录' });
        // 破坏性操作前自动快照
        await (0, backup_1.backupDbFile)();
        const deleted = await prisma_1.default.$transaction(async (tx) => {
            const out = {};
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
                if (s.taskIds.length)
                    out.tasks = (await tx.projectTask.deleteMany({ where: { id: { in: s.taskIds } } })).count;
                if (s.projectIds.length)
                    out.projects = (await tx.project.deleteMany({ where: { id: { in: s.projectIds } } })).count;
                out.todos = (await tx.todo.deleteMany({ where: { table_id: id } })).count;
                out.logs = (await tx.logEntry.deleteMany({ where: { table_id: id } })).count;
                out.tables = (await tx.tableMeta.deleteMany({ where: { id } })).count;
            }
            else if (type === 'project') {
                const tasks = await tx.projectTask.findMany({ where: { project_id: id }, select: { id: true } });
                const tids = tasks.map((t) => t.id);
                await tx.todo.updateMany({ where: { linked_project_id: id }, data: { linked_project_id: null } });
                if (tids.length) {
                    await tx.todo.updateMany({ where: { linked_task_id: { in: tids } }, data: { linked_task_id: null } });
                    out.tasks = (await tx.projectTask.deleteMany({ where: { id: { in: tids } } })).count;
                }
                out.projects = (await tx.project.deleteMany({ where: { id } })).count;
            }
            else if (type === 'task') {
                const set = await gatherTaskDescendants(tx, id);
                await tx.todo.updateMany({ where: { linked_task_id: { in: set } }, data: { linked_task_id: null } });
                out.tasks = (await tx.projectTask.deleteMany({ where: { id: { in: set } } })).count;
            }
            else if (type === 'todo') {
                out.todos = (await tx.todo.deleteMany({ where: { id } })).count;
            }
            else if (type === 'person') {
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
        await (0, history_1.logChange)({ record_id: id, entity: 'recycle_' + type, action: 'purge' });
        return { ok: true, deleted };
    });
    // ══ 接口 6：清空回收站 ════════════════════════════════════════
    app.post('/api/recycle/empty', async (req, reply) => {
        const schema = zod_1.z.object({ confirm: zod_1.z.string() });
        const parsed = schema.safeParse(req.body || {});
        if (!parsed.success)
            return reply.status(400).send({ error: '参数校验失败' });
        // 服务端二次校验，不只靠前端禁用
        if (parsed.data.confirm !== '删除')
            return reply.status(400).send({ error: '确认文字不匹配' });
        await (0, backup_1.backupDbFile)();
        const result = await prisma_1.default.$transaction(async (tx) => {
            const tableIds = new Set();
            const projectIds = new Set();
            const taskIds = new Set();
            const todoIds = new Set();
            const personIds = new Set();
            // ① 软删工作表的整棵子树（其下全部数据，不看子行 deleted_at）
            const delTables = await tx.tableMeta.findMany({ where: { deleted_at: { not: null } } });
            for (const t of delTables) {
                tableIds.add(t.id);
                const s = await gatherTableSubtree(tx, t.id);
                s.projectIds.forEach((x) => projectIds.add(x));
                s.taskIds.forEach((x) => taskIds.add(x));
                s.todoIds.forEach((x) => todoIds.add(x));
            }
            // ② 软删项目 ∪ 其任务
            const delProjects = await tx.project.findMany({ where: { deleted_at: { not: null } } });
            for (const p of delProjects) {
                if (projectIds.has(p.id))
                    continue;
                projectIds.add(p.id);
                const ts = await tx.projectTask.findMany({ where: { project_id: p.id }, select: { id: true } });
                ts.forEach((t) => taskIds.add(t.id));
            }
            // ③ 软删任务 ∪ 其后代
            const delTasks = await tx.projectTask.findMany({ where: { deleted_at: { not: null } }, select: { id: true } });
            for (const t of delTasks) {
                const set = await gatherTaskDescendants(tx, t.id);
                set.forEach((x) => taskIds.add(x));
            }
            // ④ 软删待办
            const delTodos = await tx.todo.findMany({ where: { deleted_at: { not: null } }, select: { id: true } });
            delTodos.forEach((t) => todoIds.add(t.id));
            // ⑤ 软删人员
            const delPeople = await tx.person.findMany({ where: { deleted_at: { not: null } }, select: { id: true } });
            delPeople.forEach((p) => personIds.add(p.id));
            const pIds = [...projectIds];
            const tIds = [...taskIds];
            const toIds = [...todoIds];
            const tbIds = [...tableIds];
            const peIds = [...personIds];
            // 置空跨表悬挂引用
            if (pIds.length)
                await tx.todo.updateMany({ where: { linked_project_id: { in: pIds } }, data: { linked_project_id: null } });
            if (tIds.length)
                await tx.todo.updateMany({ where: { linked_task_id: { in: tIds } }, data: { linked_task_id: null } });
            // 🔴 2026-10-05 审查修复：被物理删除的人员也要从活着的待办/任务上摘掉（assignee_id 悬空）
            if (peIds.length) {
                await tx.todo.updateMany({ where: { assignee_id: { in: peIds } }, data: { assignee_id: null } });
                await tx.projectTask.updateMany({ where: { assignee_id: { in: peIds } }, data: { assignee_id: null } });
            }
            const out = { tables: 0, projects: 0, tasks: 0, todos: 0, logs: 0, people: 0 };
            if (tIds.length)
                out.tasks = (await tx.projectTask.deleteMany({ where: { id: { in: tIds } } })).count;
            if (pIds.length)
                out.projects = (await tx.project.deleteMany({ where: { id: { in: pIds } } })).count;
            if (toIds.length)
                out.todos = (await tx.todo.deleteMany({ where: { id: { in: toIds } } })).count;
            if (tbIds.length)
                out.logs = (await tx.logEntry.deleteMany({ where: { table_id: { in: tbIds } } })).count;
            if (tbIds.length)
                out.tables = (await tx.tableMeta.deleteMany({ where: { id: { in: tbIds } } })).count;
            if (peIds.length)
                out.people = (await tx.person.deleteMany({ where: { id: { in: peIds } } })).count;
            return out;
        }, { timeout: 20000 });
        // ⚠️ 本接口不写 change_history（对齐方案 §1.3 接口6 与判据 B7「change_history 计数不变」）。
        // ⚠️ log_entries 无 deleted_at、不在回收站：工作表彻底删除后其日志物理丢失、不可找回。
        return { ok: true, deleted: result };
    });
}
/** 供前端/文档引用的类型标签（保留导出，避免 tree-shake 报未用） */
exports.RECYCLE_TYPE_LABEL = TYPE_LABEL;
