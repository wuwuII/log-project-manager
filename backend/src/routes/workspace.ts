/**
 * 开始页（工程/文件管理）相关接口 —— 2026-10-03 新增
 *
 * 设计要点：
 *  - 一个工程 = 一个 .db 文件（SQLite 单文件），「打开工程」= 切换数据库连接。
 *  - 切换前先校验目标库能读（表存在），失败自动回滚到原来的库，避免把程序切崩。
 *  - 「另存为」用 SQLite 的 `VACUUM INTO`（比直接 copy 文件安全，会等写完、且压缩碎片），
 *    不切换当前工程 —— 这就是用户要的「把当前页面全部保存下来」。
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import prisma, { getDbFile, switchDb } from '../lib/prisma';
import { todayStr } from '../lib/date';
import { clearProjectMissing, isProjectMissing } from '../lib/project-state';

// ── 最近工程列表：放在当前库同目录，跟着数据走 ──────────────────
function recentFile(): string {
  return path.join(path.dirname(getDbFile()), 'recent-projects.json');
}

function readRecent(): string[] {
  try {
    const arr = JSON.parse(fs.readFileSync(recentFile(), 'utf-8'));
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && fs.existsSync(x)) : [];
  } catch {
    return [];
  }
}

function pushRecent(p: string) {
  const list = readRecent().filter((x) => x !== p);
  list.unshift(p);
  try {
    fs.writeFileSync(recentFile(), JSON.stringify(list.slice(0, 10), null, 2), 'utf-8');
  } catch {
    /* 记不上就算了，不影响主流程 */
  }
}

function fileInfo(p: string) {
  const st = fs.statSync(p);
  return {
    path: p,
    dir: path.dirname(p),
    name: path.basename(p),
    size: st.size,
    mtime: st.mtime.toISOString(),
  };
}

/** 给一个刚建好/刚打开的库补上默认 3 张工作表（与 app.ts 的 ensureDefaultTables 同规则） */
async function ensureDefaultTables(p: any) {
  const n = await p.tableMeta.count({ where: { deleted_at: null } });
  if (n > 0) return;
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
      data: { table_id: projTable.id, name: '默认项目', status: 'active', start_date: todayStr() },
    });
    await p.tableMeta.update({
      where: { id: projTable.id },
      data: { config: JSON.stringify({ project_id: proj.id }) },
    });
  }
}

function tsName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim();
}

