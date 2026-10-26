import { useEffect, useMemo, useState } from 'react';
import { App as AntdApp, ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { LoadingOverlay } from './components/LoadingOverlay';
import { GalleryPage } from './pages/GalleryPage';
import { useAppSelector } from './store';

export default function App() {
  const themeMode = useAppSelector((state) => state.app.themeMode);
  const [systemDark, setSystemDark] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (themeMode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', themeMode);
  }, [themeMode]);

  const dark = themeMode === 'dark' || (themeMode === 'auto' && systemDark);

  const themeConfig = useMemo(
    () => ({
      algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: dark ? '#6fc7d9' : '#137b8d',
        colorBgElevated: dark ? '#121a1f' : '#ffffff',
        borderRadius: 4,
        fontSize: 12,
      },
    }),
    [dark],
  );

  return (
    <ConfigProvider locale={zhCN} theme={themeConfig}>
      <AntdApp>
        <LoadingOverlay />
        <GalleryPage />
      </AntdApp>
    </ConfigProvider>
  );
}
