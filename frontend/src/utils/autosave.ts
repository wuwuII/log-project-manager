/**
 * 自动保存 + 防丢失（方案第五节"最关键机制之一"）
 *
 * 四条触发路径，缺一不可：
 *   ① 输入中防抖 500ms
 *   ② 失焦立即 flush
 *   ③ 切后台 visibilitychange 立即 flush
 *   ④ 关页面 beforeunload + navigator.sendBeacon
 * 另外：每次输入同时写 IndexedDB 草稿，崩溃后可恢复。
 */
import localforage from 'localforage';
import api from '../api';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

type Item = { url: string; payload: any; draftKey?: string };

const pending = new Map<string, Item>();
let timer: ReturnType<typeof setTimeout> | null = null;
let state: SaveState = 'idle';
let listeners: Array<(s: SaveState) => void> = [];

localforage.config({ name: 'lpm', storeName: 'drafts' });

function emit(s: SaveState) {
  state = s;
  listeners.forEach((f) => {
    try {
      f(s);
    } catch {}
  });
}

export function onSaveState(f: (s: SaveState) => void): () => void {
  listeners.push(f);
  f(state);
  return () => {
    listeners = listeners.filter((x) => x !== f);
  };
}

export function getSaveState(): SaveState {
  return state;
}

export function pendingCount(): number {
  return pending.size;
}

/** 登记一条待保存项（同 key 覆盖），500ms 后自动落库 */
export function queueSave(key: string, url: string, payload: any, draftKey?: string) {
  pending.set(key, { url, payload, draftKey });
  emit('dirty');
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void flush();
  }, 500);
}

/** 立即把待保存队列推到服务端 */
export async function flush(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending.size === 0) return;

  const items = [...pending.entries()];
  pending.clear();
  emit('saving');

  let failed = false;
  for (const [, v] of items) {
    try {
      // ⚠️ api 的 baseURL 已经是 '/api'，这里必须去掉前缀，否则会拼成 /api/api/xxx
      const url = v.url.replace(/^\/api/, '');
      await api.post(url, v.payload);
      if (v.draftKey) await removeDraft(v.draftKey);
    } catch (e) {
      console.error('[autosave] 保存失败', v.url, e);
      failed = true;
      pending.set(v.url + JSON.stringify(v.payload).slice(0, 40), v); // 重新入队，下次再试
      emit('error');
    }
  }
  if (!failed) {
    emit('saved');
    setTimeout(() => {
      if (state === 'saved') emit('idle');
    }, 1500);
  }
}

/** 关页面时用 sendBeacon 兜底（比 fetch 可靠） */
export function beaconFlush(): void {
  if (pending.size === 0) return;
  for (const [, v] of pending) {
    try {
      const body = JSON.stringify(v.payload);
      const url = '/api' + v.url.replace(/^\/api/, '');
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(url, blob);
    } catch {}
  }
  pending.clear();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 方案 C3 第 4 块：把「所有待写队列」写到服务端，并返回结果。
 *
 * 与 flush() 的区别：
 *   · flush() 只尝试一轮；失败会把条目**重新入队**（等下次自动保存再试），
 *     调用方拿不到"到底存没存上"。
 *   · flushAll() 是给「立即保存」按钮用的：取消防抖计时器 → 立即 flush →
 *     若还有失败条目，最多再重试 3 轮（间隔递增）→ 返回最终是否清空。
 *
 * 返回：{ ok: pending.size === 0, pending: 剩余未保存条数 }
 *   · ok=true  → 队列已清空，可以安全关闭页面；
 *   · ok=false → 还有 pending 条没写成功（服务不可达等），UI 应提示重试。
 *
 * ⚠️ 只保证"把队列推到了服务端并收到响应"，不额外做服务端回读校验。
 *    失败条目仍留在队列里 —— 即使这里没成功，现有草稿机制（IndexedDB）也兜底。
 */
export async function flushAll(): Promise<{ ok: boolean; pending: number }> {
  await flush(); // 先落一轮（顺便取消未触发的防抖计时器）
  let rounds = 0;
  while (pending.size > 0 && rounds < 3) {
    rounds++;
    await sleep(300 * rounds); // 300ms / 600ms / 900ms 退避后重试
    await flush();
  }
  return { ok: pending.size === 0, pending: pending.size };
}

// ── IndexedDB 草稿 ────────────────────────────────────────────
export async function saveDraft(key: string, value: any): Promise<void> {
  try {
    await localforage.setItem(key, value);
  } catch {}
}

export async function getDraft<T>(key: string): Promise<T | null> {
  try {
    const v = await localforage.getItem<T>(key);
    return v ?? null;
  } catch {
    return null;
  }
}

export async function removeDraft(key: string): Promise<void> {
  try {
    await localforage.removeItem(key);
  } catch {}
}

/** 列出所有残留草稿 key（崩溃恢复用） */
export async function listDrafts(): Promise<string[]> {
  try {
    return await localforage.keys();
  } catch {
    return [];
  }
}
