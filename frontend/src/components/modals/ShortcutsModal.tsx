import { Button, Modal } from 'antd';
import type { ReactNode } from 'react';

interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

export function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={760}
      title="快捷键提示"
      footer={<Button onClick={onClose}>关闭</Button>}
      destroyOnHidden
    >
      <div className="shortcut-grid">
        <section className="shortcut-group">
          <h3 className="shortcut-group-title">浏览器卡片</h3>
          <div className="shortcut-list">
            <div className="shortcut-row">
              <div className="shortcut-keys"><Kbd>点击</Kbd></div>
              <div className="shortcut-desc">打开查看器</div>
            </div>
            <div className="shortcut-row">
              <div className="shortcut-keys"><Kbd>点击</Kbd> <Kbd>复选框</Kbd></div>
              <div className="shortcut-desc">切换选中</div>
            </div>
            <div className="shortcut-row">
              <div className="shortcut-keys">
                <Kbd>Ctrl</Kbd><span className="kbd-sep">/</span><Kbd>⌘</Kbd>
                <span className="kbd-sep">+</span><Kbd>点击</Kbd>
              </div>
              <div className="shortcut-desc">追加 / 取消选中</div>
            </div>
            <div className="shortcut-row">
              <div className="shortcut-keys">
                <Kbd>Shift</Kbd><span className="kbd-sep">+</span><Kbd>点击</Kbd>
              </div>
              <div className="shortcut-desc">范围选中</div>
            </div>
            <div className="shortcut-row">
              <div className="shortcut-keys"><Kbd>右键</Kbd></div>
              <div className="shortcut-desc">打开操作菜单</div>
            </div>
          </div>
        </section>

        <section className="shortcut-group">
          <h3 className="shortcut-group-title">查看器</h3>
          <div className="shortcut-list">
            <div className="shortcut-row">
              <div className="shortcut-keys"><Kbd>Esc</Kbd></div>
              <div className="shortcut-desc">关闭查看器</div>
            </div>
            <div className="shortcut-row">
              <div className="shortcut-keys"><Kbd>←</Kbd> <Kbd>→</Kbd></div>
              <div className="shortcut-desc">上一张 / 下一张</div>
            </div>
            <div className="shortcut-row">
              <div className="shortcut-keys"><Kbd>E</Kbd></div>
              <div className="shortcut-desc">检查污点（直方图均衡）</div>
            </div>
            <div className="shortcut-row">
              <div className="shortcut-keys"><Kbd>G</Kbd></div>
              <div className="shortcut-desc">居中网格</div>
            </div>
            <div className="shortcut-row">
              <div className="shortcut-keys"><Kbd>F</Kbd></div>
              <div className="shortcut-desc">地平线 / 细网格</div>
            </div>
            <div className="shortcut-row">
              <div className="shortcut-keys"><Kbd>R</Kbd></div>
              <div className="shortcut-desc">RGB 直方图</div>
            </div>
            <div className="shortcut-row">
              <div className="shortcut-keys"><Kbd>H</Kbd></div>
              <div className="shortcut-desc">亮度直方图</div>
            </div>
            <div className="shortcut-row">
              <div className="shortcut-keys"><Kbd>I</Kbd></div>
              <div className="shortcut-desc">EXIF 信息面板</div>
            </div>
            <div className="shortcut-row">
              <div className="shortcut-keys"><Kbd>D</Kbd></div>
              <div className="shortcut-desc">加入待删除 / 取消</div>
            </div>
            <div className="shortcut-row">
              <div className="shortcut-keys"><Kbd>F1</Kbd></div>
              <div className="shortcut-desc">打开本面板</div>
            </div>
          </div>
        </section>
      </div>
    </Modal>
  );
}
