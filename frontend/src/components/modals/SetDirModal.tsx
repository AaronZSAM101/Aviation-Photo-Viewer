import { useEffect, useState } from 'react';
import { Button, Input, Modal } from 'antd';
import { StageApi } from '../../api/stage';
import { errorText } from '../../utils/errors';

interface SetDirModalProps {
  open: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}

export function SetDirModal({ open, onClose, onChanged }: SetDirModalProps) {
  const [path, setPath] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setMessage('');
  }, [open]);

  const commit = async () => {
    const value = path.trim();
    setMessage('');
    if (!value) {
      setMessage('请输入目录路径');
      return;
    }
    setBusy(true);
    try {
      await StageApi.setPhotosDir(value);
      setMessage('切换成功，正在刷新照片…');
      await onChanged();
      onClose();
    } catch (error) {
      setMessage(`切换失败: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="切换照片目录（仅限管理员）"
      width={520}
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="ok" type="primary" loading={busy} onClick={commit}>切换目录</Button>,
      ]}
      destroyOnHidden
    >
      <p className="modal-hint" style={{ marginBottom: 12 }}>
        注意：该操作仅在服务器启用了运行时目录切换时可用。
      </p>
      <label className="modal-field-label">目录路径（绝对路径）</label>
      <Input
        value={path}
        placeholder="/path/to/photos"
        onChange={(event) => setPath(event.target.value)}
        onPressEnter={commit}
      />
      {message && <div style={{ marginTop: 8, color: 'var(--muted)' }}>{message}</div>}
    </Modal>
  );
}
