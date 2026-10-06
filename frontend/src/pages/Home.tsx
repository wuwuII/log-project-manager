import React, { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Input, List, Modal, Space, Spin, Tag, Tooltip, message } from 'antd';
import {
  AppstoreOutlined,
  DeleteOutlined,
  FileAddOutlined,
  FolderOpenOutlined,
  LoginOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import api from '../api';
import RecycleBin from './RecycleBin';

/**
 * 开始页（工程/文件管理）—— 2026-10-03 新增，对应用户原话：
 *   「我可以关闭或者打开读取某些文件，打开这个整个文件的这个页面，
 *     类似一个软件的初始页面嘛，比如打开某个工程，打开之后它之前存储的这个全都在里面」
 *
 * 概念：**一个工程 = 一个 .db 文件**。「打开工程」= 把后端切到那个库；
 *      「新建工程」= 复制一份空结构的新库；「另存为」= 把当前库整份复制出去（= 全部保存）。
 */

interface FileInfo {
  path: string;
  dir: string;
  name: string;
  size: number;
  mtime: string;
  counts?: { logs: number; todos: number; tasks: number; projects: number; people: number; tables: number };
  readable?: boolean;
}

interface Props {
  /** 点「进入当前工程」→ 切到工作表工作台 */
  onEnter: () => void;
}

function fmtSize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function fmtTime(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const Home: React.FC<Props> = ({ onEnter }) => {
  const [loading, setLoading] = useState(true);
  const [cur, setCur] = useState<FileInfo | null>(null);
  const [recent, setRecent] = useState<FileInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [recycleOpen, setRecycleOpen] = useState(false);
  const [recycleCount, setRecycleCount] = useState(0);

  // 打开/新建/另存 的目录浏览弹窗
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseMode, setBrowseMode] = useState<'open' | 'new' | 'saveas'>('open');
  const [browseDir, setBrowseDir] = useState('');
  const [browseDirs, setBrowseDirs] = useState<{ name: string; path: string }[]>([]);
  const [browseDbs, setBrowseDbs] = useState<FileInfo[]>([]);
  const [newName, setNewName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, rs] = await Promise.all([
        api.get('/workspace'),
        // 回收站角标：与 /workspace 并行拉，失败不阻断开始页
        api.get('/recycle/summary').catch(() => null),
      ]);
      setCur(r.data.current);
      setRecent(r.data.recent || []);
      if (rs) setRecycleCount(rs.data?.total ?? 0);
    } catch (e: any) {
      // 方案 C3：工程文件缺失（原位置的 .db 被改名/挪走）→ 明确提示，绝不静默建空库
      if (e?.response?.status === 409 && e?.response?.data?.error === 'project_file_missing') {
        message.warning('工程文件没找到，请选一下新位置');
      } else {
        message.error('读取工程信息失败：' + (e?.friendlyMessage || e?.message || ''));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const browse = useCallback(async (dir?: string) => {
    try {
      const r = await api.get('/workspace/browse', { params: dir ? { dir } : {} });
      setBrowseDir(r.data.dir);
      setBrowseDirs(r.data.dirs || []);
      setBrowseDbs(r.data.dbs || []);
    } catch (e: any) {
      message.error(e?.friendlyMessage || e?.response?.data?.error || '打开目录失败');
    }
  }, []);

  const openBrowse = async (mode: 'open' | 'new' | 'saveas') => {
    setBrowseMode(mode);
    setNewName('');
    setBrowseOpen(true);
    await browse(cur?.dir);
  };

  const doOpen = async (p: string) => {
    setBusy(true);
    try {
      await api.post('/workspace/open', { path: p });
      setBrowseOpen(false);
      message.success('已打开工程，正在载入…');
      await load();
      onEnter();
    } catch (e: any) {
      message.error(e?.response?.data?.error || e?.friendlyMessage || '打开失败');
    } finally {
      setBusy(false);
    }
  };

  const doNew = async () => {
    if (!newName.trim()) return message.warning('请填写工程名称');
    setBusy(true);
    try {
      const r = await api.post('/workspace/new', { dir: browseDir, name: newName.trim() });
      setBrowseOpen(false);
      message.success('新工程已创建：' + r.data.path.split('\\').pop());
      await load();
      onEnter();
    } catch (e: any) {
      message.error(e?.response?.data?.error || e?.friendlyMessage || '新建失败');
    } finally {
      setBusy(false);
    }
  };

  const doSaveAs = async () => {
    setBusy(true);
    try {
      const r = await api.post('/workspace/save-as', { dir: browseDir, name: newName.trim() || undefined });
      setBrowseOpen(false);
      message.success(`已另存为 ${r.data.name}（${fmtSize(r.data.size)}）`);
      await load();
    } catch (e: any) {
      message.error(e?.response?.data?.error || e?.friendlyMessage || '另存失败');
    } finally {
      setBusy(false);
    }
  };

  const c = cur?.counts;

  return (
    <div className="lpm-home">
      <div className="lpm-home-inner">
        <div className="lpm-home-title">
          <AppstoreOutlined style={{ fontSize: 22, color: '#217346', marginRight: 8 }} />
          日志与项目管理
          <span className="lpm-home-sub">打开或新建一个工程</span>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <Spin />
          </div>
        ) : (
          <>
            {/* ── 当前工程 ── */}
            <div className="lpm-home-card">
              <div className="lpm-home-card-head">
                <span className="lpm-home-card-title">当前工程</span>
                {cur?.readable === false && <Tag color="red">库结构异常</Tag>}
              </div>
              <div className="lpm-home-name">{cur?.name || '（未找到）'}</div>
              <div className="lpm-home-kv">
                <span>位置</span>
                <Tooltip title={cur?.path}>
                  <b className="lpm-ellip">{cur?.dir || '—'}</b>
                </Tooltip>
              </div>
              <div className="lpm-home-kv">
                <span>大小</span>
                <b>{cur ? fmtSize(cur.size) : '—'}</b>
              </div>
              <div className="lpm-home-kv">
                <span>最后修改</span>
                <b>{fmtTime(cur?.mtime || null)}</b>
              </div>
              <div className="lpm-home-kv">
                <span>里面有什么</span>
                <b>
                  {c ? (
                    <>
                      工作表 {c.tables} · 日志 {c.logs} 条 · 待办 {c.todos} 条 · 任务 {c.tasks} 个 · 人员 {c.people} 人
                    </>
                  ) : (
                    '—'
                  )}
                </b>
              </div>

              <Space style={{ marginTop: 14 }} wrap>
                <Button type="primary" size="large" icon={<LoginOutlined />} onClick={onEnter}>
                  进入这个工程
                </Button>
                <Button size="large" icon={<FolderOpenOutlined />} onClick={() => void openBrowse('open')}>
                  打开已有工程
                </Button>
                <Button size="large" icon={<FileAddOutlined />} onClick={() => void openBrowse('new')}>
                  新建工程
                </Button>
                <Button size="large" icon={<SaveOutlined />} onClick={() => void openBrowse('saveas')}>
                  全部保存（另存一份）
                </Button>
                <Button size="large" icon={<DeleteOutlined />} onClick={() => setRecycleOpen(true)}>
                  回收站{recycleCount > 0 ? ` (${recycleCount})` : ''}
                </Button>
              </Space>
            </div>

            {/* ── 最近打开的工程 ── */}
            <div className="lpm-home-card">
              <div className="lpm-home-card-head">
                <span className="lpm-home-card-title">最近打开</span>
              </div>
              {recent.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有别的工程" />
              ) : (
                <List
                  size="small"
                  dataSource={recent}
                  renderItem={(it) => (
                    <List.Item
                      actions={[
                        <Button key="o" size="small" type="link" onClick={() => void doOpen(it.path)}>
                          打开
                        </Button>,
                      ]}
                    >
                      <List.Item.Meta
                        title={it.name}
                        description={`${it.dir} · ${fmtSize(it.size)} · ${fmtTime(it.mtime)}`}
                      />
                    </List.Item>
                  )}
                />
              )}
            </div>

            <div className="lpm-home-tip">
              数据全部存在本机**一个文件**里（就是上面这个 .db）。想备份或换电脑，直接拷这个文件即可。
            </div>
          </>
        )}
      </div>

      {/* ── 选目录 / 选文件 ── */}
      <Modal
        open={browseOpen}
        title={browseMode === 'open' ? '打开已有工程' : browseMode === 'new' ? '新建工程' : '全部保存（另存为）'}
        onCancel={() => setBrowseOpen(false)}
        width={640}
        footer={
          browseMode === 'open'
            ? null
            : [
                <Button key="c" onClick={() => setBrowseOpen(false)}>
                  取消
                </Button>,
                <Button key="k" type="primary" loading={busy} onClick={browseMode === 'new' ? doNew : doSaveAs}
                  disabled={browseMode === 'new' && !newName.trim()}>
                  {browseMode === 'new' ? '创建' : '保存到这里'}
                </Button>,
              ]
        }
      >
        {browseMode !== 'open' && (
          <div style={{ marginBottom: 10 }}>
            <Input
              placeholder={browseMode === 'new' ? '工程名称（会存成 名称.db）' : '文件名（留空＝自动带时间戳）'}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
        )}
        <div className="lpm-home-path">
          <Button size="small" onClick={() => void browse(browseDirs.length || browseDbs.length ? browseDir : '')} type="link">
            当前位置
          </Button>
          <b className="lpm-ellip">{browseDir}</b>
          <Button size="small" onClick={() => void browse(browseDir.replace(/[\\/][^\\/]*$/, '') || browseDir)}>
            上一级
          </Button>
        </div>
        <div className="lpm-home-browse">
          {browseDirs.map((d) => (
            <div key={d.path} className="lpm-home-row" onClick={() => void browse(d.path)}>
              <FolderOpenOutlined style={{ color: '#d4a017', marginRight: 6 }} />
              {d.name}
            </div>
          ))}
          {browseDbs.map((f) => (
            <div key={f.path} className="lpm-home-row lpm-home-row-db" onClick={() => (browseMode === 'open' ? void doOpen(f.path) : setNewName(f.name))}>
              <AppstoreOutlined style={{ color: '#217346', marginRight: 6 }} />
              <span style={{ flex: 1 }}>{f.name}</span>
              <span className="lpm-home-meta">{fmtSize(f.size)} · {fmtTime(f.mtime)}</span>
            </div>
          ))}
          {browseDirs.length === 0 && browseDbs.length === 0 && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个目录里没有子目录和 .db 文件" />
          )}
        </div>
      </Modal>

      {/* 回收站：onChanged 重拉 /workspace + /recycle/summary → 角标同步 */}
      <RecycleBin open={recycleOpen} onClose={() => setRecycleOpen(false)} onChanged={() => void load()} />
    </div>
  );
};

export default Home;
