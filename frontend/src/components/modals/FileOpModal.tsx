import { useEffect, useState } from 'react';
import { App as AntdApp, Button, Input, Modal } from 'antd';
import { PhotosApi } from '../../api/photos';
import { StageApi } from '../../api/stage';
import { useAppDispatch } from '../../store';
import { clearSelection } from '../../store/photosSlice';
import type { OpKind, Photo } from '../../types';
import { errorText } from '../../utils/errors';
import { joinSubpath, splitSubpath, subpath } from '../../utils/paths';
import type { StagedSets } from '../../utils/staged';

interface FileOpModalProps {
  open: boolean;
  kind: OpKind | null;
  src: string | null;
  photos: Photo[];
  staged: StagedSets;
  onClose: () => void;
  onStaged: () => void;
}

function folderOptions(photos: Photo[], extra: string[] = []): string[] {
  const set = new Set<string>(['', ...extra]);
  photos.forEach((photo) => set.add((photo.folder || '').trim()));
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export function FileOpModal({ open, kind, src, photos, staged, onClose, onStaged }: FileOpModalProps) {
  const dispatch = useAppDispatch();
  const { message, modal } = AntdApp.useApp();
  const [newName, setNewName] = useState('');
  const [dst, setDst] = useState('');
  const [dstFolder, setDstFolder] = useState('');
  const [folders, setFolders] = useState<string[]>([]);

  const parsed = splitSubpath(src || '');
  const title = kind === 'rename' ? '重命名' : kind === 'move' ? '移动' : kind === 'copy' ? '复制' : '操作';

  useEffect(() => {
    if (!open || !src) return;
    const info = splitSubpath(src);
    setNewName(info.name);
    setDst('');
    setDstFolder(info.folder);
    setFolders(folderOptions(photos));
    if (kind === 'move') {
      let cancelled = false;
      PhotosApi.getFolders()
        .then((list) => {
          if (cancelled) return;
          setFolders(folderOptions(photos, list.map((folder) => String(folder || '').trim())));
        })
        .catch(() => {
          /* fall back to folders derived from the current listing */
        });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, src]);

  const pathExists = (target: string, source: string): boolean => {
    const occupied = photos.some((photo) => {
      const sp = subpath(photo);
      if (sp !== target) return false;
      return sp !== source && !staged.deletes.has(sp);
    });
    return occupied || (staged.targets.has(target) && target !== source);
  };

  const askReplace = (target: string): Promise<boolean> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      modal.confirm({
        title: `目标已存在：${target}`,
        content: '是否替换？',
        okText: '确定',
        cancelText: '取消',
        onOk: () => finish(true),
        onCancel: () => finish(false),
      });
    });

  const commit = async () => {
    if (!kind || !src) return;
    let target = '';
    let replace = false;

    if (kind === 'rename') {
      const name = newName.trim();
      if (!name) {
        message.warning('请输入新文件名');
        return;
      }
      if (name.includes('/') || name.includes('\\')) {
        message.warning('重命名只允许修改文件名，不允许带路径');
        return;
      }
      target = joinSubpath(parsed.folder, name);
      if (target === src) {
        message.warning('新文件名与原文件名相同');
        return;
      }
      if (pathExists(target, src)) {
        if (!(await askReplace(target))) return;
        replace = true;
      }
    } else if (kind === 'move') {
      target = joinSubpath(dstFolder, parsed.name);
      if (target === src) {
        message.warning('目标路径与原路径相同');
        return;
      }
    } else {
      target = dst.trim();
      if (!target) {
        message.warning('请输入目标');
        return;
      }
    }

    try {
      await StageApi.stage({ kind, src, dst: target, replace });
      message.success('已加入分批');
      onClose();
      dispatch(clearSelection());
      onStaged();
    } catch (error) {
      message.error(`加入分批失败: ${errorText(error)}`);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={title}
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="ok" type="primary" onClick={commit}>确定</Button>,
      ]}
      destroyOnHidden
    >
      <div className="modal-field">
        <span className="modal-field-label">原文件:</span>
        <div className="modal-src" style={{ marginBottom: 0 }}>{src}</div>
      </div>

      {kind === 'rename' && (
        <div className="modal-field">
          <span className="modal-field-label">新文件名:</span>
          <Input
            value={newName}
            placeholder="仅文件名，不含路径"
            onChange={(event) => setNewName(event.target.value)}
            onPressEnter={commit}
          />
        </div>
      )}

      {kind === 'move' && (
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
            将移动到: {joinSubpath(dstFolder, parsed.name)}
          </div>
        </div>
      )}

      {kind === 'copy' && (
        <div className="modal-field">
          <span className="modal-field-label">新名称/路径:</span>
          <Input
            value={dst}
            placeholder="新的文件名或路径"
            onChange={(event) => setDst(event.target.value)}
            onPressEnter={commit}
          />
        </div>
      )}
    </Modal>
  );
}
