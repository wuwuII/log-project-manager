"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = default_1;
const zod_1 = require("zod");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const prisma_1 = __importStar(require("../lib/prisma"));
const date_1 = require("../lib/date");
const project_state_1 = require("../lib/project-state");
// ── 最近工程列表：放在当前库同目录，跟着数据走 ──────────────────
function recentFile() {
    return path_1.default.join(path_1.default.dirname((0, prisma_1.getDbFile)()), 'recent-projects.json');
}
function readRecent() {
    try {
        const arr = JSON.parse(fs_1.default.readFileSync(recentFile(), 'utf-8'));
        return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && fs_1.default.existsSync(x)) : [];
    }
    catch {
        return [];
    }
}
function pushRecent(p) {
    const list = readRecent().filter((x) => x !== p);
    list.unshift(p);
    try {
        fs_1.default.writeFileSync(recentFile(), JSON.stringify(list.slice(0, 10), null, 2), 'utf-8');
    }
    catch {
        /* 记不上就算了，不影响主流程 */
    }
}
function fileInfo(p) {
    const st = fs_1.default.statSync(p);
    return {
        path: p,
        dir: path_1.default.dirname(p),
        name: path_1.default.basename(p),
        size: st.size,
        mtime: st.mtime.toISOString(),
    };
}
/** 给一个刚建好/刚打开的库补上默认 3 张工作表（与 app.ts 的 ensureDefaultTables 同规则） */
async function ensureDefaultTables(p) {
    const n = await p.tableMeta.count({ where: { deleted_at: null } });
    if (n > 0)
        return;
    const defaults = [
        { name: '日志', type: 'log', sort_order: 0 },
        { name: '项目计划', type: 'project', sort_order: 1 },
        { name: '人员', type: 'people', sort_order: 2 },
    ];
    for (const d of defaults) {
        await p.tableMeta.create({ data: { ...d, config: '{}' } });
    }
    const projTable = await p.tableMeta.findFirst({ where: { type: 'project', deleted_at: null } });
    if (projTable) {
        const proj = await p.project.create({
            data: { table_id: projTable.id, name: '默认项目', status: 'active', start_date: (0, date_1.todayStr)() },
        });
        await p.tableMeta.update({
            where: { id: projTable.id },
            data: { config: JSON.stringify({ project_id: proj.id }) },
        });
    }
}
function tsName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function safeFileName(s) {
    return s.replace(/[\\/:*?"<>|]/g, '_').trim();
}
async function default_1(app) {
    // ── 当前工程信息 + 最近工程 ──────────────────────────────
    app.get('/api/workspace', async () => {
        const file = (0, prisma_1.getDbFile)();
        /**
         * 🔴 方案 C3 第 5 块：工程文件缺失时**不要碰数据库**。
         * Prisma 连 SQLite 时文件不存在会被自动创建成空库；这里提前返回，
         * 保证「缺失」状态下绝不会因为一次 count 查询把空库建出来。
         * （app.ts 的 onRequest 守卫也会拦这个接口，这里是防御性兜底。）
         */
        if ((0, project_state_1.isProjectMissing)()) {
            return {
                current: {
                    path: file,
                    dir: path_1.default.dirname(file),
                    name: path_1.default.basename(file),
                    size: 0,
                    mtime: null,
                    exists: false,
                    counts: { logs: 0, todos: 0, tasks: 0, projects: 0, people: 0, tables: 0 },
                    readable: false,
                },
                recent: [],
                missing: true,
            };
        }
        let counts = { logs: 0, todos: 0, tasks: 0, projects: 0, people: 0, tables: 0 };
        let readable = true;
        try {
            const [logs, todos, tasks, projects, people, tables] = await Promise.all([
                prisma_1.default.logEntry.count(),
                prisma_1.default.todo.count({ where: { deleted_at: null } }),
                prisma_1.default.projectTask.count({ where: { deleted_at: null } }),
                prisma_1.default.project.count({ where: { deleted_at: null } }),
                prisma_1.default.person.count({ where: { deleted_at: null } }),
                prisma_1.default.tableMeta.count({ where: { deleted_at: null } }),
            ]);
            counts = { logs, todos, tasks, projects, people, tables };
        }
        catch {
            readable = false;
        }
        let info = {
            path: file,
            dir: path_1.default.dirname(file),
            name: path_1.default.basename(file),
            size: 0,
            mtime: null,
            exists: false,
        };
        try {
            info = { ...info, ...fileInfo(file), exists: true };
        }
        catch {
            /* 文件不在也无妨，页面照常显示 */
        }
        const recent = readRecent()
            .filter((p) => p !== file)
            .map((p) => {
            try {
                return fileInfo(p);
            }
            catch {
                return null;
            }
        })
            .filter(Boolean);
        return { current: { ...info, counts, readable }, recent };
    });
    // ── 浏览目录（找 .db 工程 / 选保存位置）──────────────────
    app.get('/api/workspace/browse', async (req, reply) => {
        const q = zod_1.z.object({ dir: zod_1.z.string().optional() }).safeParse(req.query || {});
        const dir = q.success && q.data.dir ? q.data.dir : path_1.default.dirname((0, prisma_1.getDbFile)());
        let entries;
        try {
            entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
        }
        catch (e) {
            return reply.status(400).send({ error: '读不到这个目录', detail: String(e?.message || e) });
        }
        const dirs = [];
        const dbs = [];
        for (const e of entries) {
            if (e.name.startsWith('.'))
                continue;
            const full = path_1.default.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === 'node_modules')
                    continue;
                dirs.push({ name: e.name, path: full });
            }
            else if (/\.(db|sqlite|sqlite3)$/i.test(e.name)) {
                try {
                    dbs.push(fileInfo(full));
                }
                catch {
                    /* 单个文件读不到就跳过 */
                }
            }
        }
        return { dir, parent: path_1.default.dirname(dir), dirs, dbs };
    });
    // ── 打开已有工程 ────────────────────────────────────────
    app.post('/api/workspace/open', async (req, reply) => {
        const parsed = zod_1.z.object({ path: zod_1.z.string().min(1) }).safeParse(req.body || {});
        if (!parsed.success)
            return reply.status(400).send({ error: '参数校验失败' });
        const target = parsed.data.path;
        if (!fs_1.default.existsSync(target))
            return reply.status(400).send({ error: '文件不存在：' + target });
        const oldFile = (0, prisma_1.getDbFile)();
        const oldClient = (0, prisma_1.switchDb)(target);
        try {
            // 触发一次真实查询：库结构不对/文件损坏会在这里抛错
            await oldClient.tableMeta.count();
            await ensureDefaultTables(oldClient);
            (0, project_state_1.clearProjectMissing)(); // 方案 C3：切到了可用的库 → 解除「工程文件缺失」保护
        }
        catch (e) {
            (0, prisma_1.switchDb)(oldFile); // 回滚，别把程序切崩
            return reply.status(400).send({
                error: '这个文件打不开（可能不是本程序保存的工程）',
                detail: String(e?.message || e),
            });
        }
        pushRecent(target);
        return { ok: true, path: target };
    });
    // ── 新建工程 ────────────────────────────────────────────
    app.post('/api/workspace/new', async (req, reply) => {
        const parsed = zod_1.z
            .object({ dir: zod_1.z.string().optional(), name: zod_1.z.string().min(1).max(60) })
            .safeParse(req.body || {});
        if (!parsed.success)
            return reply.status(400).send({ error: '参数校验失败' });
        const dir = parsed.data.dir || path_1.default.dirname((0, prisma_1.getDbFile)());
        if (!fs_1.default.existsSync(dir))
            return reply.status(400).send({ error: '目录不存在：' + dir });
        let fname = safeFileName(parsed.data.name);
        if (!/\.db$/i.test(fname))
            fname += '.db';
        const target = path_1.default.join(dir, fname);
        if (fs_1.default.existsSync(target))
            return reply.status(400).send({ error: '同名文件已存在：' + fname });
        const oldFile = (0, prisma_1.getDbFile)();
        // 复制当前库（连同表结构）→ 清空业务数据 → 切过去
        try {
            fs_1.default.copyFileSync(oldFile, target);
        }
        catch (e) {
            return reply.status(500).send({ error: '创建失败', detail: String(e?.message || e) });
        }
        const client = (0, prisma_1.switchDb)(target);
        try {
            await client.$transaction([
                client.changeHistory.deleteMany(),
                client.pointsLedger.deleteMany(),
                client.todo.deleteMany(),
                client.logEntry.deleteMany(),
                client.projectTask.deleteMany(),
                client.project.deleteMany(),
                client.person.deleteMany(),
                client.tableMeta.deleteMany(),
            ]);
            await ensureDefaultTables(client);
            (0, project_state_1.clearProjectMissing)(); // 方案 C3：新工程可用 → 解除「工程文件缺失」保护
        }
        catch (e) {
            (0, prisma_1.switchDb)(oldFile);
            try {
                fs_1.default.unlinkSync(target);
            }
            catch {
                /* 删不掉就留着，别抛 */
            }
            return reply.status(500).send({ error: '初始化新工程失败', detail: String(e?.message || e) });
        }
        pushRecent(target);
        return { ok: true, path: target };
    });
    // ── 另存为（= 用户说的「把当前页面全部保存下来」）────────
    app.post('/api/workspace/save-as', async (req, reply) => {
        const parsed = zod_1.z
            .object({ dir: zod_1.z.string().optional(), name: zod_1.z.string().max(60).optional() })
            .safeParse(req.body || {});
        if (!parsed.success)
            return reply.status(400).send({ error: '参数校验失败' });
        const cur = (0, prisma_1.getDbFile)();
        const dir = parsed.data.dir || path_1.default.dirname(cur);
        if (!fs_1.default.existsSync(dir))
            return reply.status(400).send({ error: '目录不存在：' + dir });
        const base = parsed.data.name?.trim()
            ? safeFileName(parsed.data.name)
            : `${path_1.default.basename(cur, '.db')}_${tsName()}`;
        const fname = /\.db$/i.test(base) ? base : base + '.db';
        const target = path_1.default.join(dir, fname);
        if (fs_1.default.existsSync(target))
            return reply.status(400).send({ error: '同名文件已存在：' + fname });
        try {
            // VACUUM INTO：等写入落盘后复制，且顺带压缩碎片（直接 copyFile 在写入中可能拷到半截）
            await prisma_1.default.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
        }
        catch (e) {
            return reply.status(500).send({ error: '另存失败', detail: String(e?.message || e) });
        }
        return { ok: true, path: target, name: fname, size: fs_1.default.statSync(target).size };
    });
}
