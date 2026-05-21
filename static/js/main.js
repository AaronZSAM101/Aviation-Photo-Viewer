// 入口模块：绑定所有事件，加载首屏数据
import { bindAllEvents } from './events.js';
import { loadPhotos, allowRuntimeDirChange, setPhotosDir, selectPhotosDirWithTauri } from './api.js';
import { state } from './state.js';
import { subpath } from './utils.js';
import { openViewer } from './viewer.js';
import { applyRouteStateFromLocation, consumeInitialViewerSubpath, syncRoute } from './router.js';
import { initTheme } from './theme.js';

applyRouteStateFromLocation();
initTheme();
bindAllEvents();

// 管理界面：目录切换
document.getElementById('btn-admin-setdir').addEventListener('click', async () => {
  const ok = await allowRuntimeDirChange();
  if (!ok) {
    alert('服务器未启用运行时目录切换');
    return;
  }
  // 如果在 Tauri 环境中，优先使用本地文件选择器
  try {
    const p = await selectPhotosDirWithTauri();
    if (p) {
      document.getElementById('setdir-msg').textContent = '正在切换到：' + p;
      await setPhotosDir(p);
      await loadPhotos();
      return;
    }
  } catch (e) {
    // ignore and fallback to modal
  }

  document.getElementById('modal-setdir').classList.add('show');
});

document.getElementById('btn-commit-setdir').addEventListener('click', async () => {
  const path = document.getElementById('setdir-path').value.trim();
  const msg = document.getElementById('setdir-msg');
  msg.textContent = '';
  if (!path) { msg.textContent = '请输入目录路径'; return; }
  try {
    await setPhotosDir(path);
    msg.textContent = '切换成功，正在刷新照片…';
    await loadPhotos();
    document.getElementById('modal-setdir').classList.remove('show');
  } catch (e) {
    msg.textContent = '切换失败: ' + e.message;
  }
});

loadPhotos().then(() => {
  const sp = consumeInitialViewerSubpath();
  if (!sp) return;

  const idx = state.filteredPhotos.findIndex(p => subpath(p) === sp);
  if (idx >= 0) {
    openViewer(idx);
  } else {
    syncRoute();
  }
});
