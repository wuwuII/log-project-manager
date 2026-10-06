import React, { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Select, Spin, Typography } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import api from '../api';
import type { Person } from '../types';

const { Text } = Typography;

/** 与任务公会 Ranking.tsx 一致的 20 色调色板 */
const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
  '#dcbeff', '#9a6324', '#800000', '#aaffc3', '#808000',
  '#ffd8b1', '#000075', '#e6beff', '#ffb469', '#8a2be2',
];

interface DayCell {
  key: string;
  title: string;
  points: number;
}
interface DayEntry {
  date: string;
  tasks: DayCell[];
}
interface TaskMapItem {
  title: string;
  color: string;
  kind: string;
  project_id: string | null;
  project_name: string;
  total_points?: number;
  progress?: number;
}
interface DailyData {
  person: { id: string; name: string; role?: string | null; color?: string | null } | null;
  summary: {
    task_count: number;
    done_count: number;
    avg_daily_expected: number;
    total_expected_this_month: number;
    avg_daily_actual: number;
    total_actual_this_month: number;
    total_actual: number;
  };
  from: string;
  to: string;
  today: string;
  expected: DayEntry[];
  actual: DayEntry[];
  task_map: Record<string, TaskMapItem>;
}

/** 本地日期格式化（禁止 toISOString，会因时区差一天）*/
const fmtLocal = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const genDateRange = (start: Date, days: number): string[] => {
  const out: string[] = [];
  const d = new Date(start);
  for (let i = 0; i < days; i++) {
    out.push(fmtLocal(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
};

const mapDataToRange = (data: DayEntry[], range: string[]): DayEntry[] => {
  const m = new Map<string, DayEntry>();
  data.forEach((d) => m.set(d.date, d));
  return range.map((date) => m.get(date) || { date, tasks: [] });
};

/** y 轴自适应上限（照任务公会 calcMaxY）*/
const calcMaxY = (expected: DayEntry[], actual: DayEntry[]) => {
  let max = 0;
  [...expected, ...actual].forEach((d) => {
    const s = d.tasks.reduce((a, t) => a + t.points, 0);
    if (s > max) max = s;
  });
  if (max === 0) return 10;
  const scaled = max * 1.2;
  if (scaled <= 10) return 10;
  const magnitude = Math.pow(10, Math.floor(Math.log10(scaled)));
  const step = magnitude / 2;
  return Math.ceil(scaled / step) * step;
};

/** 单个堆叠柱状图 option（照任务公会 buildChartOption 简化：按项目分组 + 每事项一色）*/
const buildOption = (
  data: DayEntry[],
  taskMap: Record<string, TaskMapItem>,
  title: string,
  yMax: number,
) => {
  if (!data.length) return {};

  // 按「项目」分组收集 key（保持出现顺序）
  const groups: { name: string; keys: string[] }[] = [];
  const seen = new Set<string>();
  for (const k of Object.keys(taskMap)) {
    const info = taskMap[k];
    const gn = info.project_name || '其他';
    if (!seen.has(gn)) {
      seen.add(gn);
      groups.push({ name: gn, keys: [] });
    }
    groups.find((g) => g.name === gn)!.keys.push(k);
  }

  const dates = data.map((d) => d.date.substring(5));
  const nDays = data.length;

  // 收集每个 key 的每天数值
  const raw: number[][] = [];
  const keysOrder: string[] = [];
  groups.forEach((g) =>
    g.keys.forEach((k) => {
      raw.push(
        data.map((d) => d.tasks.filter((x) => x.key === k).reduce((s, x) => s + x.points, 0)),
      );
      keysOrder.push(k);
    }),
  );

  // 同项目内的系列索引（用于圆角判断）
  const groupIdx: number[][] = [];
  let ts = 0;
  groups.forEach((g) => {
    const idx: number[] = [];
    for (let j = 0; j < g.keys.length; j++) idx.push(ts + j);
    groupIdx.push(idx);
    ts += g.keys.length;
  });
  const siblingsOf = (si: number) => groupIdx.find((g) => g.includes(si)) || [si];

  const series: any[] = [];
  for (let si = 0; si < raw.length; si++) {
    const info = taskMap[keysOrder[si]] || ({ title: keysOrder[si], color: '#999' } as TaskMapItem);
    const sib = siblingsOf(si);
    const enriched: any[] = [];
    for (let di = 0; di < nDays; di++) {
      const val = raw[si][di];
      if (!val || val <= 0) {
        enriched.push({ value: 0, itemStyle: { color: info.color, borderRadius: 0 } });
        continue;
      }
      const active = sib.filter((i) => raw[i][di] > 0);
      let br: number | number[];
      if (active.length === 1) br = [3, 3, 3, 3];
      else if (active[0] === si) br = [0, 0, 3, 3];
      else if (active[active.length - 1] === si) br = [3, 3, 0, 0];
      else br = 0;
      enriched.push({ value: val, itemStyle: { color: info.color, borderRadius: br } });
    }
    series.push({ name: info.title, type: 'bar', stack: 'total', data: enriched, barMaxWidth: 26 });
  }

  const labelInterval = data.length > 20 ? Math.ceil(data.length / 12) : 0;

  return {
    title: { text: title, left: 'center', textStyle: { fontSize: 13, fontWeight: 600 } },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any) => {
        if (!Array.isArray(params)) return '';
        const date = params[0]?.axisValue || '';
        let html = '<b>' + date + '</b><br/>';
        let total = 0;
        const grouped: Record<string, { name: string; color: string; value: number }[]> = {};
        const order: string[] = [];
        for (const p of params) {
          if (p.value <= 0) continue;
          const info = Object.values(taskMap).find((t) => t.title === p.seriesName);
          const gn = info?.project_name || '其他';
          if (!grouped[gn]) {
            grouped[gn] = [];
            order.push(gn);
          }
          grouped[gn].push({ name: p.seriesName, color: p.color, value: p.value });
          total += p.value;
        }
        for (const gn of order) {
          html += `<div style="margin-top:3px;font-size:10px;font-weight:600;color:#8c8c8c;">${gn}</div>`;
          for (const it of grouped[gn]) {
            html += `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${it.color};margin-right:4px;"></span>`;
            html += `${it.name}: ${it.value}分<br/>`;
          }
        }
        if (total > 0) html += `<b>合计: ${Math.round(total * 100) / 100}分</b>`;
        return html;
      },
    },
    legend: { show: false },
    grid: { left: 42, right: 18, top: 34, bottom: 24 },
    xAxis: {
      type: 'category',
      data: dates,
      axisLabel: { rotate: data.length > 14 ? 20 : 0, fontSize: 10, interval: labelInterval > 0 ? labelInterval : 'auto' },
    },
    yAxis: { type: 'value', name: '分', max: yMax },
    series,
  };
};

/** 图例：按项目分组显示每个事项的色块 */
const GroupLegend: React.FC<{ taskMap: Record<string, TaskMapItem> }> = ({ taskMap }) => {
  const keys = Object.keys(taskMap);
  if (!keys.length) return null;
  const groups: Record<string, { name: string; items: { k: string; title: string; color: string }[] }> = {};
  const order: string[] = [];
  for (const k of keys) {
    const info = taskMap[k];
    const gid = info.project_id || info.project_name || '_';
    if (!groups[gid]) {
      groups[gid] = { name: info.project_name || '其他', items: [] };
      order.push(gid);
    }
    groups[gid].items.push({ k, title: info.title, color: info.color });
  }
  const single = order.length === 1;
  return (
    <div style={{ padding: '4px 0', fontSize: 11, lineHeight: '18px' }}>
      {order.map((gid, ti) => {
        const g = groups[gid];
        return (
          <div
            key={gid}
            style={{
              marginBottom: ti < order.length - 1 ? 6 : 0,
              border: single ? 'none' : '1px solid #d9d9d9',
              borderRadius: 6,
              padding: single ? '2px 0' : '4px 8px 2px',
            }}
          >
            {!single && (
              <div style={{ fontWeight: 600, color: '#595959', fontSize: 10, marginBottom: 2 }}>{g.name}</div>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
              {g.items.map((it) => (
                <span key={it.k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: it.color, flexShrink: 0 }} />
                  <span style={{ color: '#666' }}>{it.title}</span>
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};

interface Props {
  people: Person[];
  selectedPersonId: string;
  onSelectPerson: (id: string) => void;
  windowDays: number;
  onWindowDays: (d: number) => void;
  /** 按项目筛选（空数组 = 全部） */
  projectIds?: string[];
}

/** 单人工作量双图（照任务公会 RankChart）*/
const RankChart: React.FC<Props> = ({ people, selectedPersonId, onSelectPerson, windowDays, onWindowDays, projectIds }) => {
  const [data, setData] = useState<DailyData | null>(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [inited, setInited] = useState(false);

  useEffect(() => {
    if (!selectedPersonId) {
      setData(null);
      return;
    }
    setLoading(true);
    const params: any = { person_id: selectedPersonId };
    if (projectIds && projectIds.length) params.project_ids = projectIds.join(',');
    api
      .get('/points/daily', { params })
      .then((r) => {
        setData(r.data);
        setInited(false);
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [selectedPersonId, projectIds]);

  const dataDays = data?.expected?.length || 0;
  const lastDate = dataDays > 0 ? data!.expected[dataDays - 1].date : '';
  const today = data?.today || '';
  const virtualTotal = useMemo(() => (dataDays === 0 ? windowDays : dataDays + windowDays), [dataDays, windowDays]);

  const { fullExpected, actualPadded, todayIndex } = useMemo(() => {
    if (dataDays === 0 || !lastDate) return { fullExpected: [] as DayEntry[], actualPadded: [] as DayEntry[], todayIndex: -1 };
    const lastD = new Date(lastDate + 'T00:00:00');
    const startD = new Date(lastD);
    startD.setDate(startD.getDate() - virtualTotal + 1);
    const range = genDateRange(startD, virtualTotal);
    return {
      fullExpected: mapDataToRange(data!.expected, range),
      actualPadded: mapDataToRange(data!.actual || [], range),
      todayIndex: range.indexOf(today),
    };
  }, [dataDays, lastDate, virtualTotal, today, data]);

  const maxOffset = Math.max(0, virtualTotal - windowDays);
  const defaultOffset = useMemo(() => {
    if (todayIndex < 0) return maxOffset;
    return Math.max(0, Math.min(maxOffset, Math.floor(todayIndex - windowDays / 2)));
  }, [todayIndex, windowDays, maxOffset]);

  useEffect(() => {
    if (!inited && dataDays > 0) {
      setOffset(defaultOffset);
      setInited(true);
    }
  }, [defaultOffset, inited, dataDays]);

  if (loading) return <Spin style={{ display: 'block', padding: 40 }} />;
  if (!selectedPersonId) return <Empty description="请先选择人员" style={{ padding: 40 }} />;
  if (!data || dataDays === 0) return <Empty description="该人员暂无任务与积分记录" style={{ padding: 40 }} />;

  const step = Math.max(1, Math.floor(windowDays / 3));
  const expSlice = fullExpected.slice(offset, offset + windowDays);
  const actSlice = actualPadded.slice(offset, offset + windowDays);
  const maxY = calcMaxY(expSlice, actSlice);
  const rangeText = expSlice.length ? `${expSlice[0].date.substring(5)} ~ ${expSlice[expSlice.length - 1].date.substring(5)}` : '';
  const s = data.summary;

  return (
    <div>
      {/* 统计卡片：flex 自适应，任何窗口宽度都不折行不竖排
          （2026-10-03 用户反馈：原来 Col span=6 挤成竖排文字） */}
      <div className="lpm-stat-row">
        <div className="lpm-stat-card">
          <span className="k">承接任务</span>
          <span className="v">{s.task_count}</span>
        </div>
        <div className="lpm-stat-card">
          <span className="k">已完成</span>
          <span className="v">{s.done_count}</span>
        </div>
        <div className="lpm-stat-card">
          <span className="k">日均（实际）</span>
          <span className="v">
            {s.avg_daily_actual}
            <span className="u">分</span>
          </span>
        </div>
        <div className="lpm-stat-card">
          <span className="k">本月（实际）</span>
          <span className="v">
            {s.total_actual_this_month}
            <span className="u">分</span>
          </span>
        </div>
        <div className="lpm-stat-card">
          <span className="k">本月（应得）</span>
          <span className="v">
            {s.total_expected_this_month}
            <span className="u">分</span>
          </span>
        </div>
      </div>

      {/* 时间窗口 + 平移 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <Button size="small" icon={<LeftOutlined />} disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - step))} />
        <Select
          size="small"
          value={windowDays}
          onChange={onWindowDays}
          style={{ width: 88 }}
          options={[
            { value: 14, label: '14天' },
            { value: 30, label: '30天' },
            { value: 90, label: '3个月' },
          ]}
        />
        <Select
          size="small"
          style={{ width: 130 }}
          value={selectedPersonId}
          onChange={onSelectPerson}
          options={people.map((p) => ({ value: p.id, label: p.name }))}
        />
        <Button size="small" icon={<RightOutlined />} disabled={offset >= maxOffset} onClick={() => setOffset(Math.min(maxOffset, offset + step))} />
        <Text type="secondary" style={{ fontSize: 11 }}>{rangeText}</Text>
      </div>

      {/* 两张图：计划得到的 / 已经得到的 */}
      <ReactECharts
        option={buildOption(expSlice, data.task_map, '计划得到的（按计划均摊，含未来）', maxY)}
        style={{ height: 250 }}
        notMerge
      />
      <div style={{ height: 8 }} />
      <ReactECharts
        option={buildOption(actSlice, data.task_map, '已经得到的（按实际发生）', maxY)}
        style={{ height: 250 }}
        notMerge
      />
      <GroupLegend taskMap={data.task_map} />
    </div>
  );
};

export default RankChart;
