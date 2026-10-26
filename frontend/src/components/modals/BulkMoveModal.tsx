import { useEffect, useState } from 'react';
import { App as AntdApp, Button, Modal } from 'antd';
import { PhotosApi } from '../../api/photos';
import { StageApi } from '../../api/stage';
import { useAppDispatch } from '../../store';
import { clearSelection } from '../../store/photosSlice';
import type { Photo } from '../../types';
import { errorText } from '../../utils/errors';
import { joinSubpath, splitSubpath } from '../../utils/paths';

interface BulkMoveModalProps {
  open: boolean;
  photos: Photo[];
  selected: string[];
  onClose: () => void;
  onStaged: () => void;
}

function folderOptions(photos: Photo[], extra: string[] = []): string[] {
  const set = new Set<string>(['', ...extra]);
  photos.forEach((photo) => set.add((photo.folder || '').trim()));
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export function BulkMoveModal({ open, photos, selected, onClose, onStaged }: BulkMoveModalProps) {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();
  const [dstFolder, setDstFolder] = useState('');
  const [folders, setFolders] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setDstFolder('');
    setFolders(folderOptions(photos));
    let cancelled = false;
    PhotosApi.getFolders()
      .then((list) => {
        if (!cancelled) {
          setFolders(folderOptions(photos, list.map((folder) => String(folder || '').trim())));
        }
      })
      .catch(() => {
        /* keep current folders */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const commit = async () => {
    if (!selected.length) {
      message.warning('请先选择要移动的照片');
      return;
    }
    try {
      for (const source of selected) {
        const parsed = splitSubpath(source);
        await StageApi.stage({
          kind: 'move',
          src: source,
          dst: joinSubpath(dstFolder, parsed.name),
        });
      }
      dispatch(clearSelection());
      onStaged();
      message.success('已加入分批（移动）');
      onClose();
    } catch (error) {
      message.error(`批量移动失败: ${errorText(error)}`);
      onStaged();
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="批量移动"
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="ok" type="primary" onClick={commit}>确定</Button>,
      ]}
      destroyOnHidden
    >
      <div className="modal-field">
        <span className="modal-field-label">选中的照片数量:</span>
        <div className="modal-src" style={{ marginBottom: 0 }}>{selected.length} 个照片</div>
      </div>
      <div className="modal-field">
        <span className="modal-field-label">目标文件夹:</span>
        <select
          value={dstFolder}
          onChange={(event) => setDstFolder(event.target.value)}
          style={{ width: '100%', marginBottom: 8 }}
        >
          {folders.map((folder) => (
            <option value={folder} key={folder || '__root__'}>
              {folder || '(根目录)'}
            </option>
          ))}
        </select>
        <div className="modal-path-preview">
          将移动到: {dstFolder || '(根目录)'}
        </div>
      </div>
    </Modal>
  );
}
