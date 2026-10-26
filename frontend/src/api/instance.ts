import axios from 'axios';
import { CONFIG } from '../config';

declare module 'axios' {
  interface AxiosRequestConfig {
    _skipGlobalError?: boolean;
  }
}

const request = axios.create({
  baseURL: CONFIG.BACKEND_URL,
  timeout: 60000,
});

request.interceptors.request.use((config) => {
  // 与旧版 fetch(cache:'no-store') 对齐：API 响应不套用启发式缓存
  if ((config.method ?? 'get').toLowerCase() === 'get' && config.headers) {
    config.headers.set('Cache-Control', 'no-cache');
    config.headers.set('Pragma', 'no-cache');
  }
  return config;
});

request.interceptors.response.use(
  (response) => response,
  (error) => {
    if (axios.isCancel(error)) return Promise.reject(error);
    if (!error.config?._skipGlobalError) {
      const data = error.response?.data;
      const text = typeof data === 'string' && data.trim() ? data : null;
      console.warn(text || error.response?.data?.message || error.message || '请求失败');
    }
    return Promise.reject(error);
  },
);

export default request;
