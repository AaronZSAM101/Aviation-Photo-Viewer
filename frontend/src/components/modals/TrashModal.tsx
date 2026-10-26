import { useEffect, useState } from 'react';
import { App as AntdApp, Button, Modal } from 'antd';
import { StageApi } from '../../api/stage';
import { useAppSelector } from '../../store';
import type { TrashItem } from '../../types';
import { errorText } from '../../utils/errors';

interface TrashModalProps {
  open: boolean;
  onClose: () => void;
}

export function TrashModal({ open, onClose }: TrashModalProps) {
  const { message } = AntdApp.useApp();
  const readOnly = useAppSelector((state) => state.app.readOnly);
  const [items, setItems] = useState<TrashItem[]>([]);

  const refresh = async () => {
    try {
      setItems(await StageApi.listTrash());
    } catch {
      setItems([]);
    }
  };

  useEffect(() => {
    if (open) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleRestore = async (item: TrashItem) => {
    if (readOnly) {
      message.warning('当前为只读模式，管理操作已禁用');
      return;
    }
    try {
      await StageApi.stage({
        kind: 'restore',
        src: `.trash/${item.name}`,
        ...(item.original ? { dst: item.original } : {}),
      });
      message.success('已加入分批（恢复）');
      await refresh();
    } catch (error) {
      message.error(`恢复失败: ${errorText(error)}`);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="回收站"
      footer={<Button onClick={onClose}>关闭</Button>}
      destroyOnHidden
    >
      <div className="trash-list">
        {items.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>回收站为空</p>
        ) : (
          items.map((item) => (
            <div className="trash-item" key={item.name}>
              <div className="trash-item-name" title={item.name}>
                {item.original || item.name}
              </div>
              <div className="trash-item-actions">
                {!readOnly && (
                  <button type="button" onClick={() => handleRestore(item)}>恢复</button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}
