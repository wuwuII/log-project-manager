import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirmDialog } from '../utils/confirm';
import { Button, Input, Modal, Select, Tooltip, message } from 'antd';
import {
  DeleteOutlined,
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
import type { LogEntry, Person, TableMeta, Todo } from '../types';

const WD = ['一', '二', '三', '四', '五', '六', '日'];
/** 一次渲染 12 周（约 3 个月），靠滚轮上下滚动查看，不用翻页按钮 */
const WEEKS_SHOWN = 12;
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
  // 从"本周往前 4 周"开始渲染，打开后自动滚到本周
  const [rangeStart, setRangeStart] = useState<Date>(() => addDays(mondayOf(new Date()), -28));
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

  /** 打开/切换工作表时，把视图滚到「今天」那一行（而不是从 4 周前开始看） */
  useEffect(() => {
    const t = window.setTimeout(() => {
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
          <Button
            size="small"
            onClick={() => {
              void flush();
              setRangeStart(addDays(mondayOf(new Date()), -28));
            }}
          >
            回到本周
          </Button>
          <span style={{ flex: 1 }} />
          <span style={{ color: '#999', fontSize: 11.5 }}>
            抓某一周的日期栏上下拖 = 调这一周高度（双击恢复默认）· 滚轮查看多周 · 输入自动保存
          </span>
        </div>

        {/* 滚轮直接上下滚，不用按钮翻页 */}
        <div className="lpm-cal-scroll" style={{ flex: 1, minHeight: 0 }}>
          {Array.from({ length: WEEKS_SHOWN }).map((_, w) => {
            const weekDays = days.slice(w * 7, w * 7 + 7);
            const isCurrentWeek = weekDays.some((d) => ymd(d) === todayStr);
            const weekKey = ymd(weekDays[0]); // 该周周一 YYYY-MM-DD，作为 week_heights 的键
            const weekLabel = `${weekDays[0].getMonth() + 1}/${weekDays[0].getDate()}–${weekDays[6].getMonth() + 1}/${weekDays[6].getDate()}`;
            return (
              <div
                className="lpm-week-row"
                key={w}
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
                      <div className="lpm-day-body">
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
