import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirmDialog } from '../utils/confirm';
import { Button, Checkbox, Input, Modal, Select, Switch, Tooltip, message } from 'antd';
import {
  BellOutlined,         // 提醒
  DeleteOutlined,
  EditOutlined,
  MinusOutlined,
  PlusOutlined,
  BorderOutlined,        // 未办：空方框 ☐
  CheckSquareOutlined,   // 已办：打了勾的方框 ☑
} from '@ant-design/icons';
import { DndContext, closestCenter } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import api from '../api';
import TodoToProject from './TodoToProject';
import { SortableItem, reorderIds, useDragSensors } from '../utils/dragSort';
import { flush, getDraft, queueSave, saveDraft } from '../utils/autosave';
import type { LogEntry, Person, Reminder, ReminderHit, ReminderRepeat, TableMeta, Todo } from '../types';

const WD = ['一', '二', '三', '四', '五', '六', '日'];
/**
 * ⚙️ 滚动窗口（**要调就改这三个数**，单位：周）
 *   WEEKS_BACK  本周之前渲染多少周 ← 2026-10-06 定：8 周
 *   WEEKS_FWD   本周之后渲染多少周 ← 2026-10-06 定：18 周
 *   JUMP_WEEKS  「前/后跳」每次跳几周 ← 12 周（约 3 个月，跳一次留重叠，不容易迷路）
 * 合计渲染 WEEKS_BACK + WEEKS_FWD = 26 周（约半年）；改大了首屏格子变多，老 Edge 84 上会更慢。
 */
const WEEKS_BACK = 8;
const WEEKS_FWD = 18;
const WEEKS_SHOWN = WEEKS_BACK + WEEKS_FWD;
const JUMP_WEEKS = 12;
/** 默认窗口起点 = 本周一往前 WEEKS_BACK 周（首次进工程 / 点「回到本周」都用它） */
const seedStart = () => addDays(mondayOf(new Date()), -7 * WEEKS_BACK);
/** 每周默认高度 / 可拖范围（px）。默认值必须与 index.css 的 --lpm-week-h 一致。 */
const DEFAULT_WEEK_H = 150;
const MIN_WEEK_H = 90;
const MAX_WEEK_H = 640;

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 建立日期：完整年月日 + 时分（待办栏要显示"建立"时间） */
const fmtDay = (s?: string | null) => {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 取某天所在周的周一 */
function mondayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // 周一=0
  x.setDate(x.getDate() - dow);
  return x;
}
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

interface Props {
  table: TableMeta;
  people: Person[];
  reloadPeople: () => void;
  tables: TableMeta[];
  /** 周高度写回 table.config 后通知父组件同步本地副本（可选） */
  onConfigSaved?: (cfg: Record<string, any>) => void;
}

