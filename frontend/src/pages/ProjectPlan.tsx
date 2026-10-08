import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirmDialog } from '../utils/confirm';
import {
  Button, DatePicker, Input, InputNumber, Modal, Select, Space, Table, Tooltip, message,
} from 'antd';
import { ClockCircleOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { DndContext, closestCenter } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Gantt, ITask } from '@svar-ui/react-gantt';
import '@svar-ui/react-gantt/all.css';
import api from '../api';
import { flush } from '../utils/autosave';
import { DragHandle, SortableRow, reorderIds, useDragSensors } from '../utils/dragSort';
import type { Person, ProjectTask, TableMeta } from '../types';

/** 20 色（与人员工作量图同一套调色板，视觉统一） */
const TASK_COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
  '#dcbeff', '#9a6324', '#800000', '#aaffc3', '#808000',
  '#ffd8b1', '#000075', '#e6beff', '#ffb469', '#8a2be2',
];

/** 任务 → 固定颜色
 *  ⚠️ 不能用名字哈希：20 色下很容易撞（实测"需求与设计"和"前端页面"撞成同一个色）。
 *  改成按任务 id 稳定排序后的序号取色 —— 颜色跟任务绑定、不撞色，且拖动排序不变色。
 */
function useTaskColors(rows: ProjectTask[]) {
  return useMemo(() => {
    const sorted = [...rows].map((r) => r.id).sort();
    const map: Record<string, string> = {};
    sorted.forEach((id, i) => {
      map[id] = TASK_COLORS[i % TASK_COLORS.length];
    });
    return map;
  }, [rows]);
}

const STATUS_LABEL: Record<string, string> = {
  not_started: '未开始',
  in_progress: '进行中',
  done: '已完成',
  delayed: '已延迟',
};
const STATUS_COLOR: Record<string, string> = {
  not_started: '#8c8c8c',
  in_progress: '#1f6fb2',
  done: '#217346',
  delayed: '#c0392b',
};

interface Props {
  table: TableMeta;
  people: Person[];
  tables: TableMeta[];
}

function plainDate(s?: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

function toSvarTasks(rows: ProjectTask[], pMap: Record<string, string>): ITask[] {
  const ids = new Set(rows.map((r) => r.id));

  /**
   * 🔴 踩过的坑（2026-10-02 用户在真机上发现「1 天的任务甘特条画不出来」）：
   * SVAR 的 `end` 是**边界**语义，条宽 = end - start（不含 end 当天）。
   * 所以不能直接把 plan_end 当 end 传：
   *   - plan_start = plan_end = 10-02（1 天）时，end - start = 0 → 条宽 0，整条消失
   *   - 多天任务则会每个条都少一天
   * 正确做法：end = start + 天数，其中"天数 = 含首尾两天"。
   */
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
  const spanDays = (a: Date, b: Date) =>
    Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000) + 1);

  return rows.map((t): any => {
    const start = plainDate(t.plan_start) || new Date();
    const planEnd = plainDate(t.plan_end) || start;
    const dur = spanDays(start, planEnd);
    const end = addDays(start, dur); // 边界 = 起点 + 天数（保证宽度 = dur）
    const hasChildren = rows.some((x) => x.parent_id === t.id);
    const task: any = {
      id: t.id,
      text: t.name,
      start,
      end,
      duration: dur,
      progress: t.progress ?? 0,
      type: hasChildren ? ('summary' as const) : ('task' as const),
      parent: t.parent_id && ids.has(t.parent_id) ? t.parent_id : undefined,
      open: hasChildren ? true : undefined,
    };
    const as = plainDate(t.actual_start);
    const ae = plainDate(t.actual_end);
    if (as) {
      task.base_start = as;
      // 同一处坑：baseline 的 end 也要用边界语义
      task.base_end = addDays(as, ae ? spanDays(as, ae) : 1);
    }
    return task;
  });
}

/**
 * 计划表（ProjectPlan）列宽的默认值 + localStorage 键
 * 2026-10-08：原来这份默认值直接写在 useState 里（纯内存）→ 拖过的列宽一刷新就丢，挪到模块作用域以便持久化。
 */
const PP_DEFAULT_COL_W: Record<string, number> = {
  drag: 34, name: 150, plan_start: 96, plan_duration: 56, plan_end: 96,
  actual_start: 96, actual_end: 96, progress: 180, assignee_id: 84,
  points: 56, earned_points: 62, status: 76, op: 92,
};
const PP_COLW_BASE = 'lpm_pp_colw';
const PP_SPLIT_BASE = 'lpm_split_left_w';

/**
 * 🔴 2026-10-08 用户反馈：改了 A 计划的列宽/分栏宽，B 计划也跟着变 —— 要求「每个页面各记各的」。
 *    所以存档键改成 `<base>::<工作表id>::<项目id>`：每个工程、每张工作表各一份。
 *    兼容：新键读不到时**回退读旧的全局键**（之前调过的宽度不会丢），写入只写新键。
 */
const ppPageKey = (base: string, tableId?: string, projectId?: string) =>
  `${base}::${tableId || 'na'}::${projectId || 'na'}`;

