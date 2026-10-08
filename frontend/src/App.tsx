import React from 'react';
import { ConfigProvider } from 'antd';
import { StyleProvider } from '@ant-design/cssinjs';
import zhCN from 'antd/locale/zh_CN';
import Workbench from './components/Workbench';
import Home from './pages/Home';
import { beaconFlush, flush, listDrafts } from './utils/autosave';
import api from './api';

// ── Error Boundary：白屏时直接把报错吐出来，不让你对着空页面猜 ──
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: any) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20, fontFamily: 'monospace', fontSize: 13, color: '#c00', background: '#fff', minHeight: '100vh' }}>
          <h2 style={{ margin: '0 0 10px' }}>页面崩溃</h2>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{this.state.error.message}</pre>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, color: '#999', marginTop: 8 }}>
            {this.state.error.stack}
          </pre>
          <button
            style={{ marginTop: 14, padding: '6px 14px', cursor: 'pointer' }}
            onClick={() => window.location.reload()}
          >
            刷新重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * 构建版本角标 —— 2026-10-03 加了这一行，起因是用户在真机上反馈「什么都没变」：
 * 光靠嘴上说"已推送"没法自证，于是把版本号直接画在页面右下角，
 * 一句"刷新后右下角有没有这行字"就能判定他跑的是不是最新构建。
 * ⚠️ 每次出构建记得同步改这里。
 */
const BUILD_TAG =
  '构建 V33 · 10-08 日志提醒（单日/每周/每月/每年）+ 待办计入人员工作量 + 积分随待办变动 + 备份可见';

const App: React.FC = () => {
  React.useEffect(() => {
    // ③ 切后台立刻保存
    const onVis = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    // ④ 关页面用 sendBeacon 兜底
    const onUnload = () => beaconFlush();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('beforeunload', onUnload);

    // ⑤ 方案 C3：每 10 秒上报一次心跳（后端 LPM_WATCHDOG=1 时，90 秒无心跳会自动优雅退出）
    const beat = () => {
      api.post('/heartbeat', {}).catch(() => {
        /* 心跳失败不影响使用；后端侧超时才会触发退出 */
      });
    };
    beat();
    const beatTimer = window.setInterval(beat, 10000);

    // 崩溃恢复：上次没同步完的草稿提示一下
    void (async () => {
      const keys = await listDrafts();
      const stale = keys.filter((k) => k.startsWith('draft:'));
      if (stale.length > 0) {
        console.warn('[autosave] 发现未同步草稿：', stale);
      }
    })();

    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('beforeunload', onUnload);
      window.clearInterval(beatTimer);
    };
  }, []);

  return (
    <ErrorBoundary>
      {/*
        🔴 2026-10-05 关键兼容修复（用户那台 Edge 84 / Chromium 84）
        antd 5 默认 hashPriority="low"，会把生成的选择器包一层 :where() 来降低优先级；
        而 :where() 需要 Chrome 88+。Edge 84 不支持 → 整条 CSS 规则被浏览器丢弃，症状：
          ① 表格「测量行」(.ant-table-measure-row) 的隐藏规则失效 → 露出带表头文字的副本，
             看起来就是表格顶部多了一行表头（用户反馈的"计划页面是两行"）；
          ② Modal 关闭动画的样式失效 → 弹窗不关（用户反馈的"点增加页面没有用"）；
          ③ Radio/Select 等控件样式残缺 → 新建页面时看不到类型选项。
        hashPriority="high" 让 antd 不再使用 :where()，老浏览器即可正常渲染。
      */}
      <StyleProvider hashPriority="high">
        <ConfigProvider
          locale={zhCN}
          theme={{
            token: {
              borderRadius: 2,
              fontSize: 13,
              colorPrimary: '#217346',
              colorBorder: '#d9d9d9',
              /*
               * 🔴 2026-10-05 修正（V11）：
               *   V9 曾把 motion 整体关掉（motion:false）来规避"弹窗不关"，
               *   但 motion:false 会让 antd 关闭弹窗时**不再设置 display:none**，
               *   于是关掉的确认框/弹窗仍留在页面上；V9 时它们被 inset 失效推到屏幕外看不见，
               *   V10 修好 inset 后全部暴露 → 页面上叠了一堆残留确认框。
               *   "弹窗不关"的真根因是 :where() 失效（已用 hashPriority="high" 解决），
               *   所以这里恢复 antd 默认动画，关闭逻辑随之恢复正常。
               */
            },
          }}
        >
          <Workbench />
          {/* 构建版本角标：一眼确认浏览器里跑的是不是最新构建 */}
          <div style={{ position: 'fixed', right: 6, bottom: 3, fontSize: 10.5, color: '#a6a6a6', pointerEvents: 'none', zIndex: 9999 }}>
            {BUILD_TAG}
          </div>
        </ConfigProvider>
      </StyleProvider>
    </ErrorBoundary>
  );
};

export default App;
