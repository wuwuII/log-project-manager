import React, { useCallback, useEffect, useState } from 'react';
import { confirmDialog } from '../utils/confirm';
import { Button, Input, InputNumber, Modal, Select, Table, Tabs, Tooltip, message } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import api from '../api';
import RankChart from './RankChart';
import type { Person } from '../types';

interface Props {
  people: Person[];
  reloadPeople: () => void;
}

interface SummaryItem {
  person_id: string;
  name: string;
  role?: string | null;
  total_points: number;
  range_points: number;
}

const PeopleStats: React.FC<Props> = ({ people, reloadPeople }) => {
  const [tab, setTab] = useState('chart');

  // ── 工作量图状态 ──
  /**
   * 2026-10-08 用户反馈修：「每次切回来，人员工作量选的不是我最后一次选的那个人，会默认换成默认名字」。
   * 原因：selectedPersonId 只存在内存 state 里，切走再切回组件重建 → 归零 →
   * loadSummary 里「不在列表就选第一个人」的兜底把选择顶掉了。
   * 修法：把「最后一次选的人」落到 localStorage，下次进来自动恢复（那个人被删了才退回第一个）。
   */
  const SEL_KEY = 'lpm.people.selectedPerson';
  const readSel = () => {
    try {
      return localStorage.getItem(SEL_KEY) || '';
    } catch {
      return '';
    }
  };
  const [selectedPersonId, setSelectedPersonId] = useState<string>(readSel);
  /**
   * 窗口大小也记住（用户 2026-10-08 追加：「我选了哪 14 天，切回来还应该是那一段」）。
   * 与 RankChart 里的「窗口起始日」一起，构成「上次看的到底是哪一段」。
   */
  const WD_KEY = 'lpm.people.windowDays';
  const readWD = () => {
    try {
      const v = Number(localStorage.getItem(WD_KEY));
      return v === 14 || v === 30 || v === 90 || v === 180 ? v : 14;
    } catch {
      return 14;
    }
  };
  const [windowDays, setWindowDays] = useState<number>(readWD);

  useEffect(() => {
    try {
      localStorage.setItem(WD_KEY, String(windowDays));
    } catch {
      /* ignore */
    }
  }, [windowDays]);

  // 选择变化 → 立刻落盘（下次进来恢复）
  useEffect(() => {
    try {
      if (selectedPersonId) localStorage.setItem(SEL_KEY, selectedPersonId);
    } catch {
      /* 隐私模式等写不了就算了，不影响功能 */
    }
  }, [selectedPersonId]);
  /** 项目筛选（2026-10-03：原来这个下拉是 disabled 的灰框，用户以为坏了） */
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectIds, setProjectIds] = useState<string[]>([]);

  // ── 人员管理状态 ──
  const [rows, setRows] = useState<SummaryItem[]>([]);
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');
  const [editTarget, setEditTarget] = useState<SummaryItem | null>(null);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState('');
  const [manualTarget, setManualTarget] = useState<SummaryItem | null>(null);
  const [manualPoints, setManualPoints] = useState(0);
  const [manualReason, setManualReason] = useState('');

  // ── 流水 ──
  const [ledger, setLedger] = useState<any[]>([]);

  const loadSummary = useCallback(async () => {
    try {
      const r = await api.get('/points/summary');
      const items: SummaryItem[] = r.data.items || [];
      setRows(items);
      // 默认选中第一个人（用户说"只显示一个人"也要正确）
      setSelectedPersonId((cur) => {
        if (cur && items.some((x) => x.person_id === cur)) return cur;
        // 2026-10-08：内存里没有（刚切回来）→ 用「上次选的人」；连他也不在列表才退回第一个
        const saved = readSel();
        if (saved && items.some((x) => x.person_id === saved)) return saved;
        return items.length ? items[0].person_id : '';
      });
    } catch (e: any) {
      message.error('统计加载失败：' + (e?.friendlyMessage || ''));
    }
  }, []);

  const loadLedger = useCallback(async () => {
    try {
      const r = await api.get('/points/ledger', { params: { limit: 200 } });
      setLedger(r.data.ledger || []);
    } catch {}
  }, []);

  useEffect(() => {
    void loadSummary();
    void loadLedger();
    // 项目列表（供「按项目筛选」用）
    api
      .get('/projects')
      .then((r) => {
        const list = r.data?.projects || r.data || [];
        setProjects(Array.isArray(list) ? list.map((p: any) => ({ id: p.id, name: p.name })) : []);
      })
      .catch(() => {});
  }, [loadSummary, loadLedger]);

  // ── 人员管理操作 ──
  const addPerson = async () => {
    if (!newName.trim()) return message.warning('请输入姓名');
    try {
      await api.post('/people', { name: newName.trim(), role: newRole.trim() || null });
      setNewName('');
      setNewRole('');
      await loadSummary();
      await reloadPeople();
      message.success('已添加');
    } catch (e: any) {
      message.error(e?.friendlyMessage || '添加失败');
    }
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    try {
      await api.patch(`/people/${editTarget.person_id}`, {
        name: editName.trim(),
        role: editRole.trim() || null,
      });
      setEditTarget(null);
      await loadSummary();
      await reloadPeople();
      message.success('已保存');
    } catch (e: any) {
      message.error(e?.friendlyMessage || '保存失败');
    }
  };

  const delPerson = (r: SummaryItem) => {
    confirmDialog({
      title: '删除人员',
      content: `确定删除「${r.name}」？（软删除，积分流水保留）`,
      okText: '删除',
      danger: true,
      onOk: async () => {
        await api.delete(`/people/${r.person_id}`);
        await loadSummary();
        await reloadPeople();
      },
    });
  };

  const doManual = async () => {
    if (!manualTarget) return;
    try {
      await api.post('/points/manual', {
        person_id: manualTarget.person_id,
        points: Number(manualPoints) || 0,
        reason: manualReason || '手工调整',
      });
      setManualTarget(null);
      setManualPoints(0);
      setManualReason('');
      await loadSummary();
      await loadLedger();
      await reloadPeople();
      message.success('已记账');
    } catch (e: any) {
      message.error(e?.friendlyMessage || '失败');
    }
  };

  const doRecalc = async (r: SummaryItem) => {
    try {
      await api.post(`/points/recalc/${r.person_id}`);
      await loadSummary();
      message.success(`已按流水重算：${r.name}`);
    } catch (e: any) {
      message.error(e?.friendlyMessage || '重算失败');
    }
  };

  return (
    <div className="lpm-pad" style={{ height: '100%', overflowY: 'auto' }}>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'chart',
            label: '工作量图',
            children: (
              <div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>人员工作量</span>
                  <Select
                    size="small"
                    style={{ width: 140 }}
                    placeholder="选择人员"
                    value={selectedPersonId || undefined}
                    onChange={setSelectedPersonId}
                    options={rows.map((r) => ({ value: r.person_id, label: r.name }))}
                  />
                  <Select
                    size="small"
                    allowClear
                    mode="multiple"
                    placeholder="按项目筛选（不选=全部）"
                    style={{ minWidth: 220 }}
                    value={projectIds}
                    onChange={(v) => setProjectIds(v || [])}
                    options={projects.map((p) => ({ value: p.id, label: p.name }))}
                  />
                  <span style={{ fontSize: 11.5, color: '#999' }}>
                    每个事项一种颜色 · 按项目分组 · 上图为"计划得到"，下图为"已经得到"
                  </span>
                </div>
                <RankChart
                  people={people}
                  selectedPersonId={selectedPersonId}
                  onSelectPerson={setSelectedPersonId}
                  windowDays={windowDays}
                  onWindowDays={setWindowDays}
                  projectIds={projectIds}
                />
              </div>
            ),
          },
          {
            key: 'manage',
            label: '人员管理',
            children: (
              <div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                  <Input size="small" placeholder="姓名" style={{ width: 110 }} value={newName} onChange={(e) => setNewName(e.target.value)} onPressEnter={addPerson} />
                  <Input size="small" placeholder="角色（可选）" style={{ width: 130 }} value={newRole} onChange={(e) => setNewRole(e.target.value)} onPressEnter={addPerson} />
                  <Button size="small" type="primary" icon={<PlusOutlined />} onClick={addPerson}>
                    添加人员
                  </Button>
                </div>
                <Table
                  size="small"
                  rowKey="person_id"
                  pagination={false}
                  dataSource={rows}
                  columns={[
                    { title: '姓名', dataIndex: 'name', width: 130 },
                    { title: '角色', dataIndex: 'role', width: 130, render: (v) => v || '—' },
                    { title: '累计积分', dataIndex: 'total_points', width: 110 },
                    {
                      title: '操作',
                      width: 280,
                      render: (_: any, r: SummaryItem) => (
                        <span style={{ display: 'inline-flex', gap: 4 }}>
                          <Button size="small" onClick={() => { setEditTarget(r); setEditName(r.name); setEditRole(r.role || ''); }}>
                            编辑
                          </Button>
                          <Button size="small" onClick={() => { setManualTarget(r); setManualPoints(0); setManualReason(''); }}>
                            手工加减分
                          </Button>
                          <Tooltip title="按积分流水重算总分（纠错用）">
                            <Button size="small" onClick={() => doRecalc(r)}>
                              重算
                            </Button>
                          </Tooltip>
                          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => delPerson(r)} />
                        </span>
                      ),
                    },
                  ]}
                />
              </div>
            ),
          },
          {
            key: 'ledger',
            label: '积分流水',
            children: (
              <div>
                <div style={{ fontSize: 12.5, color: '#555', marginBottom: 6 }}>
                  积分流水（最近 200 条，唯一真相来源；点"重算"会按它校正总分）
                </div>
                <Table
                  size="small"
                  rowKey="id"
                  pagination={{ pageSize: 15, size: 'small' }}
                  dataSource={ledger}
                  columns={[
                    { title: '时间', dataIndex: 'created_at', width: 160, render: (v) => new Date(v).toLocaleString('zh-CN') },
                    { title: '人员', dataIndex: 'person_name', width: 100 },
                    { title: '积分', dataIndex: 'points', width: 80, render: (v) => (v > 0 ? `+${v}` : v) },
                    { title: '来源', dataIndex: 'source_type', width: 110 },
                    { title: '说明', dataIndex: 'reason' },
                  ]}
                />
              </div>
            ),
          },
        ]}
      />

      <Modal title="编辑人员" open={!!editTarget} onOk={saveEdit} onCancel={() => setEditTarget(null)} okText="保存" width={360}>
        <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="姓名" style={{ marginBottom: 8 }} />
        <Input value={editRole} onChange={(e) => setEditRole(e.target.value)} placeholder="角色" />
      </Modal>

      <Modal title="手工加减分" open={!!manualTarget} onOk={doManual} onCancel={() => setManualTarget(null)} okText="记账" width={360}>
        <div style={{ marginBottom: 8 }}>{manualTarget?.name}</div>
        <InputNumber value={manualPoints} onChange={(v) => setManualPoints(Number(v) || 0)} style={{ width: '100%', marginBottom: 8 }} placeholder="正数加分，负数扣分" />
        <Input value={manualReason} onChange={(e) => setManualReason(e.target.value)} placeholder="原因（可选）" />
      </Modal>
    </div>
  );
};

export default PeopleStats;
