"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = default_1;
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../lib/prisma"));
const history_1 = require("../lib/history");
const points_1 = require("../lib/points");
const date_1 = require("../lib/date");
async function default_1(app) {
    // ── 项目列表 ──────────────────────────────────────────────
    app.get('/api/projects', async (req) => {
        const { table_id } = req.query;
        const where = { deleted_at: null };
        if (table_id)
            where.table_id = table_id;
        const projects = await prisma_1.default.project.findMany({ where, orderBy: { created_at: 'asc' } });
        return { projects };
    });
    // ── 新建项目 ──────────────────────────────────────────────
    app.post('/api/projects', async (req, reply) => {
        const schema = zod_1.z.object({
            table_id: zod_1.z.string().min(1),
            name: zod_1.z.string().min(1).max(100),
            description: zod_1.z.string().nullish(),
            start_date: zod_1.z.string().nullish(),
            end_date: zod_1.z.string().nullish(),
        });
        const parsed = schema.safeParse(req.body || {});
        if (!parsed.success)
            return reply.status(400).send({ error: '参数校验失败' });
        const p = await prisma_1.default.project.create({
            data: {
                table_id: parsed.data.table_id,
                name: parsed.data.name,
                description: parsed.data.description ?? null,
                start_date: parsed.data.start_date ?? null,
                end_date: parsed.data.end_date ?? null,
            },
        });
        await (0, history_1.logChange)({ table_id: p.table_id, record_id: p.id, entity: 'project', action: 'create', after: p });
        return p;
    });
    // ── 甘特图数据（扁平任务数组，前端自己组装树）【必须在 :id 之前】──
    app.get('/api/gantt', async (req) => {
        const { project_id } = req.query;
        if (!project_id)
            return [];
        const tasks = await prisma_1.default.projectTask.findMany({
            where: { project_id, deleted_at: null },
            orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
        });
        const people = await prisma_1.default.person.findMany({ where: { deleted_at: null } });
        const pMap = Object.fromEntries(people.map((p) => [p.id, p.name]));
        return tasks.map((t) => ({
            id: t.id,
            text: t.name,
            name: t.name,
            start_date: t.plan_start,
            deadline: t.plan_end || t.plan_start,
            plan_start: t.plan_start,
            plan_end: t.plan_end,
            actual_start: t.actual_start,
            actual_end: t.actual_end,
            progress: t.progress,
            assignee_id: t.assignee_id,
            assignee_name: t.assignee_id ? pMap[t.assignee_id] || '' : '',
            points: t.points,
            earned_points: t.earned_points,
            status: t.status,
            plan_duration: t.plan_duration,
            parent_id: t.parent_id,
        }));
    });
    // ── 某项目的任务 ──────────────────────────────────────────
    app.get('/api/projects/:id/tasks', async (req) => {
        const { id } = req.params;
        const tasks = await prisma_1.default.projectTask.findMany({
            where: { project_id: id, deleted_at: null },
            orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
        });
        return { tasks };
    });
    // ── 新增任务 ──────────────────────────────────────────────
    app.post('/api/projects/:id/tasks', async (req, reply) => {
        const { id } = req.params;
        const schema = zod_1.z.object({
            name: zod_1.z.string().min(1).max(200),
            parent_id: zod_1.z.string().nullish(),
            plan_start: zod_1.z.string().nullish(),
            plan_duration: zod_1.z.number().int().min(1).default(1),
            assignee_id: zod_1.z.string().nullish(),
            points: zod_1.z.number().int().default(0),
            progress: zod_1.z.number().int().min(0).max(100).default(0),
            note: zod_1.z.string().nullish(),
        });
        const parsed = schema.safeParse(req.body || {});
        if (!parsed.success)
            return reply.status(400).send({ error: '参数校验失败', detail: parsed.error.issues });
        const d = parsed.data;
        const planEnd = (0, points_1.calcPlanEnd)(d.plan_start, d.plan_duration);
        /* 🔴 2026-10-05 修复（用户实测：新增任务总跑到第一个任务旁边）
           原实现创建任务时**没有赋 sort_order** → 走 schema 默认值 0 →
           所有新任务的排序号都是 0，与第一个任务撞号，
           而列表按 sort_order 排序 → 新任务就插到第一个任务旁边（看起来像它的子任务）。
           改为取该项目下 max(sort_order)+1，新任务稳定排在最后。 */
        const maxRow = await prisma_1.default.projectTask.aggregate({
            where: { project_id: id, deleted_at: null },
            _max: { sort_order: true },
        });
        const nextSort = (maxRow._max.sort_order ?? -1) + 1;
        const t = await prisma_1.default.projectTask.create({
            data: {
                project_id: id,
                parent_id: d.parent_id ?? null,
                sort_order: nextSort,
                name: d.name,
                plan_start: d.plan_start ?? null,
                plan_duration: d.plan_duration,
                plan_end: planEnd,
                assignee_id: d.assignee_id ?? null,
                points: d.points,
                earned_points: (0, points_1.calcTaskEarned)(d.points, d.progress),
                progress: d.progress,
                status: (0, points_1.deriveTaskStatus)(d.progress, planEnd),
                note: d.note ?? null,
            },
        });
        await (0, history_1.logChange)({ table_id: null, record_id: t.id, entity: 'project_task', action: 'create', after: t });
        return t;
    });
    // ── 更新进度（写积分差额）【具体路由在通用之前】────────────────
    app.patch('/api/project-tasks/:id/progress', async (req, reply) => {
        const { id } = req.params;
        const schema = zod_1.z.object({
            progress: zod_1.z.number().int().min(0).max(100),
            stepped: zod_1.z.boolean().optional(),
        });
        const parsed = schema.safeParse(req.body || {});
        if (!parsed.success)
            return reply.status(400).send({ error: '参数校验失败' });
        const before = await prisma_1.default.projectTask.findUnique({ where: { id } });
        if (!before)
            return reply.status(404).send({ error: '任务不存在' });
        const earned = (0, points_1.calcTaskEarned)(before.points, parsed.data.progress, parsed.data.stepped);
        const after = await prisma_1.default.projectTask.update({
            where: { id },
            data: {
                progress: parsed.data.progress,
                earned_points: earned,
                status: (0, points_1.deriveTaskStatus)(parsed.data.progress, before.plan_end),
                actual_start: parsed.data.progress === 0 ? null : (before.actual_start || (0, date_1.todayStr)()),
                actual_end: parsed.data.progress >= 100 ? (0, date_1.todayStr)() : null,
            },
        });
        const delta = Math.round((earned - (before.earned_points || 0)) * 100) / 100;
        if (after.assignee_id && delta !== 0) {
            await (0, history_1.addPoints)({
                person_id: after.assignee_id,
                points: delta,
                source_type: 'project_task',
                source_id: after.id,
                reason: `任务进度 ${parsed.data.progress}%：${after.name}`,
            });
        }
        await (0, history_1.logChange)({ record_id: id, entity: 'project_task', action: 'update', before, after });
        return after;
    });
    // ── 推迟任务 ──────────────────────────────────────────────
    app.patch('/api/project-tasks/:id/delay', async (req, reply) => {
        const { id } = req.params;
        const schema = zod_1.z.object({
            plan_start: zod_1.z.string().min(8),
            plan_duration: zod_1.z.number().int().min(1),
            note: zod_1.z.string().nullish(),
        });
        const parsed = schema.safeParse(req.body || {});
        if (!parsed.success)
            return reply.status(400).send({ error: '参数校验失败' });
        const before = await prisma_1.default.projectTask.findUnique({ where: { id } });
        if (!before)
            return reply.status(404).send({ error: '任务不存在' });
        const planEnd = (0, points_1.calcPlanEnd)(parsed.data.plan_start, parsed.data.plan_duration);
        const after = await prisma_1.default.projectTask.update({
            where: { id },
            data: {
                plan_start: parsed.data.plan_start,
                plan_duration: parsed.data.plan_duration,
                plan_end: planEnd,
                status: (0, points_1.deriveTaskStatus)(before.progress, planEnd),
                note: parsed.data.note ?? before.note,
            },
        });
        await (0, history_1.logChange)({ record_id: id, entity: 'project_task', action: 'update', before, after });
        return after;
    });
    // ── 编辑任务（通用，放最后）──────────────────────────────────
    app.patch('/api/project-tasks/:id', async (req, reply) => {
        const { id } = req.params;
        const schema = zod_1.z.object({
            name: zod_1.z.string().min(1).max(200).optional(),
            parent_id: zod_1.z.string().nullish(),
            plan_start: zod_1.z.string().nullish(),
            plan_duration: zod_1.z.number().int().min(1).optional(),
            actual_start: zod_1.z.string().nullish(),
            actual_end: zod_1.z.string().nullish(),
            progress: zod_1.z.number().int().min(0).max(100).optional(),
            assignee_id: zod_1.z.string().nullish(),
            points: zod_1.z.number().int().optional(),
            note: zod_1.z.string().nullish(),
            sort_order: zod_1.z.number().int().optional(),
        });
        const parsed = schema.safeParse(req.body || {});
        if (!parsed.success)
            return reply.status(400).send({ error: '参数校验失败' });
        const before = await prisma_1.default.projectTask.findUnique({ where: { id } });
        if (!before)
            return reply.status(404).send({ error: '任务不存在' });
        const d = { ...parsed.data };
        if (d.plan_start !== undefined || d.plan_duration !== undefined) {
            const ps = d.plan_start !== undefined ? d.plan_start : before.plan_start;
            const pd = d.plan_duration !== undefined ? d.plan_duration : before.plan_duration;
            d.plan_end = (0, points_1.calcPlanEnd)(ps, pd);
        }
        if (d.points !== undefined || d.progress !== undefined) {
            const pts = d.points !== undefined ? d.points : before.points;
            const pr = d.progress !== undefined ? d.progress : before.progress;
            d.earned_points = (0, points_1.calcTaskEarned)(pts, pr);
            d.status = (0, points_1.deriveTaskStatus)(pr, d.plan_end ?? before.plan_end);
        }
        const after = await prisma_1.default.projectTask.update({ where: { id }, data: d });
        // 任务名/积分被改，积分差额照样要记账
        const delta = Math.round(((after.earned_points || 0) - (before.earned_points || 0)) * 100) / 100;
        if (after.assignee_id && delta !== 0) {
            await (0, history_1.addPoints)({
                person_id: after.assignee_id,
                points: delta,
                source_type: 'project_task',
                source_id: after.id,
                reason: `任务调整：${after.name}`,
            });
        }
        await (0, history_1.logChange)({ record_id: id, entity: 'project_task', action: 'update', before, after });
        return after;
    });
    // ── 删除任务（软删除）─────────────────────────────────────
    // ── 拖动排序：批量写 sort_order ────────────────────────────
    app.patch('/api/project-tasks/reorder', async (req, reply) => {
        const schema = zod_1.z.object({ ordered_ids: zod_1.z.array(zod_1.z.string().min(1)).min(1) });
        const parsed = schema.safeParse(req.body || {});
        if (!parsed.success)
            return reply.status(400).send({ error: '参数校验失败' });
        const ids = parsed.data.ordered_ids;
        await prisma_1.default.$transaction(ids.map((id, i) => prisma_1.default.projectTask.updateMany({ where: { id }, data: { sort_order: i } })));
        await (0, history_1.logChange)({ entity: 'project_task', action: 'update', after: { reorder_count: ids.length } });
        return { ok: true, count: ids.length };
    });
    app.delete('/api/project-tasks/:id', async (req) => {
        const { id } = req.params;
        const before = await prisma_1.default.projectTask.findUnique({ where: { id } });
        await prisma_1.default.projectTask.update({ where: { id }, data: { deleted_at: new Date() } });
        // 子任务一并软删除
        await prisma_1.default.projectTask.updateMany({ where: { parent_id: id }, data: { deleted_at: new Date() } });
        await (0, history_1.logChange)({ record_id: id, entity: 'project_task', action: 'delete', before });
        return { ok: true };
    });
}
