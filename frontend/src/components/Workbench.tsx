import React, { useCallback, useEffect, useState } from 'react';
import { confirmDialog } from '../utils/confirm';
import { Button, Input, Modal, Radio, Space, Tooltip, message } from 'antd';
import {
  AppstoreOutlined,
  CheckCircleOutlined,
  DatabaseOutlined,
  ExportOutlined,
  HistoryOutlined,
  ImportOutlined,
} from '@ant-design/icons';
import api from '../api';
import SheetTabs from './SheetTabs';
import Home from '../pages/Home';
import LogCalendar from '../pages/LogCalendar';
import ProjectPlan from '../pages/ProjectPlan';
import PeopleStats from '../pages/PeopleStats';
import ImportExportModal from '../pages/ImportExport';
import HistoryDrawer from '../pages/HistoryDrawer';
import SaveStatus from './SaveStatus';
import { flush } from '../utils/autosave';
import type { Person, TableMeta, TableType } from '../types';

const Workbench: React.FC = () => {
  /**
   * 开始页（工程/文件管理）↔ 工作表内容区 —— 2026-10-03 用户明确要求：
   * 「我原来要求是个 tab 页一直存在，并且关不掉」⇒ **底部工作表标签栏永远在**，
   * 开始页只占「内容区」。旧做法（开始页全屏、把标签栏盖住）已被用户否掉。
   */
  const [showHome, setShowHome] = useState(true);
  const [tables, setTables] = useState<TableMeta[]>([]);
  const [activeId, setActiveId] = useState('');
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [ioOpen, setIoOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<TableType | ''>('');
  const [renameTarget, setRenameTarget] = useState<TableMeta | null>(null);
  const [renameName, setRenameName] = useState('');

  const loadPeople = useCallback(async () => {
    try {
      const r = await api.get('/people');
      setPeople(r.data.people || []);
    } catch {}
  }, []);

  const loadTables = useCallback(async (keepActive = true) => {
    const r = await api.get('/tables');
    const list: TableMeta[] = r.data.tables || [];
    setTables(list);
    setActiveId((cur) => {
      if (keepActive && cur && list.some((t) => t.id === cur)) return cur;
      // 支持 ?table=<id | 名称 | 类型> 直达某张工作表（方便书签/分享/截图）
      const q = new URLSearchParams(window.location.search).get('table');
      if (q) {
        const hit =
          list.find((t) => t.id === q) ||
          list.find((t) => t.name === q) ||
          list.find((t) => t.type === q);
        if (hit) return hit.id;
      }
      const saved = localStorage.getItem('lpm_active_table');
      const pick = list.find((t) => t.id === saved) || list[0];
      return pick ? pick.id : '';
    });
    return list;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await loadTables(false);
        await loadPeople();
      } catch (e: any) {
        /**
         * 🔴 方案 C3 第 5 块：工程文件缺失时后端回 409 {error:'project_file_missing'}。
         * 此时不能弹「加载失败」这种吓人的通用报错 —— 直接回开始页，
         * 由 Home 弹出「工程文件没找到，请选一下新位置」，让用户重选工程位置。
         */
        if (e?.response?.status === 409 && e?.response?.data?.error === 'project_file_missing') {
          setShowHome(true);
        } else {
          message.error('加载失败：' + (e?.friendlyMessage || e?.message || ''));
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [loadTables, loadPeople]);

  useEffect(() => {
    if (activeId) localStorage.setItem('lpm_active_table', activeId);
  }, [activeId]);

  const active = tables.find((t) => t.id === activeId) || null;

  const handleNew = async () => {
    if (!newType) return message.warning('请先选择页面类型（日志 / 项目 / 人员）');
    if (!newName.trim()) return message.warning('请填写页面名称');
    const nm = newName.trim();
    try {
      const r = await api.post('/tables', { name: nm, type: newType });
      setNewOpen(false);
      setNewName('');
      setNewType('');
      await loadTables(true);
      setActiveId(r.data.id);
      /**
       * 🔴 用户反馈「点了＋没反应」：新建确实成功，但
       *   新表插在栏位末尾、不滚动到可见，用户看不到 → 以为失败。
       *   现在：明确提示 + 把新标签滚动到可见。
       */
      message.success(`已新建工作表「${nm}」`);
      window.setTimeout(() => {
        // ⚠️ 2026-10-06：标签结构调整后 data-id 落在外层 .lpm-sheet 内的 .lpm-sheet-body 上
        const el = document.querySelector(`.lpm-sheet-body[data-id="${r.data.id}"]`);
        if (el && (el as HTMLElement).scrollIntoView) {
          (el as HTMLElement).scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
        }
      }, 300);
    } catch (e: any) {
      message.error(e?.friendlyMessage || '创建失败');
    }
  };

  const handleRename = async () => {
    if (!renameTarget || !renameName.trim()) return;
    try {
      await api.patch(`/tables/${renameTarget.id}`, { name: renameName.trim() });
      setRenameTarget(null);
      await loadTables(true);
      message.success('已重命名');
    } catch (e: any) {
      message.error(e?.friendlyMessage || '重命名失败');
    }
  };

  /** 拖动 / 「左移·右移」→ 乐观更新本地顺序，再整串发后端；失败回滚
   *  🔴 2026-10-06 降级：批量接口 /tables/reorder 是新加的，老后端（未重启的进程）
   *  会返回 404。此时退化成「逐表 PATCH sort_order」——该接口一直存在，
   *  所以**不重启后端也能立刻用**；等后端自然重启后会自动走更省的批量接口。
   */
  const handleReorder = useCallback(async (orderedIds: string[]) => {
    const byId = new Map(tables.map((t) => [t.id, t]));
    const next = orderedIds.map((id) => byId.get(id)).filter(Boolean) as TableMeta[];
    if (next.length !== tables.length) { await loadTables(true); return; } // 长度异常，拉回服务端真序
    setTables(next); // 先本地生效，手感不卡
    try {
      await api.patch('/tables/reorder', { ordered_ids: orderedIds });
      message.success('工作表顺序已保存');
    } catch (e: any) {
      try {
        // 降级：逐个写 sort_order（绝对下标，可重复执行，幂等）
        await Promise.all(orderedIds.map((id, i) => api.patch(`/tables/${id}`, { sort_order: i })));
        message.success('工作表顺序已保存');
      } catch (e2: any) {
        message.error(e2?.friendlyMessage || e?.friendlyMessage || '顺序保存失败');
        await loadTables(true); // 失败回滚到服务端顺序
      }
    }
  }, [tables, loadTables]);

  const handleDuplicate = async (t: TableMeta) => {
    try {
      await flush();
      await api.post(`/tables/${t.id}/duplicate`);
      await loadTables(true);
      message.success('已复制');
    } catch (e: any) {
      message.error(e?.friendlyMessage || '复制失败');
    }
  };

  const handleDelete = (t: TableMeta) => {
    confirmDialog({
      title: '删除工作表',
      content: `确定删除「${t.name}」？这是软删除，数据仍在数据库中（可在导出 Excel 里看到）。`,
      okText: '删除',
      danger: true,
      onOk: async () => {
        try {
          await api.delete(`/tables/${t.id}`);
          await loadTables(false);
          message.success('已删除');
        } catch (e: any) {
          message.error(e?.friendlyMessage || '删除失败');
        }
      },
    });
  };

  const exportAll = () => {
    const a = document.createElement('a');
    a.href = '/api/export/excel';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const exportOne = async (t: TableMeta) => {
    /* 🔴 2026-10-05 修复（用户反馈：工作表右键「导出该表」点了没反应）
       原来这里只做「切到该表 + 弹一句提示」，**根本没执行导出**（空壳实现）。
       现在真的调用后端单表导出接口，直接下载这一张工作表的 Excel。 */
    try {
      const a = document.createElement('a');
      a.href = '/api/export/excel?table_id=' + encodeURIComponent(t.id);
      document.body.appendChild(a);
      a.click();
      a.remove();
      message.success(`正在导出「${t.name}」…`);
    } catch (e: any) {
      message.error('导出失败：' + (e?.friendlyMessage || e?.message || ''));
    }
  };

  /**
   * 整库备份 —— 2026-10-08 用户反馈「点了没反应，不知道备份去哪了」。
   * 现在：① 明确 toast；② 弹窗把「存到哪个目录、这次是哪份、库里现在有哪些备份」全摆出来。
   */
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupInfo, setBackupInfo] = useState<{ file?: string; dir?: string; list: any[] }>({ list: [] });

  const doBackup = async () => {
    try {
      await flush();
      const r = await api.post('/backup');
      let list: any[] = [];
      try {
        const b = await api.get('/backups');
        list = b.data.backups || [];
      } catch {
        list = [];
      }
      setBackupInfo({ file: r.data.file, dir: r.data.dir, list });
      setBackupOpen(true);
      message.success('已备份：' + (r.data.file || ''));
    } catch (e: any) {
      message.error(e?.friendlyMessage || '备份失败');
    }
  };

  const fmtSize = (n: number) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(2) + ' MB' : Math.round(n / 1024) + ' KB');
  const fmtTime = (v: any) => {
    const d = new Date(v);
    if (isNaN(d.getTime())) return '';
    const p = (x: number) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  return (
    <div className="lpm-root">
      {/* ── 顶部工具栏 ── */}
      <div className="lpm-toolbar">
        <Tooltip title="回到开始页（打开 / 新建 / 另存一份工程）">
          <Button size="small" icon={<AppstoreOutlined />} onClick={() => setShowHome(true)} style={{ marginRight: 8 }}>
            开始页
          </Button>
        </Tooltip>
        <span className="lpm-title">日志与项目管理</span>
        <span style={{ color: '#bbb' }}>|</span>
        <span style={{ color: '#555' }}>{active ? active.name : '（无工作表）'}</span>

        <span className="lpm-spacer" />

        <Tooltip title="导出成 Excel：每张工作表一个 sheet，用 Excel 就能看（第一个 sheet 是说明）">
          <Button size="small" icon={<ExportOutlined />} onClick={exportAll}>
            导出 Excel
          </Button>
        </Tooltip>
        <Tooltip title="选一个之前导出的 Excel，导回来即可复原数据（会先自动备份当前库）">
          <Button size="small" icon={<ImportOutlined />} onClick={() => setIoOpen(true)}>
            导入 Excel
          </Button>
        </Tooltip>
        <Tooltip title="整库备份：把当前数据库文件整份复制到 data\backups\，出问题时可用它整库回滚">
          <Button size="small" icon={<DatabaseOutlined />} onClick={doBackup}>
            整库备份
          </Button>
        </Tooltip>
        <Tooltip title="操作记录：每条新增 / 修改 / 删除的流水账（时间、对象、改动内容），用于追溯">
          <Button size="small" icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)}>
            操作记录
          </Button>
        </Tooltip>

        {/* 方案 C3：右上角保存状态 + 「立即保存」 */}
        <SaveStatus />
      </div>

      {/* ── 内容区（开始页 或 当前工作表）── */}
      <div className="lpm-content">
        {showHome ? (
          <Home
            onEnter={() => {
              setShowHome(false);
              // 方案 C3：从开始页（可能是刚重选了工程位置）进入时，重新拉一次工作表
              void (async () => {
                try {
                  await loadTables(false);
                  await loadPeople();
                } catch {
                  /* 失败由后续操作再报 */
                }
              })();
            }}
          />
        ) : loading ? (
          <div className="lpm-empty">加载中…</div>
        ) : !active ? (
          <div className="lpm-empty">还没有工作表，点底部「＋」新建一个</div>
        ) : active.type === 'log' ? (
          <LogCalendar
            table={active}
            people={people}
            reloadPeople={loadPeople}
            tables={tables}
            // 周高度等写回 config 后同步本地 tables，避免切表再回来读到旧 config（不重新拉接口，免得打断正在编辑的内容）
            onConfigSaved={(cfg) =>
              setTables((prev) => prev.map((t) => (t.id === active.id ? { ...t, config: JSON.stringify(cfg) } : t)))
            }
          />
        ) : active.type === 'project' ? (
          <ProjectPlan table={active} people={people} tables={tables} />
        ) : (
          <PeopleStats people={people} reloadPeople={loadPeople} />
        )}
      </div>

      {/* ── 永久工作表栏 ── */}
      <SheetTabs
        tables={tables}
        activeId={activeId}
        onSelect={(id) => {
          void flush();
          setShowHome(false); // 点底部标签 = 离开开始页，进入该工作表
          setActiveId(id);
        }}
        onNew={() => setNewOpen(true)}
        onRename={(t) => {
          setRenameTarget(t);
          setRenameName(t.name);
        }}
        onDuplicate={handleDuplicate}
        onDelete={handleDelete}
        onExportOne={exportOne}
        onReorder={handleReorder}
      />

      {/* ── 新建工作表 ── */}
      <Modal title="新建工作表" open={newOpen} onOk={handleNew} onCancel={() => setNewOpen(false)} okText="创建" width={380}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input
            placeholder="工作表名称"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onPressEnter={handleNew}
          />
          <Radio.Group value={newType} onChange={(e) => setNewType(e.target.value)}>
            <Radio.Button value="log">日志（周日历 + 待办）</Radio.Button>
            <Radio.Button value="project">项目（任务 + 甘特图）</Radio.Button>
            <Radio.Button value="people">人员（工作量统计）</Radio.Button>
          </Radio.Group>
        </Space>
      </Modal>

      {/* ── 重命名 ── */}
      <Modal
        title="重命名工作表"
        open={!!renameTarget}
        onOk={handleRename}
        onCancel={() => setRenameTarget(null)}
        okText="保存"
        width={360}
      >
        <Input value={renameName} onChange={(e) => setRenameName(e.target.value)} onPressEnter={handleRename} />
      </Modal>

      {/* ── 整库备份结果（2026-10-08 新增：让「备份到哪、有哪些」看得见）── */}
      <Modal
        title="整库备份"
        open={backupOpen}
        onCancel={() => setBackupOpen(false)}
        footer={
          <Button type="primary" onClick={() => setBackupOpen(false)}>
            知道了
          </Button>
        }
        width={560}
      >
        <div className="lpm-bk-ok">
          <CheckCircleOutlined style={{ color: '#217346', marginRight: 6 }} />
          备份成功
        </div>
        <div className="lpm-bk-line">
          <span className="k">本次文件</span>
          <span className="v">{backupInfo.file || '—'}</span>
        </div>
        <div className="lpm-bk-line">
          <span className="k">存放目录</span>
          <span className="v">{backupInfo.dir || '（后端未返回目录；通常在程序目录下的 data\\backups\\）'}</span>
        </div>
        <div className="lpm-bk-tip">
          备份 = 把数据库文件整份复制一份，出问题时可用它整库回滚。只保留最近 20 份，多的自动清掉。
        </div>
        <div className="lpm-bk-list-title">现有备份（{backupInfo.list.length} 份，新的在最上面）</div>
        <div className="lpm-bk-list">
          {backupInfo.list.length === 0 && (
            <div style={{ color: '#aaa', fontSize: 12, padding: 6 }}>（暂无）</div>
          )}
          {backupInfo.list.map((b: any) => (
            <div className="lpm-bk-row" key={b.name}>
              <span className="n">{b.name}</span>
              <span className="s">{fmtSize(b.size)}</span>
              <span className="t">{fmtTime(b.mtime)}</span>
            </div>
          ))}
        </div>
      </Modal>

      <ImportExportModal open={ioOpen} onClose={() => setIoOpen(false)} onDone={() => void loadTables(true)} />
      <HistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} tableId={active?.id} />
    </div>
  );
};

export default Workbench;
