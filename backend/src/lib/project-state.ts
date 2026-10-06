/**
 * 「工程文件缺失」保护状态 —— 方案 C3 第 5 块
 *
 * 背景（要避免的事故）：Prisma 连 SQLite 时，**文件不存在会被自动创建成一个空库**；
 * 再叠加 app.ts 启动时的 `ensureDefaultTables()`，结果就是——用户的 `.db` 被改名/挪走
 * 后启动，程序**默默建了一个空工程**，看起来「数据全没了」。
 *
 * 处置：启动时记住当前工程 `.db` 在不在原位置；
 *   · 不在 → `app.ts` 不再调 ensureDefaultTables，且对业务接口统一回 409；
 *   · 用户通过开始页「打开已有工程」重新选一个能用的库后，`clearProjectMissing()` 解除。
 * 只用 fs 判断文件存在性，**不触发任何数据库连接**。
 */
import fs from 'fs';
import { getDbFile } from './prisma';

let missing = false;
let missingPath = '';

/** 重新判断当前工程文件是否存在（启动时调一次；不碰数据库） */
export function refreshProjectState(): boolean {
  const p = getDbFile();
  let exists = false;
  try {
    exists = fs.existsSync(p);
  } catch {
    exists = false;
  }
  missing = !exists;
  missingPath = p;
  return missing;
}

export function isProjectMissing(): boolean {
  return missing;
}

/** 缺失（或曾经缺失）的工程文件绝对路径，用于 409 响应里的 current_path */
export function projectMissingPath(): string {
  return missingPath || getDbFile();
}

/** 用户重新打开/新建了一个可用的工程后调用 */
export function clearProjectMissing(): void {
  missing = false;
}
