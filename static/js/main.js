// 入口模块：绑定所有事件，加载首屏数据
import { bindAllEvents } from './events.js';
import { loadPhotos } from './api.js';

bindAllEvents();
loadPhotos();
