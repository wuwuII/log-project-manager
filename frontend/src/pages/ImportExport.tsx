import React, { useState } from 'react';
import { Alert, Button, Modal, Radio, Space, Upload, message } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import api from '../api';
import { flush } from '../utils/autosave';

interface Props {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

/**
 * Excel 导入 —— 前端用 SheetJS 解析成 JSON 再提交，
 * 后端不需要 multipart，少一层依赖和坑。
 */
const ImportExportModal: React.FC<Props> = ({ open, onClose, onDone }) => {
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [parsed, setParsed] = useState<Record<string, any[]> | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);

  const handleFile = async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: false });
      const sheets: Record<string, any[]> = {};
      for (const name of wb.SheetNames) {
        sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '', raw: false });
      }
      setParsed(sheets);
      setFileName(file.name);
      const summary = Object.entries(sheets)
        .map(([k, v]) => `${k}(${v.length})`)
        .join('  ');
      message.success('已解析：' + summary);
    } catch (e: any) {
      message.error('解析失败：' + (e?.message || ''));
    }
    return false;
  };

  const doImport = async () => {
    if (!parsed) return message.warning('请先选择 Excel 文件');
    setBusy(true);
    try {
      await flush();
      const r = await api.post('/import/excel', { mode, sheets: parsed });
      const c = r.data.counts || {};
      message.success(
        `导入完成（${mode === 'replace' ? '清空后导入' : '合并导入'}）：` +
          Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ')
      );
      if (r.data.backup) message.info('导入前已自动备份：' + r.data.backup);
      setParsed(null);
      setFileName('');
      onDone();
      onClose();
    } catch (e: any) {
      message.error(e?.friendlyMessage || '导入失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="从 Excel 导入（复原数据库）"
      open={open}
      onCancel={onClose}
      width={520}
      footer={[
        <Button key="c" onClick={onClose}>
          取消
        </Button>,
        <Button key="ok" type="primary" loading={busy} disabled={!parsed} onClick={doImport}>
          开始导入
        </Button>,
      ]}
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="导入前会自动备份当前数据库文件"
        description="「清空后导入」会删除现有全部数据再写入；「合并导入」按 id 覆盖同一条记录，不动其它数据。"
      />

      <Space direction="vertical" style={{ width: '100%' }}>
        <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}>
          <Radio value="merge">合并导入（推荐）</Radio>
          <Radio value="replace">清空后导入</Radio>
        </Radio.Group>

        <Upload.Dragger beforeUpload={handleFile} showUploadList={false} accept=".xlsx,.xls" maxCount={1}>
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">点这里选择，或把 Excel 拖进来</p>
          <p className="ant-upload-hint">用「导出 Excel」导出的文件可以直接导回来</p>
        </Upload.Dragger>

        {fileName && (
          <div style={{ fontSize: 12, color: '#555' }}>
            已选：<b>{fileName}</b>
            {parsed && (
              <span style={{ marginLeft: 8, color: '#888' }}>
                {Object.entries(parsed).map(([k, v]) => `${k}:${v.length}行`).join(' / ')}
              </span>
            )}
          </div>
        )}
      </Space>
    </Modal>
  );
};

export default ImportExportModal;
