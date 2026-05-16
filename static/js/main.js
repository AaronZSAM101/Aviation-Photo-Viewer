// 入口模块：绑定所有事件，加载首屏数据
import { bindAllEvents } from './events.js';
import { loadPhotos } from './api.js';
import { state } from './state.js';
import { subpath } from './utils.js';
import { openViewer } from './viewer.js';
import { applyRouteStateFromLocation, consumeInitialViewerSubpath, syncRoute } from './router.js';

applyRouteStateFromLocation();
bindAllEvents();

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