const LogCalendar: React.FC<Props> = ({ table, people, reloadPeople, tables, onConfigSaved }) => {
  // 窗口起点：首次进工程 = 本周一往前 WEEKS_BACK 周；之后按该工作表 config 里记住的位置恢复
  const [rangeStart, setRangeStart] = useState<Date>(() => seedStart());
  /** 滚动容器（用于"跳哪看哪"与恢复上次位置） */
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 本次渲染后要滚到哪：today=当天那一周（首次进工程）/ week=指定周 / top=窗口顶部 */
  const pendingScrollRef = useRef<{ mode: 'today' } | { mode: 'week'; key: string } | { mode: 'top' } | null>({ mode: 'today' });
  /** 位置保存防抖计时器 + 上次存过的值（值没变就不写库，避免刷操作记录） */
  const saveViewTimerRef = useRef<number | null>(null);
  const lastSavedViewRef = useRef<string>('');

  /** 把「窗口起点 + 顶部那一周」写回该工作表 config（读-改-写合并，保留 project_id / week_heights 等字段） */
  const persistView = useCallback((range: string, topWeek: string) => {
    const sig = range + '|' + topWeek;
    if (sig === lastSavedViewRef.current) return;
    lastSavedViewRef.current = sig;
    const nextCfg = { ...cfgRef.current, log_view: { ...(cfgRef.current.log_view || {}), range, topWeek } };
    cfgRef.current = nextCfg;
    onConfigSaved?.(nextCfg);
    void api.patch(`/tables/${table.id}`, { config: nextCfg }).catch(() => {});
  }, [table.id, onConfigSaved]);
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [todos, setTodos] = useState<Todo[]>([]);
  const [todoTitle, setTodoTitle] = useState('');
  const [todoAssignee, setTodoAssignee] = useState<string | undefined>();
  const [todoPoints, setTodoPoints] = useState<number>(0);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [transferTodo, setTransferTodo] = useState<Todo | null>(null);

  const todayStr = ymd(new Date());
  const dirtyLocal = useRef<Set<string>>(new Set());
  const todayRef = useRef<HTMLDivElement>(null);
  const sensors = useDragSensors();

  const days = useMemo(() => {
    const arr: Date[] = [];
    for (let i = 0; i < WEEKS_SHOWN * 7; i++) arr.push(addDays(rangeStart, i));
    return arr;
  }, [rangeStart]);

  const loadLogs = useCallback(async () => {
    const from = ymd(days[0]);
    const to = ymd(days[days.length - 1]);
    try {
      const r = await api.get('/logs', { params: { table_id: table.id, from, to } });
      const map: Record<string, string> = {};
      (r.data.logs as LogEntry[]).forEach((l) => {
        map[l.entry_date] = l.content || '';
      });
      for (const k of dirtyLocal.current) {
        const d = await getDraft<string>(`draft:${table.id}:${k}`);
        if (d !== null) map[k] = d;
      }
      setEntries(map);
    } catch (e: any) {
      message.error('日志加载失败：' + (e?.friendlyMessage || ''));
    }
  }, [table.id, days]);

  const loadTodos = useCallback(async () => {
    try {
      const r = await api.get('/todos', { params: { table_id: table.id } });
      const list: Todo[] = r.data.todos || [];
      list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      setTodos(list);
    } catch {}
  }, [table.id]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    void loadTodos();
  }, [loadTodos]);

  // ── 提醒（2026-10-08 用户需求：日志页加提醒，格子里的"提前写好的文字"）────
  //   每张日志工作表各管各的（按 table_id 存）；后端按 from~to 把重复规则展开成 by_date。
  //   老后端没有 /reminders 接口时静默降级（catch → 空），不影响日志本身。
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [reminderHits, setReminderHits] = useState<Record<string, ReminderHit[]>>({});
  const [reminderOpen, setReminderOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rText, setRText] = useState('');
  const [rRepeat, setRRepeat] = useState<ReminderRepeat>('once');
  const [rDate, setRDate] = useState('');
  const [rWeekdays, setRWeekdays] = useState<number[]>([]);
  const [rMonthDays, setRMonthDays] = useState<number[]>([]);
  const [rYearDates, setRYearDates] = useState<{ month: number; day: number }[]>([]);
  const [rStart, setRStart] = useState('');
  const [rEnd, setREnd] = useState('');
  const [rEnabled, setREnabled] = useState(true);

  const loadReminders = useCallback(async () => {
    const from = ymd(days[0]);
    const to = ymd(days[days.length - 1]);
    try {
      const r = await api.get('/reminders', { params: { table_id: table.id, from, to } });
      setReminders((r.data.reminders as Reminder[]) || []);
      setReminderHits((r.data.by_date as Record<string, ReminderHit[]>) || {});
    } catch {
      setReminders([]);
      setReminderHits({});
    }
  }, [table.id, days]);

  useEffect(() => {
    void loadReminders();
  }, [loadReminders]);

  /** 提醒规则说成人话（列表里显示用） */
  const ruleText = (r: Reminder) => {
    const k = r.rule || {};
    if (r.repeat === 'once') return k.date ? `只此一次 ${k.date}` : '只此一次（未选日期）';
    if (r.repeat === 'weekly') {
      const ws = (k.weekdays || []).map((w: number) => '周' + (WD[w - 1] || '?'));
      return '每周 ' + (ws.join('、') || '（未选）');
    }
    if (r.repeat === 'monthly') return '每月 ' + ((k.days || []).join('、') || '（未选）') + ' 号';
    if (r.repeat === 'yearly') {
      const ds = (k.dates || []).map((x: any) => `${x.month}月${x.day}日`);
      return '每年 ' + (ds.join('、') || '（未选）');
    }
    return '';
  };

  const resetReminderForm = () => {
    setEditingId(null);
    setRText('');
    setRRepeat('once');
    setRDate(todayStr);
    setRWeekdays([]);
    setRMonthDays([]);
    setRYearDates([{ month: new Date().getMonth() + 1, day: new Date().getDate() }]);
    setRStart('');
    setREnd('');
    setREnabled(true);
  };

  const openReminderEditor = (r?: Reminder) => {
    if (!r) {
      resetReminderForm();
      return;
    }
    const k = r.rule || {};
    setEditingId(r.id);
    setRText(r.text);
    setRRepeat(r.repeat);
    setRDate(k.date || '');
    setRWeekdays(Array.isArray(k.weekdays) ? k.weekdays.map(Number) : []);
    setRMonthDays(Array.isArray(k.days) ? k.days.map(Number) : []);
    setRYearDates(
      Array.isArray(k.dates) && k.dates.length
        ? k.dates.map((x: any) => ({ month: Number(x.month), day: Number(x.day) }))
        : [{ month: 1, day: 1 }],
    );
    setRStart(r.start_date || '');
    setREnd(r.end_date || '');
    setREnabled(r.enabled !== false);
  };

  const buildRule = () => {
    if (rRepeat === 'once') return { date: rDate };
    if (rRepeat === 'weekly') return { weekdays: rWeekdays };
    if (rRepeat === 'monthly') return { days: rMonthDays };
    return { dates: rYearDates.filter((x) => x.month && x.day) };
  };

  const ruleProblem = () => {
    if (!rText.trim()) return '请填写提醒内容';
    if (rRepeat === 'once' && !rDate) return '请选择日期';
    if (rRepeat === 'weekly' && !rWeekdays.length) return '请至少选一个星期几';
    if (rRepeat === 'monthly' && !rMonthDays.length) return '请至少选一个号';
    if (rRepeat === 'yearly' && !rYearDates.filter((x) => x.month && x.day).length) return '请至少填一个「几月几号」';
    if (rStart && rEnd && rStart > rEnd) return '开始日期不能晚于结束日期';
    return '';
  };

  const saveReminder = async () => {
    const bad = ruleProblem();
    if (bad) return message.warning(bad);
    const wasEdit = !!editingId;
    const body = {
      table_id: table.id,
      text: rText.trim(),
      repeat: rRepeat,
      rule: buildRule(),
      start_date: rStart || null,
      end_date: rEnd || null,
      enabled: rEnabled,
    };
    try {
      if (editingId) await api.patch(`/reminders/${editingId}`, body);
      else await api.post('/reminders', body);
      await loadReminders();
      resetReminderForm();
      setReminderOpen(false); // 2026-10-08 用户反馈：原来点完只能刷新页面才能关掉
      message.success(wasEdit ? '已保存' : '已添加提醒');
    } catch (e: any) {
      message.error(e?.friendlyMessage || '保存失败');
    }
  };

  const delReminder = (r: Reminder) => {
    confirmDialog({
      title: '删除提醒',
      content: `确定删除提醒「${r.text}」？（删掉后格子里就不显示了）`,
      okText: '删除',
      danger: true,
      onOk: async () => {
        await api.delete(`/reminders/${r.id}`);
        await loadReminders();
        if (editingId === r.id) resetReminderForm();
      },
    });
  };

  const toggleReminderEnabled = async (r: Reminder) => {
    try {
      await api.patch(`/reminders/${r.id}`, { enabled: !r.enabled });
      await loadReminders();
    } catch (e: any) {
      message.error(e?.friendlyMessage || '操作失败');
    }
  };

  /** 打开/切换工作表、或点了前/后跳之后：按 pendingScrollRef 决定滚到哪
   *  · 首次进工程 → 滚到「今天」那一周并居中（用户 2026-10-06 要求）
   *  · 恢复上次位置 → 滚到记住的那一周（顶部对齐）
   *  · 点了前/后跳 → 显示新窗口的顶部
   */
  useEffect(() => {
    const t = window.setTimeout(() => {
      const m = pendingScrollRef.current;
      const sc = scrollRef.current;
      pendingScrollRef.current = null;
      if (m && m.mode === 'week' && sc) {
        const el = sc.querySelector(`[data-week="${m.key}"]`) as HTMLElement | null;
        if (el) {
          // ⚠️ 用 rect 差值滚，不要用 scrollIntoView：后者会连带滚动外层容器，
          //    实测每次恢复会偏大约一周（-163px）。rect 差值只影响这一个容器。
          const sr = sc.getBoundingClientRect();
          const er = el.getBoundingClientRect();
          sc.scrollTop += er.top - sr.top;
          return;
        }
      }
      if (m && m.mode === 'top') { if (sc) sc.scrollTop = 0; return; }
      todayRef.current?.scrollIntoView({ block: 'center' });
    }, 260);
    return () => window.clearTimeout(t);
  }, [table.id, rangeStart]);

  // ── 每周高度：鼠标拖动调整 + 双击恢复默认 ─────────────────────
  //  · 渲染：每行内联 --lpm-week-h 控制这一周高度（index.css 里 .lpm-week-day 用它做 min-height）。
  //  · 拖动：原生 mousedown/mousemove/mouseup（**不用 pointer events**，老 Chromium 有坑）。
  //         拖动期间直接改 DOM 上的 CSS 变量、不走 React state → 不产生逐帧重渲染，
  //         也就不会触发隐藏的 ResizeObserver 循环（本项目在甘特图那侧踩过这个坑，见 ProjectPlan）。
  //  · 持久化：写进该工作表 config 的 week_heights（键 = 该周周一 YYYY-MM-DD）；
  //         拖到松手才存一次；写之前 read-modify-write 合并，保留 project_id 等已有字段。
  const [weekHeights, setWeekHeights] = useState<Record<string, number>>({});
  const cfgRef = useRef<Record<string, any>>({});
  /** 拖动时浮出的提示（显示「哪一周 · 当前高度」）。拖动中直接改 DOM，不 setState。 */
  const pillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { cfgRef.current = JSON.parse(table.config || '{}') || {}; } catch { cfgRef.current = {}; }
    const wh = cfgRef.current.week_heights;
    setWeekHeights(wh && typeof wh === 'object' ? { ...wh } : {});
    // 位置记忆（用户 2026-10-06）：停在哪儿，下次打开就显示哪儿；第一次进工程才用"当天那一周"
    const v = cfgRef.current.log_view;
    if (v && typeof v.range === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.range)) {
      const d = new Date(v.range + 'T00:00:00');
      setRangeStart(isNaN(d.getTime()) ? seedStart() : d);
      pendingScrollRef.current = v.topWeek ? { mode: 'week', key: v.topWeek } : { mode: 'top' };
      lastSavedViewRef.current = v.range + '|' + (v.topWeek || '');
    } else {
      setRangeStart(seedStart());
      pendingScrollRef.current = { mode: 'today' };
      lastSavedViewRef.current = '';
    }
    // 只在「切换工作表」时按 config 重新播种；同一张表 config 变化（例如本页自己写回）不重置，
    // 免得正在拖动时被清空。故意只依赖 table.id。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table.id]);

  const persistWeekHeights = async (heights: Record<string, number>) => {
    try {
      // ⚠️ 必须读-改-写合并：config 里还有 project_id 等字段，整体覆盖会丢
      const nextCfg = { ...cfgRef.current, week_heights: { ...heights } };
      cfgRef.current = nextCfg;
      await api.patch(`/tables/${table.id}`, { config: nextCfg });
      onConfigSaved?.(nextCfg);
    } catch (e: any) {
      message.error(e?.friendlyMessage || '周高度保存失败');
    }
  };

  //  2026-10-06 修「拖哪一周看起来动的是另一周」：拖拽区扩到「这一周的日期栏」本身，
  //  并且拖动时这一周整块高亮 + 浮出「9/14–9/20 · 这一周 240px」，归属一目了然。
  const startWeekResize = (e: React.MouseEvent<HTMLElement>, weekKey: string, label: string) => {
    e.preventDefault();
    e.stopPropagation();
    // ⚠️ 必须用 closest：日期栏的父节点是 .lpm-week-day，不是 .lpm-week-row。
    const row = (e.currentTarget as HTMLElement).closest('.lpm-week-row') as HTMLElement | null;
    if (!row) return;
    const startY = e.clientY;
    const startH = weekHeights[weekKey] ?? DEFAULT_WEEK_H;
    const pill = pillRef.current;
    const showPill = (h: number, y: number) => {
      if (!pill) return;
      pill.textContent = `${label} · 这一周 ${h}px`;
      pill.style.display = 'block';
      pill.style.left = Math.round(e.clientX + 16) + 'px';
      // 别把浮层跑出屏幕（拖到视口上/下边缘时）
      const maxTop = (window.innerHeight || 900) - 44;
      pill.style.top = Math.max(28, Math.min(maxTop, Math.round(y + 16))) + 'px';
    };
    let last = startH;
    row.classList.add('dragging');
    showPill(last, e.clientY);
    const move = (ev: MouseEvent) => {
      last = Math.max(MIN_WEEK_H, Math.min(MAX_WEEK_H, Math.round(startH + (ev.clientY - startY))));
      row.style.setProperty('--lpm-week-h', last + 'px'); // 直接改样式，不 setState
      showPill(last, ev.clientY);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      row.classList.remove('dragging');
      if (pill) pill.style.display = 'none';
      const next = { ...weekHeights, [weekKey]: last };
      setWeekHeights(next);
      void persistWeekHeights(next); // 拖动结束再存一次
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  };

  /** 双击拖拽条：这一周恢复默认高度（并把 config 里该周记录删掉） */
  const resetWeekHeight = (weekKey: string) => {
    const next = { ...weekHeights };
    delete next[weekKey];
    setWeekHeights(next);
    void persistWeekHeights(next);
  };

  const weekH = (weekKey: string) => weekHeights[weekKey] ?? DEFAULT_WEEK_H;

  const onEdit = (dateKey: string, value: string) => {
    setEntries((p) => ({ ...p, [dateKey]: value }));
    dirtyLocal.current.add(dateKey);
    const draftKey = `draft:${table.id}:${dateKey}`;
    void saveDraft(draftKey, value);
    queueSave(
      `log:${table.id}:${dateKey}`,
      '/api/logs/autosave',
      { table_id: table.id, entry_date: dateKey, content: value },
      draftKey
    );
  };

  const onBlur = () => {
    void flush();
  };

  // ── 待办操作 ─────────────────────────────────────────────
  const addTodo = async () => {
    if (!todoTitle.trim()) return message.warning('请输入待办标题');
    try {
      await api.post('/todos', {
        table_id: table.id,
        title: todoTitle.trim(),
        assignee_id: todoAssignee || null,
        points: Number(todoPoints) || 0,
      });
      setTodoTitle('');
      setTodoAssignee(undefined);
      setTodoPoints(0);
      await loadTodos();
      message.success('已添加');
    } catch (e: any) {
      message.error(e?.friendlyMessage || '添加失败');
    }
  };

  const toggleTodo = async (t: Todo) => {
    try {
      await api.patch(`/todos/${t.id}`, { status: t.status === 'done' ? 'pending' : 'done' });
      await loadTodos();
      await reloadPeople();
    } catch (e: any) {
      message.error(e?.friendlyMessage || '操作失败');
    }
  };

  const delTodo = (t: Todo) => {
    confirmDialog({
      title: '删除待办',
      content: `确定删除「${t.title}」？（软删除，积分流水保留）`,
      okText: '删除',
      danger: true,
      onOk: async () => {
        await api.delete(`/todos/${t.id}`);
        await loadTodos();
      },
    });
  };

  /** 待办拖动排序（只在"待办中"区域内生效）*/
  const onTodoDragEnd = async (e: DragEndEvent) => {
    const ids = pending.map((t) => t.id);
    const next = reorderIds(ids, e);
    if (!next) return;
    const order = Object.fromEntries(next.map((id, i) => [id, i]));
    setTodos((prev) => [...prev].sort((a, b) => {
      const ai = a.status === 'done' ? 9999 : order[a.id];
      const bi = b.status === 'done' ? 9999 : order[b.id];
      return ai - bi;
    }));
    try {
      await api.patch('/todos/reorder', { ordered_ids: next });
    } catch (err: any) {
      message.error(err?.friendlyMessage || '排序保存失败');
      await loadTodos();
    }
  };

  const pending = todos.filter((t) => t.status !== 'done');
  // 2026-10-06 用户要求：已完成的按"完成时间倒序"排 → 刚完成的在最上面
  const done = todos
    .filter((t) => t.status === 'done')
    .sort((a, b) => new Date(b.completed_at || 0).getTime() - new Date(a.completed_at || 0).getTime());
  const pMap = Object.fromEntries(people.map((p) => [p.id, p.name]));

  /** 跳到指定的某一天：窗口起点 = 那一天所在周的周一，跳完那一天就在顶部 */
  const jumpToDate = (v: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return;
    const d = new Date(v + 'T00:00:00');            // 本地时区解析，别用 new Date('YYYY-MM-DD')（会按 UTC）
    if (isNaN(d.getTime())) return;
    void flush();
    const target = mondayOf(d);
    setRangeStart(target);
    pendingScrollRef.current = { mode: 'top' };
    persistView(ymd(target), ymd(target));          // 跳完这个窗口的顶部就是那一周
  };

  /** 前/后跳：窗口整体平移 n 周；跳完显示新窗口顶部，并把新位置记下来 */
  const jump = (n: number) => () => {
    void flush();
    const d = addDays(rangeStart, n * 7);
    setRangeStart(d);
    pendingScrollRef.current = { mode: 'top' };
    persistView(ymd(d), '');
  };

  const fmtTime = (s?: string | null) => {
    if (!s) return '';
    const d = new Date(s);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  return (
    <div className="lpm-cal-wrap">
      <div className="lpm-cal-main" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="lpm-cal-head">
          <span style={{ color: '#666' }}>
            {ymd(days[0])} ~ {ymd(days[days.length - 1])}
          </span>
          <Button size="small" onClick={jump(-JUMP_WEEKS)}>{`←  前 ${JUMP_WEEKS} 周`}</Button>
          <Button size="small" onClick={jump(JUMP_WEEKS)}>{`后 ${JUMP_WEEKS} 周  →`}</Button>
          <span style={{ color: '#999', fontSize: 11.5 }}>跳到</span>
          <input
            type="date"
            className="lpm-jump-date"
            aria-label="跳到某一天"
            title="选一天，跳到它所在的那一周"
            onChange={(e) => jumpToDate(e.target.value)}
            style={{ fontSize: 12, padding: '1px 4px', borderRadius: 4, border: '1px solid #d9d9d9', background: '#fff' }}
          />
          <Button
            size="small"
            onClick={() => {
              void flush();
              const d = seedStart();
              setRangeStart(d);
              pendingScrollRef.current = { mode: 'today' };
              persistView(ymd(d), '');
            }}
          >
            回到本周
          </Button>
          <Button
            size="small"
            icon={<BellOutlined />}
            onClick={() => {
              resetReminderForm();
              setReminderOpen(true);
            }}
          >
            提醒{reminders.length ? `（${reminders.length}）` : ''}
          </Button>
          <span style={{ flex: 1 }} />
          <span style={{ color: '#999', fontSize: 11.5 }}>
            抓某一周的日期栏上下拖 = 调这一周高度（双击恢复默认）· 滚轮查看多周 · 输入自动保存
          </span>
        </div>

        {/* 滚轮直接上下滚，不用按钮翻页 */}
        <div
          className="lpm-cal-scroll"
          ref={scrollRef}
          style={{ flex: 1, minHeight: 0 }}
          onScroll={() => {
            if (saveViewTimerRef.current) window.clearTimeout(saveViewTimerRef.current);
            saveViewTimerRef.current = window.setTimeout(() => {
              const sc = scrollRef.current;
              if (!sc) return;
              const rows = Array.from(sc.querySelectorAll('.lpm-week-row')) as HTMLElement[];
              // 判据与"恢复"保持一致（都用 rect），否则每恢复一次会漂一周
              const sr = sc.getBoundingClientRect();
              const first = rows.find((r) => r.getBoundingClientRect().top >= sr.top - 1) || rows[rows.length - 1];
              persistView(ymd(rangeStart), first?.getAttribute('data-week') || '');
            }, 1200);
          }}
        >
          {Array.from({ length: WEEKS_SHOWN }).map((_, w) => {
            const weekDays = days.slice(w * 7, w * 7 + 7);
            const isCurrentWeek = weekDays.some((d) => ymd(d) === todayStr);
            const weekKey = ymd(weekDays[0]); // 该周周一 YYYY-MM-DD，作为 week_heights 的键
            const weekLabel = `${weekDays[0].getMonth() + 1}/${weekDays[0].getDate()}–${weekDays[6].getMonth() + 1}/${weekDays[6].getDate()}`;
            return (
              <div
                className="lpm-week-row"
                key={w}
                data-week={weekKey}
                ref={isCurrentWeek ? todayRef : undefined}
                style={{ '--lpm-week-h': weekH(weekKey) + 'px' } as React.CSSProperties}
              >
                {weekDays.map((d, i) => {
                  const key = ymd(d);
                  return (
                    <div
                      key={key}
                      className={'lpm-week-day' + (key === todayStr ? ' today' : '')}
                    >
                      <div
                        className="lpm-day-head"
                        title={`${weekLabel} 这一周 · 按住上下拖动调高度，双击恢复默认`}
                        onMouseDown={(e) => startWeekResize(e, weekKey, weekLabel)}
                        onDoubleClick={() => resetWeekHeight(weekKey)}
                      >
                        <span>
                          {d.getMonth() + 1}/{d.getDate()}
                        </span>
                        <span style={{ fontSize: 10.5, color: key === todayStr ? '#217346' : '#aaa' }}>
                          周{WD[i]}
                        </span>
                      </div>
                      <div
                        className={'lpm-day-body' + (reminderHits[key]?.length ? ' has-rem' : '')}
                      >
                        {!!reminderHits[key]?.length && (
                          <div className="lpm-reminders">
                            {reminderHits[key].map((h) => (
                              <div
                                className="lpm-reminder"
                                key={key + '-' + h.id}
                                title={'提醒：' + h.text}
                                style={h.color ? { borderLeftColor: h.color } : undefined}
                              >
                                <BellOutlined />
                                <span>{h.text}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        <textarea
                          className="lpm-day-textarea"
                          value={entries[key] ?? ''}
                          placeholder="写点什么…"
                          onChange={(e) => onEdit(key, e.target.value)}
                          onBlur={onBlur}
                        />
                      </div>
                    </div>
                  );
                })}
                {/* 拖拽条（这一周的下边缘）：按住上下拖 = 调这一周的高度；双击 = 恢复默认 */}
                <div
                  className="lpm-week-resize"
                  title={`${weekLabel} 这一周 · 按住上下拖动调高度 · 双击恢复默认`}
                  onMouseDown={(e) => startWeekResize(e, weekKey, weekLabel)}
                  onDoubleClick={() => resetWeekHeight(weekKey)}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* 拖动时跟着鼠标的提示：这一周是哪一周、当前多少 px */}
      <div ref={pillRef} className="lpm-week-pill" />

      {/* ── 待办栏（可折叠，待办中支持拖动排序）── */}
      <div className={'lpm-todo-panel' + (panelCollapsed ? ' collapsed' : '')}>
        <div className="lpm-todo-head">
          <Tooltip title={panelCollapsed ? '展开待办栏' : '折叠待办栏'}>
            <Button
              size="small"
              type="text"
              icon={panelCollapsed ? <PlusOutlined /> : <MinusOutlined />}
              onClick={() => setPanelCollapsed((v) => !v)}
            />
          </Tooltip>
          {!panelCollapsed && <span>待办（{pending.length}）</span>}
        </div>

        {!panelCollapsed && (
          <>
            <div style={{ padding: 8, borderBottom: '1px solid #ebebeb', background: '#fff' }}>
              <Input
                size="small"
                placeholder="待办标题"
                value={todoTitle}
                onChange={(e) => setTodoTitle(e.target.value)}
                onPressEnter={addTodo}
                style={{ marginBottom: 6 }}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <Select
                  size="small"
                  placeholder="负责人"
                  allowClear
                  style={{ flex: 1, minWidth: 0 }}
                  value={todoAssignee}
                  onChange={setTodoAssignee}
                  options={people.map((p) => ({ value: p.id, label: p.name }))}
                />
                <Input
                  size="small"
                  type="number"
                  style={{ width: 62 }}
                  placeholder="积分"
                  value={todoPoints}
                  onChange={(e) => setTodoPoints(Number(e.target.value) || 0)}
                />
                <Button size="small" type="primary" onClick={addTodo}>
                  加
                </Button>
              </div>
            </div>

            <div className="lpm-todo-body">
              <div className="lpm-todo-sec-title">待办中（{pending.length}）· 可拖动排序</div>
              {pending.length === 0 && <div style={{ padding: 12, color: '#aaa', fontSize: 12 }}>暂无</div>}
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onTodoDragEnd}>
                <SortableContext items={pending.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                  {pending.map((t) => (
                    <SortableItem key={t.id} id={t.id} className="lpm-todo-item lpm-sortable-item">
                      <Button
                        size="small"
                        type="text"
                        icon={<BorderOutlined />}
                        onClick={() => toggleTodo(t)}
                        title="标记完成"
                      />
                      <div className="lpm-todo-title">
                        <div>{t.title}</div>
                        <div className="lpm-todo-meta">
                          <span className="lpm-todo-created">建立 {fmtDay(t.record_time)}</span>
                          {t.assignee_id ? pMap[t.assignee_id] || '（已删人员）' : '未指派'}
                          {t.points ? ` · ${t.points} 分` : ''}
                        </div>
                      </div>
                      <Button size="small" type="text" title="添加到项目计划" onClick={() => setTransferTodo(t)}>
                        →计划
                      </Button>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => delTodo(t)} />
                    </SortableItem>
                  ))}
                </SortableContext>
              </DndContext>

              <div className="lpm-todo-sec-title">已完成（{done.length}）</div>
              {done.length === 0 && <div style={{ padding: 12, color: '#aaa', fontSize: 12 }}>暂无</div>}
              {done.map((t) => (
                <div className="lpm-todo-item done" key={t.id}>
                  <Button
                    size="small"
                    type="text"
                    icon={<CheckSquareOutlined style={{ color: '#217346' }} />}
                    onClick={() => toggleTodo(t)}
                    title="取消完成"
                  />
                  <div className="lpm-todo-title">
                    <div>{t.title}</div>
                    <div className="lpm-todo-meta">
                      <span className="lpm-todo-created">建立 {fmtDay(t.record_time)}</span>
                      {t.assignee_id ? pMap[t.assignee_id] || '' : '未指派'}
                      {t.points ? ` · ${t.points} 分` : ''}
                      {t.completed_at ? ` · 完成 ${fmtTime(t.completed_at)}` : ''}
                    </div>
                  </div>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => delTodo(t)} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── 提醒管理（2026-10-08 用户需求）── */}
      <Modal
        title={`提醒 · ${table.name}`}
        open={reminderOpen}
        onCancel={() => setReminderOpen(false)}
        afterClose={resetReminderForm}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button
              onClick={() => {
                resetReminderForm();
                setReminderOpen(false);
              }}
            >
              取消
            </Button>
            <Button type="primary" onClick={saveReminder}>
              {editingId ? '保存修改' : '添加提醒'}
            </Button>
          </div>
        }
        width={660}
      >
        <div className="lpm-rem-tip">
          提醒会直接显示在<b>对应日期的格子</b>里（相当于提前写好的文字）；周期提醒会按规则自动落到每一天。
        </div>

        <div className="lpm-rem-list">
          {reminders.length === 0 && (
            <div style={{ color: '#aaa', fontSize: 12, padding: 8 }}>
              还没有提醒。在下面填一条试试 —— 支持「只此一次 / 每周几 / 每月几号 / 每年几月几号」，还能限定生效的起止日期。
            </div>
          )}
          {reminders.map((r) => (
            <div className="lpm-rem-row" key={r.id}>
              <BellOutlined style={{ color: r.enabled ? '#faad14' : '#ccc', marginTop: 3 }} />
              <div className="lpm-rem-main">
                <div className="lpm-rem-text">{r.text}</div>
                <div className="lpm-rem-meta">
                  {ruleText(r)}
                  {' · '}
                  {r.start_date || r.end_date
                    ? `${r.start_date || '不限'} ~ ${r.end_date || '不限'}`
                    : '不限时间范围'}
                  {r.enabled ? '' : ' · 已停用'}
                </div>
              </div>
              <Switch size="small" checked={r.enabled} onChange={() => toggleReminderEnabled(r)} />
              <Button size="small" type="text" title="编辑" icon={<EditOutlined />} onClick={() => openReminderEditor(r)} />
              <Button size="small" type="text" danger title="删除" icon={<DeleteOutlined />} onClick={() => delReminder(r)} />
            </div>
          ))}
        </div>

        <div className="lpm-rem-form-title">{editingId ? '编辑提醒' : '新增提醒'}</div>

        <Input
          placeholder="办什么事（例如：交周报 / 张三体检 / 项目评审）"
          value={rText}
          onChange={(e) => setRText(e.target.value)}
          style={{ marginBottom: 8 }}
        />

        <div className="lpm-rem-line">
          <span className="lbl">重复</span>
          <Select
            size="small"
            style={{ width: 120 }}
            value={rRepeat}
            onChange={(v) => setRRepeat(v as ReminderRepeat)}
            options={[
              { value: 'once', label: '只此一次' },
              { value: 'weekly', label: '每周' },
              { value: 'monthly', label: '每月' },
              { value: 'yearly', label: '每年' },
            ]}
          />
          {rRepeat === 'once' && (
            <input
              type="date"
              className="lpm-jump-date"
              value={rDate}
              onChange={(e) => setRDate(e.target.value)}
            />
          )}
          {rRepeat === 'weekly' && (
            <Checkbox.Group
              value={rWeekdays}
              onChange={(v) => setRWeekdays(v as number[])}
              options={WD.map((w, i) => ({ label: '周' + w, value: i + 1 }))}
            />
          )}
          {rRepeat === 'monthly' && (
            <Select
              size="small"
              mode="multiple"
              style={{ minWidth: 300, maxWidth: 420 }}
              placeholder="每月几号（可多选）"
              value={rMonthDays}
              onChange={(v) => setRMonthDays(v as number[])}
              options={Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: `${i + 1}号` }))}
            />
          )}
          {rRepeat === 'yearly' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
              {rYearDates.map((x, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Select
                    size="small"
                    style={{ width: 84 }}
                    value={x.month}
                    onChange={(v) => setRYearDates((p) => p.map((y, j) => (j === i ? { ...y, month: v } : y)))}
                    options={Array.from({ length: 12 }, (_, m) => ({ value: m + 1, label: `${m + 1}月` }))}
                  />
                  <Select
                    size="small"
                    style={{ width: 84 }}
                    value={x.day}
                    onChange={(v) => setRYearDates((p) => p.map((y, j) => (j === i ? { ...y, day: v } : y)))}
                    options={Array.from({ length: 31 }, (_, d) => ({ value: d + 1, label: `${d + 1}日` }))}
                  />
                  {rYearDates.length > 1 && (
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => setRYearDates((p) => p.filter((_, j) => j !== i))}
                    />
                  )}
                </div>
              ))}
              <Button size="small" onClick={() => setRYearDates((p) => [...p, { month: 1, day: 1 }])}>
                + 再加一天
              </Button>
            </div>
          )}
        </div>

        <div className="lpm-rem-line">
          <span className="lbl">生效范围</span>
          <input
            type="date"
            className="lpm-jump-date"
            value={rStart}
            onChange={(e) => setRStart(e.target.value)}
          />
          <span style={{ color: '#999' }}>到</span>
          <input
            type="date"
            className="lpm-jump-date"
            value={rEnd}
            onChange={(e) => setREnd(e.target.value)}
          />
          <span style={{ color: '#999', fontSize: 11.5 }}>（留空 = 不限）</span>
        </div>

        <div className="lpm-rem-line">
          <span className="lbl">启用</span>
          <Switch size="small" checked={rEnabled} onChange={setREnabled} />
          <span style={{ flex: 1 }} />
          {editingId && (
            <Button size="small" onClick={resetReminderForm}>
              取消编辑
            </Button>
          )}
        </div>
      </Modal>

      <TodoToProject
        open={!!transferTodo}
        todo={transferTodo}
        tables={tables}
        people={people}
        onClose={() => setTransferTodo(null)}
        onDone={() => {
          void loadTodos();
        }}
      />
    </div>
  );
};

export default LogCalendar;
