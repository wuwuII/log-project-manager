import React, { useCallback, useEffect, useState } from 'react';
import { Button, Input, Modal, Table, Tag, Tooltip, message } from 'antd';
import { ReloadOutlined, UndoOutlined } from '@ant-design/icons';
import api from '../api';
import { confirmDialog } from '../utils/confirm';
import type { RecycleRow } from '../types';

/**
 * 回收站面板（2026-10-05）
 *
 * 🔴 老浏览器（Edge 84 / Chromium 84）硬约束：
 *   - 标签栏**手写按钮**，不用 antd `Tabs`（Tabs 依赖 rc-motion，是「弹层不卸载」的同一类坑；
 *     项目已有手写 SheetTabs 先例）。
 *   - 删除类确认一律用自建 `confirmDialog`，**严禁 `Modal.confirm`**（老浏览器离场动画不触发 →
 *     全屏遮罩残留吃掉点击）。
 *   - 外壳用**声明式** `<Modal open={...}>`。
 *
 * 范围：按用户方向把「人员」也纳入 —— 共 5 个标签页（工作表 / 项目 / 任务 / 待办 / 人员）。
 */

type RecycleType = 'table' | 'project' | 'task' | 'todo' | 'person';

interface RecycleList {
  tables: RecycleRow[];
  projects: RecycleRow[];
  tasks: RecycleRow[];
  todos: RecycleRow[];
  people: RecycleRow[];
  counts: { tables: number; projects: number; tasks: number; todos: number; people: number; total: number };
}

interface Props {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

const TABS: { key: RecycleType; label: string }[] = [
  { key: 'table', label: '工作表' },
  { key: 'project', label: '项目' },
  { key: 'task', label: '任务' },
  { key: 'todo', label: '待办' },
  { key: 'person', label: '人员' },
];

const ARR: Record<RecycleType, 'tables' | 'projects' | 'tasks' | 'todos' | 'people'> = {
  table: 'tables', project: 'projects', task: 'tasks', todo: 'todos', person: 'people',
};
const CNT: Record<RecycleType, 'tables' | 'projects' | 'tasks' | 'todos' | 'people'> = ARR;

const fmtTime = (v?: string | null) => (v ? new Date(v).toLocaleString('zh-CN') : '—');

const RecycleBin: React.FC<Props> = ({ open, onClose, onChanged }) => {
  const [active, setActive] = useState<RecycleType>('table');
  const [data, setData] = useState<RecycleList | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [emptyInput, setEmptyInput] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/recycle/list');
      setData(r.data);
    } catch (e: any) {
      message.error(e?.friendlyMessage || '加载回收站失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setEmptyInput('');
      void load();
    }
  }, [open, load]);

  const rows: RecycleRow[] = data ? (data[ARR[active]] as RecycleRow[]) : [];
  const total = data?.counts.total ?? 0;

  const onRestore = async (type: RecycleType, row: RecycleRow) => {
    setBusy(true);
    try {
      const r = await api.post('/recycle/restore', { type, id: row.id });
      const restored: { type: string; id: string; name: string }[] = r.data?.restored || [];
      let msg = `已恢复「${restored[0]?.name ?? row.name}」`;
      if (restored.length > 1) {
        msg += `（已一并恢复「${restored[1].name}」${restored.length > 2 ? ` 等 ${restored.length - 1} 项` : ''}）`;
      }
      message.success(msg);
      await load();
      onChanged();
    } catch (e: any) {
      message.error(e?.friendlyMessage || '恢复失败');
    } finally {
      setBusy(false);
    }
  };

  const onPurge = async (type: RecycleType, row: RecycleRow) => {
    // 先取连带条数（预览失败不阻断，按 0 处理）
    let pv: any = { total: 0 };
    try {
      const r = await api.post('/recycle/purge-preview', { type, id: row.id });
      pv = r.data || { total: 0 };
    } catch { /* ignore */ }
    const parts: string[] = [];
    if (pv.logs) parts.push(`日志 ${pv.logs}`);
    if (pv.todos) parts.push(`待办 ${pv.todos}`);
    if (pv.projects) parts.push(`项目 ${pv.projects}`);
    if (pv.tasks) parts.push(`任务 ${pv.tasks}`);
    const extra = pv.total > 0 ? `\n将一并删除：${parts.join(' / ')}，共 ${pv.total} 条。` : '';
    confirmDialog({
      title: '彻底删除',
      okText: '彻底删除',
      danger: true,
      content: `确定彻底删除「${row.name}」？此操作不可撤销。${extra}`,
      onOk: async () => {
        await api.post('/recycle/purge', { type, id: row.id });
        message.success('已彻底删除');
        await load();
        onChanged();
      },
    });
  };

  const onEmpty = () => {
    confirmDialog({
      title: '清空回收站',
      danger: true,
      okText: '清空',
      content: `将彻底删除回收站内全部 ${total} 条记录（工作表附带数据一并删除），不可撤销。已自动备份数据库。`,
      onOk: async () => {
        await api.post('/recycle/empty', { confirm: '删除' });
        message.success('已清空回收站');
        setEmptyInput('');
        await load();
        onChanged();
      },
    });
  };

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      width: 190,
      ellipsis: true,
      render: (v: string) => <Tooltip title={v}><span>{v}</span></Tooltip>,
    },
    {
      title: '原属',
      dataIndex: 'parent_name',
      width: 180,
      render: (v: string | null, r: RecycleRow) => (
        <span>
          {v || <span style={{ color: '#bbb' }}>—</span>}
          {r.parent_deleted ? <Tag color="red" style={{ marginLeft: 6 }}>已删除</Tag> : null}
        </span>
      ),
    },
    { title: '删除时间', dataIndex: 'deleted_at', width: 150, render: (v: string) => fmtTime(v) },
    {
      title: '操作',
      key: 'op',
      width: 150,
      render: (_: any, r: RecycleRow) => (
        <span>
          <Button type="link" size="small" icon={<UndoOutlined />} disabled={busy} onClick={() => void onRestore(active, r)}>
            恢复
          </Button>
          <Button type="link" size="small" danger disabled={busy} onClick={() => void onPurge(active, r)}>
            彻底删除
          </Button>
        </span>
      ),
    },
  ];

  return (
    <Modal
      open={open}
      title="回收站"
      width={760}
      onCancel={onClose}
      destroyOnClose
      footer={
        <Button type="primary" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="lpm-recycle-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={'lpm-recycle-tab' + (active === t.key ? ' active' : '')}
            onClick={() => setActive(t.key)}
          >
            {t.label} ({data?.counts[CNT[t.key]] ?? 0})
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
      </div>

      <Table<RecycleRow>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        columns={columns as any}
        pagination={{ pageSize: 10, size: 'small' }}
        locale={{ emptyText: '回收站是空的' }}
      />

      <div className="lpm-recycle-footer">
        <span className="lpm-recycle-hint">清空会删除回收站内全部记录（不可撤销，已自动备份）：</span>
        <Input
          size="small"
          style={{ width: 150 }}
          placeholder="输入 删除 二字以确认"
          value={emptyInput}
          onChange={(e) => setEmptyInput(e.target.value)}
        />
        <Button danger size="small" disabled={emptyInput !== '删除' || total === 0} onClick={onEmpty}>
          清空回收站
        </Button>
      </div>
    </Modal>
  );
};

export default RecycleBin;
