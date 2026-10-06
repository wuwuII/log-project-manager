/**
 * 保存状态 + 「立即保存」—— 方案 C3 第 4 块（右上角）
 *
 * 三种状态（右上角一眼可辨）：
 *   已保存 ✓        （绿）
 *   保存中…          （黄）
 *   有改动未保存      （橙）
 *   （另有 保存失败，将自动重试 → 红）
 *
 * 「立即保存」：强制把 autosave 的待写队列全部推到服务端；
 * 成功后明确提示「全部已保存，可以安全关闭页面」。
 *
 * 老浏览器（Edge 84 / Chromium 84）注意：
 *   · 只用普通 DOM + 普通 CSS（无动画/过渡），样式见 index.css 的 `.lpm-save-*` 段；
 *   · 不使用 `inset:` / `:where()` / `:is()` 等新语法；
 *   · 提示用项目现有 antd `message`（不做自建 toast）。
 */
import React from 'react';
import { message } from 'antd';
import { flushAll, onSaveState, type SaveState } from '../utils/autosave';

function labelFor(s: SaveState): { text: string; cls: string } {
  switch (s) {
    case 'saving':
      return { text: '保存中…', cls: 'saving' };
    case 'dirty':
      return { text: '有改动未保存', cls: 'dirty' };
    case 'error':
      return { text: '保存失败，将自动重试', cls: 'error' };
    case 'saved':
      return { text: '已保存 ✓', cls: 'saved' };
    default:
      return { text: '已保存 ✓', cls: 'saved' };
  }
}

const SaveStatus: React.FC = () => {
  const [state, setState] = React.useState<SaveState>('idle');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => onSaveState(setState), []);

  const doSave = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await flushAll();
      if (r.ok) {
        message.success('全部已保存，可以安全关闭页面');
      } else {
        message.warning(`还有 ${r.pending} 项没保存成功，请稍后重试`);
      }
    } catch (e: any) {
      message.error('保存失败：' + (e?.friendlyMessage || e?.message || ''));
    } finally {
      setBusy(false);
    }
  };

  const { text, cls } = labelFor(state);

  return (
    <span className={'lpm-save-box ' + cls} title="页面每 0.5 秒自动保存；这里可以强制立即保存">
      <span className="lpm-save-dot" />
      <span className="lpm-save-text">{text}</span>
      <button type="button" className="lpm-save-btn" disabled={busy} onClick={doSave}>
        {busy ? '保存中…' : '立即保存'}
      </button>
    </span>
  );
};

export default SaveStatus;
