import React, { useEffect, useState } from 'react';
import { Button, DatePicker, Drawer, Input, InputNumber, Select, Space, message } from 'antd';
import dayjs from 'dayjs';
import api from '../api';
import { flush } from '../utils/autosave';
import type { Person, TableMeta, Todo } from '../types';

interface Props {
  open: boolean;
  todo: Todo | null;
  tables: TableMeta[];
  people: Person[];
  onClose: () => void;
  onDone: () => void;
}

/**
 * 待办 → 加入项目计划
 * 用非模态 Drawer（方案 4.3）：不阻塞切换工作表，符合方案"s非模态侧滑"要求。
 */
const TodoToProject: React.FC<Props> = ({ open, todo, tables, people, onClose, onDone }) => {
  const projectTables = tables.filter((t) => t.type === 'project');
  const [projectTableId, setProjectTableId] = useState<string>('');
  const [tasks, setTasks] = useState<any[]>([]);
  const [form, setForm] = useState<any>({
    parent_id: undefined,
    plan_start: dayjs().format('YYYY-MM-DD'),
    plan_duration: 1,
    assignee_id: undefined,
    points: 0,
    note: '',
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const first = projectTables[0];
    setProjectTableId(first ? first.id : '');
    if (todo) {
      setForm((f: any) => ({
        ...f,
        assignee_id: todo.assignee_id || undefined,
        points: todo.points || 0,
      }));
    }
  }, [open, todo]);

  // 选中项目表 → 取该项目下的任务（供选父任务）
  useEffect(() => {
    if (!projectTableId) return;
    const t = projectTables.find((x) => x.id === projectTableId);
    if (!t) return;
    let pid = '';
    try {
      pid = JSON.parse(t.config || '{}').project_id || '';
    } catch {}
    if (!pid) return;
    api.get('/projects/' + pid + '/tasks').then((r) => setTasks(r.data.tasks || []));
  }, [projectTableId, tables]);

  const submit = async () => {
    if (!todo) return;
    if (!projectTableId) return message.warning('请选择目标项目表');
    const t = projectTables.find((x) => x.id === projectTableId);
    let pid = '';
    try {
      pid = JSON.parse(t?.config || '{}').project_id || '';
    } catch {}
    if (!pid) return message.error('该项目表没有关联项目');

    setBusy(true);
    try {
      await flush();
      await api.post(`/todos/${todo.id}/to-project`, {
        project_id: pid,
        parent_id: form.parent_id || null,
        plan_start: form.plan_start || null,
        plan_duration: Number(form.plan_duration) || 1,
        assignee_id: form.assignee_id || null,
        points: Number(form.points) || 0,
        note: form.note || null,
      });
      message.success('已加入项目计划');
      onDone();
      onClose();
    } catch (e: any) {
      message.error(e?.friendlyMessage || '失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title="添加到项目计划"
      placement="right"
      width={380}
      open={open}
      onClose={onClose}
      mask={false}
      maskClosable={false}
      styles={{ wrapper: { boxShadow: '-2px 0 8px rgba(0,0,0,0.08)' } }}
      footer={
        <Space style={{ float: 'right' }}>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={busy} onClick={submit}>
            保存
          </Button>
        </Space>
      }
    >
      <div style={{ marginBottom: 12, color: '#555' }}>
        待办：<b>{todo?.title}</b>
      </div>

      <Space direction="vertical" style={{ width: '100%' }}>
        <Select
          style={{ width: '100%' }}
          placeholder="目标项目表"
          value={projectTableId || undefined}
          onChange={setProjectTableId}
          options={projectTables.map((t) => ({ value: t.id, label: t.name }))}
        />

        <Select
          style={{ width: '100%' }}
          allowClear
          placeholder="父任务（可选）"
          value={form.parent_id}
          onChange={(v) => setForm({ ...form, parent_id: v })}
          options={tasks.map((t) => ({ value: t.id, label: t.name }))}
        />

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
            value={form.plan_duration}
            onChange={(v) => setForm({ ...form, plan_duration: v })}
            addonAfter="天"
          />
        </div>

        <div style={{ fontSize: 12, color: '#888' }}>
          计划结束：
          {form.plan_start
            ? dayjs(form.plan_start).add(Math.max(0, (Number(form.plan_duration) || 1) - 1), 'day').format('YYYY-MM-DD')
            : '—'}
        </div>

        <Select
          style={{ width: '100%' }}
          allowClear
          placeholder="负责人"
          value={form.assignee_id}
          onChange={(v) => setForm({ ...form, assignee_id: v })}
          options={people.map((p) => ({ value: p.id, label: p.name }))}
        />

        <InputNumber
          style={{ width: '100%' }}
          min={0}
          placeholder="总积分"
          value={form.points}
          onChange={(v) => setForm({ ...form, points: v })}
          addonAfter="分"
        />

        <Input.TextArea
          rows={2}
          placeholder="备注（可选）"
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
        />

        <div style={{ fontSize: 12, color: '#999' }}>
          保存后会写入项目任务；这个面板不会挡住你切换其它工作表。
        </div>
      </Space>
    </Drawer>
  );
};

export default TodoToProject;