function ppReadJson(key: string): any {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

/** 按「工作表 + 项目」读列宽；没有就退回默认值 */
function ppLoadColW(tableId?: string, projectId?: string): Record<string, number> {
  const saved = ppReadJson(ppPageKey(PP_COLW_BASE, tableId, projectId)) ?? ppReadJson(PP_COLW_BASE);
  const merged: Record<string, number> = { ...PP_DEFAULT_COL_W };
  if (saved && typeof saved === 'object') {
    Object.keys(PP_DEFAULT_COL_W).forEach((k) => {
      const v = Number((saved as any)[k]);
      if (Number.isFinite(v) && v >= 48) merged[k] = v;
    });
  }
  return merged;
}

/** 按「工作表 + 项目」读分栏宽（左侧任务列表宽度） */
function ppLoadLeftW(tableId?: string, projectId?: string): number {
  const raw =
    localStorage.getItem(ppPageKey(PP_SPLIT_BASE, tableId, projectId)) ??
    localStorage.getItem(PP_SPLIT_BASE);
  const v = Number(raw);
  return Number.isFinite(v) && v >= 240 ? v : 560;
}

/**
 * 可拖动列宽的表头单元格（自写，不引第三方库）
 * ⚠️ 列宽写死在各列 width 上，**不随容器/页面宽度自动变化** ——
 *    表格总宽超出左边区域时由底部横滚条滚动（用户 2026-10-03 明确要求）。
 */
const ResizableTitle: React.FC<any> = (props) => {
  const { onResize, colKey, width, children, className, ...rest } = props;
  if (!width) return <th {...rest} className={className}>{children}</th>;
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = Number(width);
    const move = (ev: MouseEvent) => onResize?.(colKey, w0 + (ev.clientX - x0));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  return (
    <th {...rest} className={className}>
      {children}
      <span className="lpm-col-resizer" onMouseDown={startDrag} title="拖动调节列宽" />
    </th>
  );
};

const ProjectPlan: React.FC<Props> = ({ table, people }) => {
  const [projectId, setProjectId] = useState<string>('');
  const [rows, setRows] = useState<ProjectTask[]>([]);
  // ── 进度滑块「已落库的真值」────────────────────────────────
  // 为什么需要它：滑块的 onChange 会**先**把本地 rows 改成新值，
  // 等 onMouseUp 触发时拿到的 r.progress 已经是新值了 ——
  // 用 r.progress 当「原值」会永远判成"没变"，0/100 的弹窗就永远弹不出来。
  // 所以单独记一份「上一次从后端读到的（或已保存成功的）进度」。
  const committedProgress = useRef<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ProjectTask | null>(null);
  const [form, setForm] = useState<any>({});
  const [delayOpen, setDelayOpen] = useState(false);
  const [delayTarget, setDelayTarget] = useState<ProjectTask | null>(null);
  const [delayForm, setDelayForm] = useState<any>({});
  /**
   * 分栏宽度（左侧任务列表 px）
   * 🔴 2026-10-05 修复（用户反馈：拖了甘特图/列表的分栏宽度，切到别的页面就变回默认）
   *   原来 leftW 硬初始化 560、纯内存状态 → 切表/刷新即丢。
   *   现在：初值从 localStorage 读，变化即写回，拖过的宽度能记住。
   */
  const [leftW, setLeftW] = useState<number>(560);
  /**
   * 列宽（鼠标拖表头右边缘调整）
   * 🔴 每列都必须有**显式** width：以前「任务名称」列不设宽度 → AntD 让它吃剩余空间，
   *    于是窗口一宽列就变宽、一窄就变窄（用户 2026-10-03：「列宽是随着页面占比变化的，不合适」）。
   *    现在全部写死 + 表头可拖；总宽超出左边区域就用底部横滚条滚。
   * 🔴 2026-10-08 用户反馈修：「我调了任务名称 / 人员这些列的宽度，一刷新就变回默认了」。
   *    原来 colW 是纯内存 state（初值写死）→ 刷新 / 切表即丢；
   *    现在初值从 localStorage 读（与默认值逐列合并，旧数据缺列也不会崩），变化即写回。
   */
  const [colW, setColW] = useState<Record<string, number>>(() => ({ ...PP_DEFAULT_COL_W }));

  /** 每页独立：工作表 / 项目一变，就把这一页各自的列宽与分栏宽读回来 */
  useEffect(() => {
    setColW(ppLoadColW(table.id, projectId));
    setLeftW(ppLoadLeftW(table.id, projectId));
  }, [table.id, projectId]);

  const onResizeCol = useCallback(
    (key: string, w: number) => {
      setColW((p) => {
        const next = { ...p, [key]: Math.max(48, Math.round(w)) };
        try {
          localStorage.setItem(ppPageKey(PP_COLW_BASE, table.id, projectId), JSON.stringify(next));
        } catch {
          /* 写不了就算了，不影响功能 */
        }
        return next;
      });
    },
    [table.id, projectId],
  );
  const totalColW = Object.values(colW).reduce((a, b) => a + b, 0);
  /** 拖动分栏结束后 +1 → 甘特图按新宽度重挂载（否则容器压窄后图表区不收缩、被裁成空白） */
  const [ganttTick, setGanttTick] = useState(0);
  /** 新增/编辑成功后高亮的那一行（给用户"真的加进去了"的反馈） */
  const [highlightId, setHighlightId] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const sensors = useDragSensors();

  const pMap = useMemo(() => Object.fromEntries(people.map((p) => [p.id, p.name])), [people]);
  /** 任务 id → 固定颜色（不撞色、拖动排序不变色）*/
  const colorMap = useTaskColors(rows);

  /**
   * 🔴 2026-10-05 修复（用户反馈：甘特图能折叠，任务列表却看不出子任务、也不能折叠）
   *   原来列表只给子任务加了个「└」前缀，既没有缩进、也没有折叠控件。
   *   这里补两件事：
   *     ① 按 parent_id 计算层级 → 名称列按层缩进（每层 18px）；
   *     ② 有子任务的行显示 ▾/▸ 三角，点击折叠/展开（折叠时其后代行不渲染）。
   */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const visibleRows = React.useMemo(() => {
    type Row = ProjectTask & { __depth: number; __hasChildren: boolean };
    const byParent = new Map<string, ProjectTask[]>();
    rows.forEach((r) => {
      const k = r.parent_id || '';
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k)!.push(r);
    });
    const out: Row[] = [];
    /** 被"处理过"的 id：包含因折叠而未显示的后代。
     *  ⚠️ 必须区分「折叠隐藏」和「真孤儿」——第一版没区分，导致折叠起来的子任务
     *     被下面的孤儿兜底逻辑又追加到列表末尾（用户实测：折叠后子任务跑到底下去了）。 */
    const walked = new Set<string>();
    const markSubtree = (pid: string) => {
      (byParent.get(pid) || []).forEach((k) => {
        if (walked.has(k.id)) return;
        walked.add(k.id);
        markSubtree(k.id);
      });
    };
    const walk = (pid: string, depth: number) => {
      (byParent.get(pid) || []).forEach((r) => {
        walked.add(r.id);
        const kids = byParent.get(r.id) || [];
        out.push({ ...r, __depth: depth, __hasChildren: kids.length > 0 });
        if (kids.length === 0) return;
        if (collapsed.has(r.id)) markSubtree(r.id);   // 折叠：后代整体标记为已处理，不再显示
        else walk(r.id, depth + 1);
      });
    };
    walk('', 0);
    // 兜底：只有「父任务不在本表里」的真孤儿才追加显示，别让它们凭空消失
    rows.forEach((r) => {
      if (!walked.has(r.id)) out.push({ ...r, __depth: 0, __hasChildren: false });
    });
    return out;
  }, [rows, collapsed]);

  // ── 找到本工作表对应的项目 ──────────────────────────────
  useEffect(() => {
    try {
      const cfg = JSON.parse(table.config || '{}');
      if (cfg.project_id) {
        setProjectId(cfg.project_id);
        return;
      }
    } catch {}
    api.get('/projects', { params: { table_id: table.id } }).then((r) => {
      const list = r.data.projects || [];
      if (list.length) setProjectId(list[0].id);
    });
  }, [table.id, table.config]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const r = await api.get('/projects/' + projectId + '/tasks');
      const list: ProjectTask[] = r.data.tasks || [];
      list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      setRows(list);
      // 记录「已落库的真值」，供进度滑块判断本次拖动是否真的变成了 0 或 100
      const cm: Record<string, number> = {};
      list.forEach((t) => {
        cm[t.id] = Number(t.progress) || 0;
      });
      committedProgress.current = cm;
    } catch (e: any) {
      message.error('任务加载失败：' + (e?.friendlyMessage || ''));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── 拖动分栏 ─────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !wrapRef.current) return;
      const rect = wrapRef.current.getBoundingClientRect();
      const w = e.clientX - rect.left;
      // 甘特图区至少留 400px（首列 170 + 时间轴），否则压到最后只剩首列、时间轴没地方显示
      setLeftW(Math.max(240, Math.min(w, rect.width - 400)));
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // 分栏宽度变了 → 让甘特图按新宽度重排一次
      setGanttTick((t) => t + 1);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  /* 🔴 2026-10-05 分栏宽度持久化；🔴 2026-10-08 改成「每个工程 + 每张工作表」各记各的 */
  useEffect(() => {
    try {
      const page = ppPageKey(PP_SPLIT_BASE, table.id, projectId);
      const w = String(Math.round(leftW));
      // 还没拖过、也没有这一页的存档 → 不要把默认值写进去（免得盖掉别的页）
      if (w === '560' && !localStorage.getItem(page)) return;
      localStorage.setItem(page, w);
    } catch {
      /* 忽略隐私模式限制 */
    }
  }, [leftW, table.id, projectId]);

  // ── 甘特图进度样式注入（照任务公会做法）────────────────────
  //   浅灰底 + 每任务固定艳色按进度填充 + 条尾百分比数字
  useEffect(() => {
    const rules: string[] = [];

    // 折叠图标：SVAR 字体来自 cdn.svar.dev 国内加载失败 → 用 CSS 三角
    rules.push('.wx-toggle-icon{width:12px !important;height:14px !important;margin:0 2px !important;color:transparent !important;font-size:0 !important;position:relative;}');
    rules.push('.wx-toggle-icon::before{content:"";position:absolute;top:50%;left:50%;width:0;height:0;border:4px solid transparent;}');
    rules.push('.wxi-menu-down::before{margin-top:-1px;margin-left:-4px;border-top-color:#000;border-top-width:5px;}');
    rules.push('.wxi-menu-right::before{margin-top:-4px;margin-left:-1px;border-left-color:#000;border-left-width:5px;}');

    // 子任务缩进
    rules.push('.wx-content[style*="padding-left: 20px"]{padding-left:10px !important}');
    rules.push('.wx-content[style*="padding-left: 40px"]{padding-left:20px !important}');
    rules.push('.wx-content[style*="padding-left: 60px"]{padding-left:30px !important}');

    // 今天列高亮（2026-10-06 V30：浅黄 + 整列；整列的背景竖条在 init 里插到 .wx-area）
    rules.push('.wx-gantt .wx-scale .wx-today{background-color:#fff9c4 !important;}');
    // 背景竖条：z-index:0 → 永远在横条（.wx-bar / .wx-baseline）之下，绝不遮挡
    rules.push('.wx-gantt .gantt-today-column{z-index:0 !important;pointer-events:none !important;}');

    // 横条：去蓝边、禁拖拽（技能 #11：pointer-events:none，点击走 select-task）
    // 🔴 2026-10-05 V21 横条必须补偿「居中偏移」（用户原话：甘特图那个横线要居中，有点审美）
    //   实测：SVAR 给横条预留的"槽"高 = cellHeight - 7，并按该槽做垂直居中；
    //   而我们把可视高度压成 11px → 它就贴在槽的上沿，实测偏移 -13px（cellHeight=44 时）。
    //   补偿量 = (cellHeight - 7 - 11) / 2 = (cellHeight - 18) / 2；cellHeight=30 → 6px。
    //   ⚠️ 改 cellHeight 必须同步改这个 margin-top，否则又不居中。
    rules.push('.wx-gantt .wx-bar{pointer-events:none !important;border-color:transparent !important;outline:none !important;font-size:10px !important;height:11px !important;line-height:11px !important;min-height:0 !important;max-height:11px !important;margin-top:6px !important;}');
    rules.push('.wx-gantt .wx-baseline{pointer-events:none !important;z-index:0 !important;background-color:rgba(59,130,246,0.35) !important;border-radius:2px;}');

    // 🔴 「把甘特图区调小后右边一大片空白」的真根因（2026-10-03 用 Profiler + 调用栈定位）：
    //    .wx-content（图表区容器）是 flex item，容器变窄时被压成 **0 宽**（实测 gantt=622 时 chart=0，
    //    818 时才恢复 643）—— 不是没渲染，是被压没了。
    //    修法：**只**让 .wx-content 不参与 flex 压缩，图表区就能保住宽度。
    //
    // ⚠️⚠️ 千万不要给 `.wx-chart` 加 `flex-shrink:0`！踩过：
    //    SVAR 的网格背景组件在 **每次 render** 里同步调 `IHe()` → `canvas.toDataURL()`
    //    现场画一张网格 PNG 当 background（本该缓存，是它自己的性能缺陷）。
    //    给 .wx-chart 加 flex-shrink:0 会让它内部尺寸检测一直"对不上"→ 反复重渲染
    //    → **实测 5 秒调用 toDataURL 596 次、项目计划页主线程占用 61%**（页面卡成幻灯片）。
    //    加在 .wx-content 上则实测 0%，且图表区宽度正常恢复。
    rules.push('.wx-gantt .wx-content{flex-shrink:0 !important;}');

    // 每个任务：底色浅灰 + 填充色 = 该任务固定色 + 条尾百分比数字
    // 🔴 2026-10-05 修复「0% 的任务在甘特图上看不见横条」（用户报：1234/345/890 没有横条）
    //   原来任务条底色写死 #d0d0d0 浅灰，和表格网格底色几乎一模一样；
    //   进展 0% 时条上只剩这层灰 → 肉眼看着就是"没画横条"。
    //   改成「任务色 + 透明度」的浅色底，再加 1px 内描边 + 最小宽度，
    //   这样任何进展（哪怕 0%、哪怕只有 1 天 18px）都能一眼看出是个条。
    const tint = (hex: string, a: number) => {
      const h = hex.replace('#', '');
      const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      const r = parseInt(n.slice(0, 2), 16);
      const g = parseInt(n.slice(2, 4), 16);
      const bl = parseInt(n.slice(4, 6), 16);
      return 'rgba(' + r + ',' + g + ',' + bl + ',' + a + ')';
    };
    // ⚠️ 2026-10-05 事故复盘：不要给 .wx-bar / .wx-summary 加 min-width！
    //    V16 加了 min-width:6px，会改变条的布局宽度 → 触发甘特图内部 ResizeObserver
    //    反复重算（resize → 重设宽度 → 又被 min-width 改回），实测把整个页面卡死。
    //    需要描边时用 outline（不参与布局、不触发 resize），不要用 border/box-shadow+尺寸。
    rules.push('.wx-gantt .wx-bar{outline:1px solid rgba(0,0,0,0.18) !important;outline-offset:-1px !important;}');
    rules.push('.wx-gantt .wx-summary{outline:1px solid rgba(0,0,0,0.18) !important;outline-offset:-1px !important;}');

    for (const t of rows) {
      const base = colorMap[t.id] || TASK_COLORS[0];
      const pct = t.progress ?? 0;
      const tid = ':'.concat(t.id);
      rules.push('.wx-gantt [data-task-id="' + tid + '"]{--wx-gantt-task-color:' + tint(base, 0.34) + ';--wx-gantt-task-fill-color:' + base + ';}');
      rules.push('.wx-gantt [data-task-id="' + tid + '"] .wx-progress-percent{background:' + base + ' !important;}');
      // 🔴 .wx-bar 与 [data-task-id] 是同一个元素（技能 #6a），必须写在同一选择器上，
      //    写成 `[data-task-id] .wx-bar::after` 永远匹配不到（真踩过：content 一直是 none）
      rules.push('.wx-gantt .wx-bar[data-task-id="' + tid + '"]::after{content:"' + pct + '%";position:absolute;right:3px;top:50%;transform:translateY(-50%);font-size:9px;font-weight:700;color:rgba(0,0,0,0.62);white-space:nowrap;pointer-events:none;z-index:2;}');
      // 父任务（summary）不响应 CSS 变量，单独设底色
      if (rows.some((x) => x.parent_id === t.id)) {
        rules.push('.wx-gantt .wx-summary[data-task-id="' + tid + '"]{background-color:' + tint(base, 0.55) + ' !important;}');
      }
    }

    const el = document.createElement('style');
    el.setAttribute('data-lpm-gantt', '1');
    // ⚠️ 必须先把所有规则 push 完，再一次性 textContent（反之规则永远进不了 DOM）
    el.textContent = rules.join('\n');
    document.head.appendChild(el);
    return () => {
      el.remove();
    };
  }, [rows, colorMap]);

  // ── 滚轮左右滑动（任务表 / 甘特图通用）────────────────────
  const onWheelScroll = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth) return;
    // shift+滚轮 = 原生横向；普通滚轮且页面没有纵向可滚时，转成横向
    const canScrollY = el.scrollHeight > el.clientHeight + 2;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || !canScrollY) {
      el.scrollLeft += e.deltaY + e.deltaX;
      e.preventDefault();
    }
  };

  // ── 拖动排序 ─────────────────────────────────────────────
  // 🔴 2026-10-05 用户要求：只能在「同一层级」内上下调顺序，不能挪出父任务、不能靠拖拽换父级。
  //   原实现是对整张表做扁平排序 → 子任务能被拖到别的父任务下面，甚至拖成顶层任务。
  //   现在：先比较 active / over 的 parent_id，不同就直接拒绝并提示（dnd-kit 会自动弹回原位）；
  //        相同则只重排这一个兄弟组，其它任务位置不动。
  const onDragEnd = async (e: DragEndEvent) => {
    // ⚠️ 2026-10-05：整段包 try/catch —— 拖拽回调里任何异常都可能让 dnd-kit
    //    的拖拽状态清理不掉，表现为「页面卡死、点什么都没反应」（用户实测过）。
    try {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const aid = String(active.id);
      const oid = String(over.id);
      const a = rows.find((r) => r.id === aid);
      const o = rows.find((r) => r.id === oid);
      if (!a || !o) return;
      const pa = a.parent_id ?? null;
      const po = o.parent_id ?? null;
      if (pa !== po) {
        message.warning('只能在同一层级里调整顺序（不能挪出父任务）');
        return; // 不改数据 → 列表自动弹回原位
      }
      const siblings = rows.filter((r) => (r.parent_id ?? null) === pa);
      const next = reorderIds(siblings.map((r) => r.id), e);
      if (!next) return;
      const orderMap: Record<string, number> = {};
      next.forEach((id, i) => { orderMap[id] = i; });
      const reordered = [...siblings]
        .sort((x, y) => (orderMap[x.id] ?? 0) - (orderMap[y.id] ?? 0));
      if (reordered.length !== siblings.length) return; // 长度异常直接放弃，别把数据搞坏
      let k = 0;
      const newRows = rows.map((r) => ((r.parent_id ?? null) === pa ? reordered[k++] : r));
      if (newRows.some((r) => !r)) return;             // 兜底：绝不让 undefined 进 rows
      setRows(newRows); // 先本地生效，手感不卡
      try {
        await api.patch('/project-tasks/reorder', { ordered_ids: newRows.map((r) => r.id) });
        message.success('顺序已保存');
      } catch (err: any) {
        message.error(err?.friendlyMessage || '排序保存失败');
        await load();
      }
    } catch (err: any) {
      // 出错也不能让拖拽卡住：吞掉异常，重新拉一次数据回到一致状态
      console.error('[LPM] onDragEnd 出错:', err);
      try { await load(); } catch { /* ignore */ }
    }
  };

  // ── 增删改 ────────────────────────────────────────────────
  const openNew = () => {
    setEditTarget(null);
    setForm({
      name: '',
      plan_start: dayjs().format('YYYY-MM-DD'),
      plan_duration: 3,
      assignee_id: undefined,
      points: 10,
      progress: 0,
      parent_id: undefined,
      note: '',
    });
    setEditOpen(true);
  };

  const openEdit = (t: ProjectTask) => {
    setEditTarget(t);
    setForm({
      name: t.name,
      plan_start: t.plan_start || '',
      plan_duration: t.plan_duration || 1,
      assignee_id: t.assignee_id || undefined,
      points: t.points,
      progress: t.progress,
      parent_id: t.parent_id || undefined,
      note: t.note || '',
    });
    setEditOpen(true);
  };

  const saveEdit = async () => {
    if (!form.name?.trim()) return message.warning('请填写任务名');
    const nm = form.name.trim();
    try {
      let savedId = '';
      if (editTarget) {
        await api.patch('/project-tasks/' + editTarget.id, {
          name: nm,
          plan_start: form.plan_start || null,
          plan_duration: Number(form.plan_duration) || 1,
          assignee_id: form.assignee_id || null,
          points: Number(form.points) || 0,
          progress: Number(form.progress) || 0,
          parent_id: form.parent_id || null,
          note: form.note || null,
        });
        savedId = editTarget.id;
      } else {
        const r = await api.post('/projects/' + projectId + '/tasks', {
          name: nm,
          plan_start: form.plan_start || null,
          plan_duration: Number(form.plan_duration) || 1,
          assignee_id: form.assignee_id || null,
          points: Number(form.points) || 0,
          progress: Number(form.progress) || 0,
          parent_id: form.parent_id || null,
          note: form.note || null,
        });
        savedId = r?.data?.id || '';
      }

      /**
       * 🔴 用户反馈「点了新增任务没反应」的根因就在这里：
       *   保存成功但弹窗不关、新行在列表末尾不滚动不高亮、没有提示 →
       *   看着就像没生效。现在：关弹窗 + 明确提示 + 新行高亮并滚到可见。
       */
      setEditOpen(false);
      await load();
      message.success(editTarget ? `已保存「${nm}」` : `已新增任务「${nm}」`);
      if (savedId) {
        setHighlightId(savedId);
        window.setTimeout(() => {
          const el = document.querySelector(`tr[data-row-key="${savedId}"]`);
          if (el && (el as HTMLElement).scrollIntoView) {
            (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        }, 350);
        window.setTimeout(() => setHighlightId(''), 2800);
      }
    } catch (e: any) {
      message.error(e?.friendlyMessage || '保存失败');
    }
  };

  /** 把滑块弹回某个值（取消时用） */
  const revertProgress = (id: string, value: number) =>
    setRows((prev) => prev.map((x) => (x.id === id ? { ...x, progress: value } : x)));

  /** 真正落库 */
  const applyProgress = async (t: ProjectTask, progress: number) => {
    try {
      await api.patch(`/project-tasks/${t.id}/progress`, { progress });
      await load();
    } catch (e: any) {
      message.error(e?.friendlyMessage || '进度保存失败');
      await load();
    }
  };

  /**
   * 进度提交（用户 2026-10-06 要求）：
   *   调到 0   → 就是「没有开始」，实际开始时间清空（显示 —）
   *   调到 100 → 就是「已完成」，实际结束时间记今天
   *   这两个值影响实际时间，**必须弹窗二次确认**；中间值直接存、不打扰。
   */
  const commitProgress = async (t: ProjectTask, progress: number) => {
    const prev = committedProgress.current[t.id];
    const base = prev === undefined ? Number(t.progress) || 0 : prev;

    // 没真变（拖回原位）：把滑块摆正就行，不弹窗
    if (progress === base) {
      revertProgress(t.id, base);
      return;
    }

    if (progress === 0 || progress === 100) {
      const isZero = progress === 0;
      confirmDialog({
        title: isZero ? '改为「未开始」' : '标记为「已完成」',
        danger: isZero,
        okText: isZero ? '确认清零' : '确认完成',
        content: isZero
          ? `「${t.name}」的进度将调到 0%。\n\n实际开始时间会被清空（列表里显示 —）。`
          : `「${t.name}」的进度将调到 100%。\n\n实际结束时间记为今天（${dayjs().format('YYYY-MM-DD')}）；已得积分按 100% 结算。`,
        onOk: async () => {
          await applyProgress(t, progress);
        },
        onCancel: () => revertProgress(t.id, base),
      });
      return;
    }

    await applyProgress(t, progress);
  };

  const delTask = (t: ProjectTask) => {
    confirmDialog({
      title: '删除任务',
      content: `确定删除「${t.name}」？子任务会一并删除（软删除，可导出找回）。`,
      okText: '删除',
      danger: true,
      onOk: async () => {
        await api.delete('/project-tasks/' + t.id);
        await load();
        message.success('已删除');
      },
    });
  };

  const openDelay = (t: ProjectTask) => {
    setDelayTarget(t);
    setDelayForm({ plan_start: t.plan_start || dayjs().format('YYYY-MM-DD'), plan_duration: t.plan_duration || 1, note: t.note || '' });
    setDelayOpen(true);
  };

  const saveDelay = async () => {
    if (!delayTarget) return;
    try {
      await api.patch(`/project-tasks/${delayTarget.id}/delay`, {
        plan_start: delayForm.plan_start,
        plan_duration: Number(delayForm.plan_duration) || 1,
        note: delayForm.note || null,
      });
      setDelayOpen(false);
      await load();
      message.success('已推迟');
    } catch (e: any) {
      message.error(e?.friendlyMessage || '推迟失败');
    }
  };

  const svarTasks = useMemo(() => toSvarTasks(rows, pMap), [rows, pMap]);
  const ganttStart = useMemo(() => {
    const ts = rows.map((r) => plainDate(r.plan_start)).filter(Boolean) as Date[];
    if (!ts.length) return undefined;
    return new Date(Math.min(...ts.map((d) => d.getTime())));
  }, [rows]);

  /** 表头 cell 注入「列宽可拖」能力（必须显式把 width 传进表头组件，AntD 默认不传） */
  const hdr = (key: string) => () => ({ colKey: key, width: colW[key], onResize: onResizeCol });

  const columns: any[] = [
    {
      title: '',
      dataIndex: '__drag',
      width: colW.drag,
      align: 'center',
      // 🔴 2026-10-05：原为 fixed:'left'。Chromium 84（用户那台 Edge 84）对
      //    table-cell 的 position:sticky 渲染有缺陷 → 表头被重复绘制成两行。
      //    去掉固定列即消失；同时符合用户"不要锁定列、要随横滚"的要求。
      onHeaderCell: hdr('drag'),
      render: () => <DragHandle />,
    },
    {
      title: '任务名称',
      dataIndex: 'name',
      width: colW.name,
      ellipsis: true,
      // 🔴 2026-10-05：同上一处，去掉 fixed:'left' 修复老 Chromium 表头双绘
      onHeaderCell: hdr('name'),
      render: (v: string, r: ProjectTask & { __depth?: number; __hasChildren?: boolean }) => (
        <Tooltip title={`${r.__depth ? '子任务 · ' : ''}${v}（点击编辑）`} mouseEnterDelay={0.4}>
          <span
            style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', maxWidth: '100%',
                     paddingLeft: (r.__depth || 0) * 18, color: r.__depth ? '#555' : '#111' }}
            onClick={() => openEdit(r)}
          >
            {/* 折叠三角：只有带子任务的行才有（2026-10-05 新增） */}
            {r.__hasChildren ? (
              <span
                onClick={(e) => { e.stopPropagation(); toggleCollapse(r.id); }}
                style={{ width: 14, textAlign: 'center', color: '#666', userSelect: 'none', marginRight: 1 }}
                title={collapsed.has(r.id) ? '展开子任务' : '折叠子任务'}
              >
                {collapsed.has(r.id) ? '▸' : '▾'}
              </span>
            ) : (
              <span style={{ width: 14, display: 'inline-block', marginRight: 1 }} />
            )}
            <span style={{ flex: '0 0 8px', width: 8, height: 8, borderRadius: 2, background: colorMap[r.id] || TASK_COLORS[0], marginRight: 5 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
          </span>
        </Tooltip>
      ),
    },
    { title: '计划开始', dataIndex: 'plan_start', width: colW.plan_start, onHeaderCell: hdr('plan_start'), render: (v) => v || '—' },
    { title: '时长', dataIndex: 'plan_duration', width: colW.plan_duration, onHeaderCell: hdr('plan_duration'), render: (v) => `${v}天` },
    { title: '计划结束', dataIndex: 'plan_end', width: colW.plan_end, onHeaderCell: hdr('plan_end'), render: (v) => v || '—' },
    { title: '实际开始', dataIndex: 'actual_start', width: colW.actual_start, onHeaderCell: hdr('actual_start'), render: (v) => v || '—' },
    { title: '实际结束', dataIndex: 'actual_end', width: colW.actual_end, onHeaderCell: hdr('actual_end'), render: (v) => v || '—' },
    {
      title: '进展',
      dataIndex: 'progress',
      width: colW.progress,
      onHeaderCell: hdr('progress'),
      render: (_: any, r: ProjectTask) => (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={r.progress || 0}
            onChange={(e) => setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, progress: Number(e.target.value) } : x)))}
            onMouseUp={(e) => commitProgress(r, Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) => commitProgress(r, Number((e.target as HTMLInputElement).value))}
            className="lpm-progress-range"
            style={{ flex: 1, minWidth: 60 }}
          />
          <span style={{ width: 34, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#555' }}>{r.progress || 0}%</span>
        </span>
      ),
    },
    { title: '负责人', dataIndex: 'assignee_id', width: colW.assignee_id, ellipsis: true, onHeaderCell: hdr('assignee_id'), render: (v) => (v ? pMap[v] || '（已删）' : '—') },
    { title: '积分', dataIndex: 'points', width: colW.points, align: 'right', onHeaderCell: hdr('points') },
    { title: '已得', dataIndex: 'earned_points', width: colW.earned_points, align: 'right', onHeaderCell: hdr('earned_points') },
    {
      title: '状态',
      dataIndex: 'status',
      width: colW.status,
      onHeaderCell: hdr('status'),
      render: (v) => <span style={{ color: STATUS_COLOR[v] || '#666' }}>{STATUS_LABEL[v] || v}</span>,
    },
    {
      title: '操作',
      width: colW.op,
      align: 'center',
      onHeaderCell: hdr('op'),
      // 🔴 用户 2026-10-03：不要固定在右侧（「为什么还是锁定的，不会随着横滚」）→ 随表格一起横滚
      render: (_: any, r: ProjectTask) => (
        <span style={{ display: 'inline-flex', gap: 4, whiteSpace: 'nowrap' }}>
          <Tooltip title="推迟任务（改计划时间）">
            <Button size="small" icon={<ClockCircleOutlined />} onClick={() => openDelay(r)} />
          </Tooltip>
          <Tooltip title="删除任务（软删除，可导出找回）">
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => delTask(r)} />
          </Tooltip>
        </span>
      ),
    },
  ];

  if (!projectId) {
    return <div className="lpm-empty">正在初始化项目…</div>;
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="lpm-cal-head">
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openNew}>
          新增任务
        </Button>
        <Button size="small" onClick={() => void load()}>
          刷新
        </Button>
        <span style={{ color: '#666', marginLeft: 6 }}>
          共 {rows.length} 个任务 · 总积分 {rows.reduce((s, r) => s + (r.points || 0), 0)} · 已得{' '}
          {Math.round(rows.reduce((s, r) => s + (r.earned_points || 0), 0) * 100) / 100}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ color: '#999', fontSize: 11.5 }}>
          拖任务行可排序 · 滚轮左右滑 · 中间竖条调宽度
        </span>
      </div>

      <div className="lpm-split" ref={wrapRef} style={{ flex: 1, minHeight: 0 }}>
        {/* 左：任务列表（可横向滚动 + 可拖动排序）*/}
        <div className="lpm-split-left" style={{ flex: `0 0 ${leftW}px`, display: 'flex', flexDirection: 'column' }}>
          <div
            ref={tableWrapRef}
            className="lpm-scroll-x"
            onWheel={onWheelScroll}
            style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
          >
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={visibleRows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
                <Table
                  size="small"
                  rowKey="id"
                  className="lpm-draggable"
                  loading={loading}
                  dataSource={visibleRows}
                  pagination={false}
                  tableLayout="fixed"
                  rowClassName={(r: any) => (r.id === highlightId ? 'lpm-row-flash' : '')}
                  components={{ body: { row: SortableRow }, header: { cell: ResizableTitle } }}
                  scroll={{ x: totalColW }}
                  columns={columns}
                />
              </SortableContext>
            </DndContext>
          </div>
        </div>

        {/* 中：拖动条 */}
        <div
          className="lpm-split-bar"
          onMouseDown={() => {
            dragging.current = true;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          }}
        />

        {/* 右：甘特图（滚轮可左右滑）*/}
        <div className="lpm-split-right" style={{ display: 'flex', flexDirection: 'column' }}>
          {rows.length === 0 ? (
            <div className="lpm-empty">甘特图（先添加任务）</div>
          ) : (
            <div
              className="wx-material-theme lpm-scroll-x"
              onWheel={onWheelScroll}
              style={{ minWidth: 0, padding: 8, overflow: 'auto', height: '100%' }}
            >
              <Gantt
                key={`${projectId}-${rows.length}-${ganttTick}`}
                tasks={svarTasks}
                links={[]}
                start={ganttStart}
                scales={[
                  { unit: 'month', step: 1, format: '%m月' },
                  {
                    unit: 'day', step: 1, format: '%d',
                    // 🔴 禁用 toISOString 比较（UTC+8 会错一天，技能 #8a 踩过）→ 只用本地 getFullYear/Month/Date
                    css: (date: Date) => {
                      const t = new Date();
                      return date.getFullYear() === t.getFullYear() &&
                        date.getMonth() === t.getMonth() &&
                        date.getDate() === t.getDate() ? 'wx-today' : '';
                    },
                  },
                ]}
                columns={[{ id: 'text', header: '任务', width: 170 }]}
                cellHeight={30}
                scaleHeight={24}
                gridWidth={170}
                cellWidth={18}
                zoom={false}
                baselines={true}
                init={(api: any) => {
                  api.on('select-task', (e: any) => {
                    const id = e?.id || e?.task?.id;
                    const hit = rows.find((r) => r.id === id);
                    if (hit) openEdit(hit);
                  });
                  // 今天列高亮：整列（顶部刻度 + 下方图表区背景竖条）
                  // ⚠️ 竖条插在 .wx-area 最前面 + z-index:0 + pointer-events:none → 只在背景，不遮挡横条
                  api.on('render-data', () => {
                    setTimeout(() => {
                      const gantt = document.querySelector('.wx-gantt') as HTMLElement | null;
                      if (!gantt) return;
                      // 防重复堆积：先清旧的
                      gantt.querySelectorAll('.gantt-today-column').forEach((n) => n.remove());
                      const todayCells = gantt.querySelectorAll('.wx-scale .wx-row .wx-today');
                      const area = gantt.querySelector('.wx-area') as HTMLElement | null;
                      if (!area || todayCells.length === 0) return;
                      const cell0 = todayCells[0] as HTMLElement;
                      // 同列所有刻度行一起染色（月行 + 日行）
                      const row0 = cell0.parentElement as HTMLElement | null;
                      if (row0) {
                        const idx = Array.prototype.indexOf.call(row0.children, cell0);
                        if (idx >= 0) {
                          gantt.querySelectorAll('.wx-scale .wx-row').forEach((r: any) => {
                            const c = r.children[idx] as HTMLElement | undefined;
                            if (c) c.style.backgroundColor = '#fff9c4';
                          });
                        }
                      }
                      // 背景竖条：用实测 rect 算偏移，不硬算 cellWidth
                      const areaRect = area.getBoundingClientRect();
                      const cellRect = cell0.getBoundingClientRect();
                      const left = Math.round(cellRect.left - areaRect.left);
                      const width = Math.round(cellRect.width);
                      const strip = document.createElement('div');
                      strip.className = 'gantt-today-column';
                      strip.style.cssText = 'position:absolute;left:' + left + 'px;top:0;width:' + width + 'px;height:100%;background:#fff9c4;z-index:0;pointer-events:none;';
                      area.style.position = 'relative';
                      area.insertBefore(strip, area.firstChild);
                    }, 60);
                  });
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* 编辑/新增弹窗 */}
      <Modal
        title={editTarget ? '编辑任务' : '新增任务'}
        open={editOpen}
        onOk={saveEdit}
        onCancel={() => setEditOpen(false)}
        okText="保存"
        width={480}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input placeholder="任务名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <div style={{ display: 'flex', gap: 8 }}>
            <DatePicker
              style={{ flex: 1 }}
              placeholder="计划开始"
              value={form.plan_start ? dayjs(form.plan_start) : null}
              onChange={(d) => setForm({ ...form, plan_start: d ? d.format('YYYY-MM-DD') : '' })}
            />
            <InputNumber
              style={{ width: 110 }}
              min={1}
              placeholder="时长(天)"
              value={form.plan_duration}
              onChange={(v) => setForm({ ...form, plan_duration: v })}
              addonAfter="天"
            />
          </div>
          <div style={{ fontSize: 12, color: '#888' }}>
            计划结束自动算：
            {form.plan_start
              ? dayjs(form.plan_start).add(Math.max(0, (Number(form.plan_duration) || 1) - 1), 'day').format('YYYY-MM-DD')
              : '—'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Select
              style={{ flex: 1 }}
              allowClear
              placeholder="负责人"
              value={form.assignee_id}
              onChange={(v) => setForm({ ...form, assignee_id: v })}
              options={people.map((p) => ({ value: p.id, label: p.name }))}
            />
            <InputNumber
              style={{ width: 110 }}
              min={0}
              placeholder="总积分"
              value={form.points}
              onChange={(v) => setForm({ ...form, points: v })}
              addonAfter="分"
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <InputNumber
              style={{ width: 140 }}
              min={0}
              max={100}
              placeholder="进展 %"
              value={form.progress}
              onChange={(v) => setForm({ ...form, progress: v })}
              addonAfter="%"
            />
            <Select
              style={{ flex: 1 }}
              allowClear
              placeholder="父任务（可选）"
              value={form.parent_id}
              onChange={(v) => setForm({ ...form, parent_id: v })}
              options={rows.filter((r) => !editTarget || r.id !== editTarget.id).map((r) => ({ value: r.id, label: r.name }))}
            />
          </div>
          <Input.TextArea rows={2} placeholder="备注（可选）" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          {(Number(form.points) > 0 || Number(form.progress) > 0) && (
            <div style={{ fontSize: 12, color: '#217346' }}>
              按「总积分 × 完成百分比」预计可得：
              {Math.round(((Number(form.points) || 0) * (Number(form.progress) || 0)) / 100 * 100) / 100} 分
            </div>
          )}
        </Space>
      </Modal>

      {/* 推迟弹窗 */}
      <Modal title="推迟任务" open={delayOpen} onOk={saveDelay} onCancel={() => setDelayOpen(false)} okText="确认推迟" width={440}>
        <div style={{ marginBottom: 8 }}>
          任务：<b>{delayTarget?.name}</b>
          {delayTarget?.plan_start && (
            <span style={{ color: '#888', marginLeft: 8 }}>
              原计划 {delayTarget.plan_start} ~ {delayTarget.plan_end}
            </span>
          )}
        </div>
        <Space direction="vertical" style={{ width: '100%' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <DatePicker
              style={{ flex: 1 }}
              value={delayForm.plan_start ? dayjs(delayForm.plan_start) : null}
              onChange={(d) => setDelayForm({ ...delayForm, plan_start: d ? d.format('YYYY-MM-DD') : '' })}
            />
            <InputNumber
              min={1}
              style={{ width: 120 }}
              value={delayForm.plan_duration}
              onChange={(v) => setDelayForm({ ...delayForm, plan_duration: v })}
              addonAfter="天"
            />
          </div>
          <div style={{ fontSize: 12, color: '#888' }}>
            新的计划结束：
            {delayForm.plan_start
              ? dayjs(delayForm.plan_start).add(Math.max(0, (Number(delayForm.plan_duration) || 1) - 1), 'day').format('YYYY-MM-DD')
              : '—'}
          </div>
          <Input placeholder="推迟原因（写入操作历史）" value={delayForm.note} onChange={(e) => setDelayForm({ ...delayForm, note: e.target.value })} />
        </Space>
      </Modal>
    </div>
  );
};

export default ProjectPlan;
