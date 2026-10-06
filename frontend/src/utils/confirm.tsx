import * as React from 'react';
import ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';

/**
 * 🔴 2026-10-05 替换 antd 的 `Modal.confirm`
 *
 * 为什么弃用 Modal.confirm（实测事故）：
 *   用户机是 Edge 84（Chromium 84），antd 5 的 Modal 关闭靠 rc-motion 等 transitionend 事件。
 *   在老浏览器上这个离场动画不会触发 → 弹窗**永远不会从 DOM 里移除** →
 *   留下一层全屏的 `.ant-modal-wrap` + `.ant-modal-mask` 盖在页面上，
 *   把鼠标点击全部吃掉。表现为「点了删除之后整个页面卡死、点什么都没反应」
 *   （JS 主线程其实正常，所以从控制台看不出任何报错，非常难查）。
 *
 * 这个自建确认框：
 *   - 只用一个受控 React 组件 + 普通 CSS，没有任何动画/过渡 → 关闭就是真正 unmount + 移除节点
 *   - 遮罩只覆盖全屏但不依赖任何库的定位（用 top/left/right/bottom，不用 Chromium 87+ 才支持的 inset）
 *   - 点遮罩=取消；处理中禁用按钮防重复点击
 *
 * 用法（跟 Modal.confirm 基本一样）：
 *   confirmDialog({ title:'删除任务', content:'确定删除「xxx」？', okText:'删除', danger:true,
 *                   onOk: async () => { await api.delete(...); } });
 */

export interface ConfirmOptions {
  title: string;
  content: React.ReactNode;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
  onOk: () => void | Promise<void>;
  /** 2026-10-06 新增：取消（点「取消」按钮或遮罩）时回调。
   *  进度滑块 0/100 弹窗要用它把滑块弹回原值 —— 取消=什么都没发生。 */
  onCancel?: () => void;
}

const CF_CSS = `
.lpm-cf-mask{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:2000;
  display:flex;align-items:flex-start;justify-content:center;padding:110px 16px 16px;box-sizing:border-box;overflow:auto;}
.lpm-cf-box{width:420px;max-width:100%;background:#fff;border-radius:8px;
  box-shadow:0 8px 28px rgba(0,0,0,.22);padding:20px 24px 16px;}
.lpm-cf-title{font-size:16px;font-weight:600;color:rgba(0,0,0,.88);margin-bottom:10px;}
.lpm-cf-body{font-size:14px;color:rgba(0,0,0,.65);line-height:1.6;margin-bottom:18px;word-break:break-all;}
.lpm-cf-btns{display:flex;justify-content:flex-end;gap:8px;}
.lpm-cf-btn{min-width:72px;height:32px;padding:0 12px;border-radius:6px;border:1px solid #d9d9d9;
  background:#fff;color:rgba(0,0,0,.88);cursor:pointer;font-size:14px;line-height:1;}
.lpm-cf-btn:disabled{opacity:.6;cursor:not-allowed;}
.lpm-cf-ok{background:#1677ff;border-color:#1677ff;color:#fff;}
.lpm-cf-danger{background:#ff4d4f;border-color:#ff4d4f;color:#fff;}
`;

function ensureCss() {
  if (document.getElementById('lpm-confirm-css')) return;
  const s = document.createElement('style');
  s.id = 'lpm-confirm-css';
  s.textContent = CF_CSS;
  document.head.appendChild(s);
}

export function confirmDialog(opts: ConfirmOptions) {
  ensureCss();
  const host = document.createElement('div');
  host.setAttribute('data-lpm-confirm', '1');
  document.body.appendChild(host);

  let closed = false;
  const close = (confirmed = false) => {
    if (closed) return;
    closed = true;
    if (!confirmed && opts.onCancel) {
      try {
        opts.onCancel();
      } catch (e) {
        /* ignore */
      }
    }
    try {
      if (root) root.unmount();
      else (ReactDOM as any).unmountComponentAtNode(host);
    } catch (e) {
      /* ignore */
    }
    try {
      host.remove();
    } catch (e) {
      /* ignore */
    }
  };

  const Comp: React.FC = () => {
    const [busy, setBusy] = React.useState(false);
    return (
      <div className="lpm-cf-mask" onClick={() => { if (!busy) close(); }}>
        <div className="lpm-cf-box" onClick={(e) => e.stopPropagation()}>
          <div className="lpm-cf-title">{opts.title}</div>
          <div className="lpm-cf-body">{opts.content}</div>
          <div className="lpm-cf-btns">
            <button
              type="button"
              className="lpm-cf-btn"
              disabled={busy}
              onClick={() => { if (!busy) close(); }}
            >
              {opts.cancelText || '取 消'}
            </button>
            <button
              type="button"
              className={'lpm-cf-btn lpm-cf-ok' + (opts.danger ? ' lpm-cf-danger' : '')}
              disabled={busy}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                try {
                  await opts.onOk();
                } catch (e) {
                  // 出错也要把确认框关掉，绝不留下挡住页面的层
                  // eslint-disable-next-line no-console
                  console.error('[LPM] confirmDialog onOk 出错:', e);
                } finally {
                  close(true);
                }
              }}
            >
              {busy ? '处理中…' : (opts.okText || '确 定')}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const root: any = (ReactDOMClient as any).createRoot ? (ReactDOMClient as any).createRoot(host) : null;
  if (root) root.render(<Comp />);
  else (ReactDOM as any).render(<Comp />, host);

  return { close };
}

export default confirmDialog;