export default async function (app: FastifyInstance) {
  // ── 当前工程信息 + 最近工程 ──────────────────────────────
  app.get('/api/workspace', async () => {
    const file = getDbFile();
    /**
     * 🔴 方案 C3 第 5 块：工程文件缺失时**不要碰数据库**。
     * Prisma 连 SQLite 时文件不存在会被自动创建成空库；这里提前返回，
     * 保证「缺失」状态下绝不会因为一次 count 查询把空库建出来。
     * （app.ts 的 onRequest 守卫也会拦这个接口，这里是防御性兜底。）
     */
    if (isProjectMissing()) {
      return {
        current: {
          path: file,
          dir: path.dirname(file),
          name: path.basename(file),
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
        prisma.logEntry.count(),
        prisma.todo.count({ where: { deleted_at: null } }),
        prisma.projectTask.count({ where: { deleted_at: null } }),
        prisma.project.count({ where: { deleted_at: null } }),
        prisma.person.count({ where: { deleted_at: null } }),
        prisma.tableMeta.count({ where: { deleted_at: null } }),
      ]);
      counts = { logs, todos, tasks, projects, people, tables };
    } catch {
      readable = false;
    }
    let info: any = {
      path: file,
      dir: path.dirname(file),
      name: path.basename(file),
      size: 0,
      mtime: null,
      exists: false,
    };
    try {
      info = { ...info, ...fileInfo(file), exists: true };
    } catch {
      /* 文件不在也无妨，页面照常显示 */
    }
    const recent = readRecent()
      .filter((p) => p !== file)
      .map((p) => {
        try {
          return fileInfo(p);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return { current: { ...info, counts, readable }, recent };
  });

  // ── 浏览目录（找 .db 工程 / 选保存位置）──────────────────
  app.get('/api/workspace/browse', async (req, reply) => {
    const q = z.object({ dir: z.string().optional() }).safeParse(req.query || {});
    const dir = q.success && q.data.dir ? q.data.dir : path.dirname(getDbFile());
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e: any) {
      return reply.status(400).send({ error: '读不到这个目录', detail: String(e?.message || e) });
    }
    const dirs: any[] = [];
    const dbs: any[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue;
        dirs.push({ name: e.name, path: full });
      } else if (/\.(db|sqlite|sqlite3)$/i.test(e.name)) {
        try {
          dbs.push(fileInfo(full));
        } catch {
          /* 单个文件读不到就跳过 */
        }
      }
    }
    return { dir, parent: path.dirname(dir), dirs, dbs };
  });

  // ── 打开已有工程 ────────────────────────────────────────
  app.post('/api/workspace/open', async (req, reply) => {
    const parsed = z.object({ path: z.string().min(1) }).safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败' });
    const target = parsed.data.path;
    if (!fs.existsSync(target)) return reply.status(400).send({ error: '文件不存在：' + target });

    const oldFile = getDbFile();
    const oldClient = switchDb(target);
    try {
      // 触发一次真实查询：库结构不对/文件损坏会在这里抛错
      await oldClient.tableMeta.count();
      await ensureDefaultTables(oldClient);
      clearProjectMissing(); // 方案 C3：切到了可用的库 → 解除「工程文件缺失」保护
    } catch (e: any) {
      switchDb(oldFile); // 回滚，别把程序切崩
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
    const parsed = z
      .object({ dir: z.string().optional(), name: z.string().min(1).max(60) })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败' });
    const dir = parsed.data.dir || path.dirname(getDbFile());
    if (!fs.existsSync(dir)) return reply.status(400).send({ error: '目录不存在：' + dir });
    let fname = safeFileName(parsed.data.name);
    if (!/\.db$/i.test(fname)) fname += '.db';
    const target = path.join(dir, fname);
    if (fs.existsSync(target)) return reply.status(400).send({ error: '同名文件已存在：' + fname });

    const oldFile = getDbFile();
    // 复制当前库（连同表结构）→ 清空业务数据 → 切过去
    try {
      fs.copyFileSync(oldFile, target);
    } catch (e: any) {
      return reply.status(500).send({ error: '创建失败', detail: String(e?.message || e) });
    }
    const client = switchDb(target);
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
      clearProjectMissing(); // 方案 C3：新工程可用 → 解除「工程文件缺失」保护
    } catch (e: any) {
      switchDb(oldFile);
      try {
        fs.unlinkSync(target);
      } catch {
        /* 删不掉就留着，别抛 */
      }
      return reply.status(500).send({ error: '初始化新工程失败', detail: String(e?.message || e) });
    }
    pushRecent(target);
    return { ok: true, path: target };
  });

  // ── 另存为（= 用户说的「把当前页面全部保存下来」）────────
  app.post('/api/workspace/save-as', async (req, reply) => {
    const parsed = z
      .object({ dir: z.string().optional(), name: z.string().max(60).optional() })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: '参数校验失败' });
    const cur = getDbFile();
    const dir = parsed.data.dir || path.dirname(cur);
    if (!fs.existsSync(dir)) return reply.status(400).send({ error: '目录不存在：' + dir });
    const base = parsed.data.name?.trim()
      ? safeFileName(parsed.data.name)
      : `${path.basename(cur, '.db')}_${tsName()}`;
    const fname = /\.db$/i.test(base) ? base : base + '.db';
    const target = path.join(dir, fname);
    if (fs.existsSync(target)) return reply.status(400).send({ error: '同名文件已存在：' + fname });
    try {
      // VACUUM INTO：等写入落盘后复制，且顺带压缩碎片（直接 copyFile 在写入中可能拷到半截）
      await prisma.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } catch (e: any) {
      return reply.status(500).send({ error: '另存失败', detail: String(e?.message || e) });
    }
    return { ok: true, path: target, name: fname, size: fs.statSync(target).size };
  });
}
