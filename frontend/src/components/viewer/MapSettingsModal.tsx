import { useEffect, useState } from 'react';
import { App as AntdApp, Button, Input, Modal, Select } from 'antd';
import type { GpsCustomSource, GpsMapSettings, GpsSource } from '../../types';
import {
  GPS_BUILTIN_SOURCE_MAP,
  GPS_BUILTIN_SOURCES,
  GPS_MAP_DEFAULTS,
  activeGpsMapSource,
  clampGpsMapZoom,
  customProviderId,
  customSourceId,
  gpsMapSourceByProvider,
  gpsMapSourceByProviderWithList,
  normalizeCustomSource,
} from '../../utils/gps';

interface MapSettingsModalProps {
  open: boolean;
  settings: GpsMapSettings;
  onClose: () => void;
  onChange: (settings: GpsMapSettings) => void;
}

type AnySource = GpsSource | GpsCustomSource;

function nextCustomSourceId(sources: GpsCustomSource[]): string {
  let i = sources.length + 1;
  let id = `custom-${i}`;
  const existing = new Set(sources.map((source) => source.id));
  while (existing.has(id)) {
    i += 1;
    id = `custom-${i}`;
  }
  return id;
}

export function MapSettingsModal({ open, settings, onClose, onChange }: MapSettingsModalProps) {
  const { message } = AntdApp.useApp();
  const [provider, setProvider] = useState(settings.provider);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('');
  const [key, setKey] = useState('');
  const [subdomains, setSubdomains] = useState('');
  const [maxZoom, setMaxZoom] = useState('20');
  const [newName, setNewName] = useState('');
  const [deleteDisabled, setDeleteDisabled] = useState(true);

  const applyFields = (source: AnySource | null | undefined) => {
    setName(source?.name || '');
    setTemplate(source?.template || '');
    setKey(source?.key || '');
    setSubdomains(source?.subdomains || '');
    setMaxZoom(String(source?.maxZoom || 20));
  };

  const fillFrom = (providerValue: string, sourceSettings: GpsMapSettings) => {
    applyFields(gpsMapSourceByProvider(providerValue, sourceSettings));
    setDeleteDisabled(!customSourceId(providerValue));
  };

  useEffect(() => {
    if (!open) return;
    setProvider(settings.provider);
    fillFrom(settings.provider, settings);
    setNewName('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const fullCustomSource = (id: string, fallbackName: string): GpsCustomSource | null =>
    normalizeCustomSource(
      {
        id,
        name: name.trim() || fallbackName,
        template: template.trim(),
        key: key.trim(),
        subdomains: subdomains.trim(),
        maxZoom: maxZoom.trim() || 20,
      },
      id,
    );

  const save = () => {
    let nextSettings: GpsMapSettings = {
      ...settings,
      customSources: [...settings.customSources],
      sourceKeys: { ...(settings.sourceKeys || {}) },
    };
    let currentProvider = provider || GPS_MAP_DEFAULTS.provider;
    const customId = customSourceId(currentProvider);
    if (customId) {
      const source = fullCustomSource(customId, '自定义图源');
      if (!source) {
        message.warning('请填写自定义图源 URL 模板');
        return;
      }
      const index = nextSettings.customSources.findIndex((item) => item.id === source.id);
      if (index >= 0) nextSettings.customSources[index] = source;
      else nextSettings.customSources.push(source);
      currentProvider = customProviderId(source.id);
    } else if (GPS_BUILTIN_SOURCE_MAP.has(currentProvider)) {
      nextSettings.sourceKeys[currentProvider] = key.trim();
    }
    nextSettings.provider = gpsMapSourceByProviderWithList(
      currentProvider,
      nextSettings.customSources,
    )
      ? currentProvider
      : GPS_MAP_DEFAULTS.provider;
    nextSettings.zoom = clampGpsMapZoom(
      nextSettings.zoom,
      gpsMapSourceByProvider(nextSettings.provider, nextSettings) || undefined,
    );
    onChange(nextSettings);
    onClose();
  };

  const addSource = () => {
    const id = nextCustomSourceId(settings.customSources);
    const source = fullCustomSource(id, newName.trim() || name.trim() || '自定义图源');
    if (!source) {
      message.warning('请填写自定义图源 URL 模板');
      return;
    }
    const customSources = [...settings.customSources];
    const index = customSources.findIndex((item) => item.id === source.id);
    if (index >= 0) customSources[index] = source;
    else customSources.push(source);
    const nextProvider = customProviderId(source.id);
    const nextSettings: GpsMapSettings = {
      ...settings,
      customSources,
      provider: nextProvider,
      zoom: clampGpsMapZoom(settings.zoom, source),
    };
    onChange(nextSettings);
    setProvider(nextProvider);
    applyFields(source);
    setDeleteDisabled(false);
    setNewName('');
  };

  const deleteSource = () => {
    const id = customSourceId(provider);
    if (!id) return;
    const customSources = settings.customSources.filter((source) => source.id !== id);
    const nextSettings: GpsMapSettings = {
      ...settings,
      customSources,
      provider: settings.provider,
    };
    if (settings.provider === customProviderId(id)) {
      nextSettings.provider = GPS_MAP_DEFAULTS.provider;
      nextSettings.zoom = clampGpsMapZoom(settings.zoom, activeGpsMapSource(nextSettings));
    }
    onChange(nextSettings);
    setProvider(nextSettings.provider);
    fillFrom(nextSettings.provider, nextSettings);
    setNewName('');
  };

  const resetAll = () => {
    const nextSettings: GpsMapSettings = {
      provider: GPS_MAP_DEFAULTS.provider,
      zoom: GPS_MAP_DEFAULTS.zoom,
      customSources: [],
      sourceKeys: {},
    };
    onChange(nextSettings);
    setProvider(nextSettings.provider);
    fillFrom(nextSettings.provider, nextSettings);
    setNewName('');
  };

  const options = [
    {
      label: '内置图源',
      options: GPS_BUILTIN_SOURCES.map((source) => ({ value: source.id, label: source.name })),
    },
    {
      label: '自定义图源',
      options: settings.customSources.length
        ? settings.customSources.map((source) => ({
            value: customProviderId(source.id),
            label: source.name,
          }))
        : [{ value: '', label: '暂无自定义图源', disabled: true }],
    },
  ];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="地图图源"
      width={620}
      footer={[
        <Button key="delete" danger disabled={deleteDisabled} onClick={deleteSource}>
          删除自定义
        </Button>,
        <Button key="reset" onClick={resetAll}>重置全部</Button>,
        <Button key="add" onClick={addSource}>新增自定义</Button>,
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="save" type="primary" onClick={save}>保存</Button>,
      ]}
      destroyOnHidden
    >
      <label className="map-settings-field">
        <span>当前图源</span>
        <Select
          value={provider}
          options={options}
          onChange={(value: string) => {
            setProvider(value);
            fillFrom(value, settings);
          }}
        />
      </label>
      <label className="map-settings-field">
        <span>图源名称</span>
        <Input
          value={name}
          placeholder="例如：我的卫星图"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="map-settings-field">
        <span>URL 模板</span>
        <Input
          value={template}
          placeholder="https://example.com/tiles/{z}/{x}/{y}.jpg?key={key}"
          onChange={(event) => setTemplate(event.target.value)}
        />
      </label>
      <div className="map-settings-row">
        <label className="map-settings-field">
          <span>Key</span>
          <Input
            value={key}
            placeholder="可留空"
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <label className="map-settings-field">
          <span>子域</span>
          <Input
            value={subdomains}
            placeholder="如 0,1,2,3 或 a,b,c"
            onChange={(event) => setSubdomains(event.target.value)}
          />
        </label>
        <label className="map-settings-field">
          <span>最大缩放</span>
          <Input
            value={maxZoom}
            placeholder="1-20"
            onChange={(event) => setMaxZoom(event.target.value)}
          />
        </label>
      </div>
      <div className="map-settings-help">支持占位符：{'{z} {x} {y} {q} {s} {key}'}</div>
      <label className="map-settings-field">
        <span>新增图源名称</span>
        <Input
          value={newName}
          placeholder="新增时使用，例如：天地图-我的Key"
          onChange={(event) => setNewName(event.target.value)}
        />
      </label>
    </Modal>
  );
}
