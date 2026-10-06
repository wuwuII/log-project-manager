import React, { useEffect, useState } from 'react';
import { Drawer, Table, Tag, Button, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import api from '../api';
import { confirmDialog } from '../utils/confirm';

interface Props {
  open: boolean;
  onClose: () => void;
  tableId?: string;
}

const ACTION_COLOR: Record<string, string> = {
  create: 'green',
  update: 'blue',
  delete: 'red',
  complete: 'gold',
  import: 'purple',
  export: 'cyan',
};

const HistoryDrawer: React.FC<Props> = ({ open, onClose, tableId }) => {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/history', { params: { table_id: tableId, limit: 300 } });
      setRows(r.data.history || []);
    } catch (e: any) {
      message.error(e?.friendlyMessage || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
  }, [open, tableId]);

  // 口径④：清理旧记录（只保留最近 500 条），删前用自建 confirmDialog（禁用 Modal.confirm）
  const trimHistory = () => {
    confirmDialog({
      title: '清理旧记录',
      danger: true,
      okText: '清理',
      content: '将删除操作历史中较早的记录，仅保留最近 500 条。不可撤销（不影响业务数据）。',
      onOk: async () => {
        const r = await api.post('/history/trim', { keep: 500 });
        message.success(`已清理 ${r.data?.deleted ?? 0} 条旧记录`);
        await load();
      },
    });
  };

  return (
    <Drawer
      title="操作历史（可追溯）"
      open={open}
      onClose={onClose}
      width={Math.min(760, window.innerWidth - 40)}
      extra={
        <>
          <Button size="small" onClick={trimHistory}>清理旧记录</Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </>
      }
    >
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 15, size: 'small' }}
        columns={[
          {
            title: '时间',
            dataIndex: 'created_at',
            width: 155,
            render: (v) => new Date(v).toLocaleString('zh-CN'),
          },
          {
            title: '动作',
            dataIndex: 'action',
            width: 82,
            render: (v) => <Tag color={ACTION_COLOR[v] || 'default'}>{v}</Tag>,
          },
          { title: '对象', dataIndex: 'entity', width: 110, render: (v) => v || '—' },
          {
            title: '内容',
            dataIndex: 'after',
            render: (v) => {
              if (!v) return <span style={{ color: '#bbb' }}>—</span>;
              try {
                const o = JSON.parse(v);
                const keys = ['name', 'title', 'content', 'status', 'progress', 'file', 'mode', 'counts'];
                const parts: string[] = [];
                for (const k of keys) {
                  if (o[k] !== undefined && o[k] !== null && o[k] !== '') {
                    parts.push(`${k}=${typeof o[k] === 'object' ? JSON.stringify(o[k]).slice(0, 60) : String(o[k]).slice(0, 60)}`);
                  }
                }
                return <span style={{ fontSize: 12, color: '#555' }}>{parts.join('  ') || JSON.stringify(o).slice(0, 120)}</span>;
              } catch {
                return <span style={{ fontSize: 12, color: '#555' }}>{String(v).slice(0, 120)}</span>;
              }
            },
          },
        ]}
      />
    </Drawer>
  );
};

export default HistoryDrawer;
