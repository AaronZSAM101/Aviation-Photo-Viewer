import { useEffect } from 'react';
import { App as AntdApp, Button, Modal } from 'antd';
import { StageApi } from '../../api/stage';
import { useAppDispatch, useAppSelector } from '../../store';
import { clearSelection, setStagedOps } from '../../store/photosSlice';
import { STAGED_KIND_LABEL } from '../../utils/staged';
import { errorText, stageConflicts } from '../../utils/errors';

interface StagedModalProps {
  open: boolean;
  onClose: () => void;
  onReloadPhotos: () => void;
}

export function StagedModal({ open, onClose, onReloadPhotos }: StagedModalProps) {
  const dispatch = useAppDispatch();
  const { message, modal } = AntdApp.useApp();
  const stagedOps = useAppSelector((state) => state.photos.stagedOps);
  const readOnly = useAppSelector((state) => state.app.readOnly);

  const refresh = async () => {
    try {
      dispatch(setStagedOps(await StageApi.list()));
    } catch {
      dispatch(setStagedOps([]));
    }
  };

  useEffect(() => {
    if (open) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleRemove = async (id: string) => {
    if (readOnly) {
      message.warning('当前为只读模式，管理操作已禁用');
      return;
    }
    try {
      await StageApi.remove(id);
      await refresh();
    } catch (error) {
      message.error(`移除失败: ${errorText(error)}`);
    }
  };

  const handleClear = () => {
    if (readOnly) {
      message.warning('当前为只读模式，管理操作已禁用');
      return;
    }
    modal.confirm({
      title: '清空分批',
      content: '确定清空所有分批操作？',
      okText: '清空',
      cancelText: '取消',
      onOk: async () => {
        try {
          await StageApi.clear();
          dispatch(setStagedOps([]));
          dispatch(clearSelection());
          await refresh();
        } catch (error) {
          message.error(`清空失败: ${errorText(error)}`);
        }
      },
    });
  };

  const handleApply = async () => {
    if (readOnly) {
      message.warning('当前为只读模式，管理操作已禁用');
      return;
    }
    try {
      const result = await StageApi.apply();
      message.success(`应用完成: ${result.applied} 个操作`);
      if (result.pending) {
        message.warning(`还有 ${result.pending} 个操作留在分批队列里`);
      }
      onClose();
      onReloadPhotos();
    } catch (error) {
      const conflicts = stageConflicts(error);
      if (conflicts.length) {
        modal.warning({
          title: `目标已存在，已拒绝覆盖（${conflicts.length} 个操作仍保留在分批）`,
          content: (
            <ul style={{ maxHeight: 220, overflowY: 'auto', paddingLeft: 20, margin: 0 }}>
              {conflicts.map((conflict) => (
                <li key={`${conflict.src}->${conflict.dst ?? ''}`}>
                  {conflict.src} → {conflict.dst}
                </li>
              ))}
            </ul>
          ),
          okText: '知道了',
        });
      } else {
        message.error(`应用失败: ${errorText(error)}`);
      }
      // 中止批次时未完成的操作会退回队列，列表以后端为准
      await refresh();
      onReloadPhotos();
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="分批操作"
      footer={[
        <Button key="close" onClick={onClose}>关闭</Button>,
        <Button key="clear" type="primary" onClick={handleClear}>清空所有</Button>,
        <Button key="apply" type="primary" onClick={handleApply}>应用</Button>,
      ]}
      destroyOnHidden
    >
      <div className="staged-list">
        {stagedOps.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>没有分批操作</p>
        ) : (
          stagedOps.map((op) => (
            <div className="staged-item" key={op.id}>
              <div className="staged-item-info">
                <strong>{STAGED_KIND_LABEL[op.kind] || op.kind}</strong> {op.src}
                {op.dst ? ` → ${op.dst}` : ''}
              </div>
              <div className="staged-item-actions">
                {!readOnly && (
                  <button type="button" onClick={() => handleRemove(op.id)}>删除</button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}
