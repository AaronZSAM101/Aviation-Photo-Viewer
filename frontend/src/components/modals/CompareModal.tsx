import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, Select } from 'antd';
import { CompareApi } from '../../api/compare';
import type {
  CompareResult,
  Photo,
  SimilarJob,
  SimilarPair,
  SimilarScanParams,
  SimilarityTone,
} from '../../types';
import { errorText } from '../../utils/errors';
import { encodePath, previewUrl, subpath } from '../../utils/paths';

interface CompareModalProps {
  open: boolean;
  photos: Photo[];
  selected: string[];
  onClose: () => void;
}

interface PairInfo {
  a: Photo;
  b: Photo;
  aPath: string;
  bPath: string;
}

const THRESHOLD_OPTIONS = [
  { value: 3, label: '严格：几乎一样' },
  { value: 5, label: '标准：推荐' },
  { value: 10, label: '宽松：可能相似' },
];

const LIMIT_OPTIONS = [
  { value: 20, label: '20 组' },
  { value: 50, label: '50 组' },
  { value: 100, label: '100 组' },
  { value: 200, label: '200 组' },
];

const MAX_OPTIONS = [
  { value: 500, label: '500 张' },
  { value: 2000, label: '2000 张' },
  { value: 5000, label: '5000 张' },
  { value: 10000, label: '10000 张' },
];

function similarityLabel(distance: number): { label: string; tone: SimilarityTone } {
  if (distance === 0) return { label: '感知完全一致', tone: 'same' };
  if (distance <= 5) return { label: '非常相似', tone: 'high' };
  if (distance <= 10) return { label: '可能相似', tone: 'medium' };
  return { label: '差异较大', tone: 'low' };
}

function resultLabel(result: { verdict_label?: string; tone?: SimilarityTone; phash_dist?: number }) {
  const fallback = similarityLabel(Number(result.phash_dist));
  return {
    label: result.verdict_label || fallback.label,
    tone: result.tone || fallback.tone,
  };
}

function metricValue(value: number | undefined, suffix = ''): string {
  const number = Number(value);
  return Number.isFinite(number) ? `${number}${suffix}` : '—';
}

function hashPrefix(value: string | undefined): string {
  if (!value) return '—';
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function photoForPath(photos: Photo[], path: string): Photo | null {
  return photos.find((photo) => subpath(photo) === path) || null;
}

function imageUrlForPath(photos: Photo[], path: string): string {
  const photo = photoForPath(photos, path);
  return photo ? previewUrl(photo) : `/thumb/${encodePath(path)}`;
}

function ComparePhoto({ photos, path }: { photos: Photo[]; path: string }) {
  const photo = photoForPath(photos, path);
  const name = photo ? photo.filename : path.split('/').pop();
  return (
    <div className="compare-photo">
      <div className="compare-thumb">
        <img src={imageUrlForPath(photos, path)} alt={name || path} />
      </div>
      <div className="compare-name" title={path}>{name}</div>
      <div className="compare-path">{path}</div>
    </div>
  );
}

function CompareReasons({ reasons }: { reasons?: string[] }) {
  if (!Array.isArray(reasons) || !reasons.length) return null;
  return (
    <div className="compare-reasons">
      {reasons.map((reason) => (
        <span key={reason}>{reason}</span>
      ))}
    </div>
  );
}

export function CompareModal({ open, photos, selected, onClose }: CompareModalProps) {
  const [threshold, setThreshold] = useState(5);
  const [limit, setLimit] = useState(50);
  const [maxPhotos, setMaxPhotos] = useState(2000);
  const [pairLoading, setPairLoading] = useState(false);
  const [pairResult, setPairResult] = useState<CompareResult | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [scanStatus, setScanStatus] = useState<'idle' | 'creating' | 'running' | 'done' | 'error'>('idle');
  const [scanJob, setScanJob] = useState<SimilarJob | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanActive, setScanActive] = useState(false);
  const pairTokenRef = useRef(0);
  const scanTokenRef = useRef(0);

  const pair = useMemo<PairInfo | null>(() => {
    if (selected.length !== 2) return null;
    const a = photoForPath(photos, selected[0]);
    const b = photoForPath(photos, selected[1]);
    if (!a || !b) return null;
    return { a, b, aPath: selected[0], bPath: selected[1] };
  }, [photos, selected]);

  const pairKey = pair ? `${pair.aPath}\n${pair.bPath}` : '';

  const runPairCompare = async (target: PairInfo) => {
    const token = ++pairTokenRef.current;
    setPairLoading(true);
    setPairResult(null);
    setPairError(null);
    try {
      const result = await CompareApi.compare(target.aPath, target.bPath);
      if (pairTokenRef.current !== token) return;
      setPairResult(result);
    } catch (error) {
      if (pairTokenRef.current !== token) return;
      setPairError(errorText(error, '对比失败'));
    } finally {
      if (pairTokenRef.current === token) setPairLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setPairResult(null);
    setPairError(null);
    setPairLoading(false);
    setScanStatus('idle');
    setScanJob(null);
    setScanError(null);
    setScanActive(false);
    if (pair) void runPairCompare(pair);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pairKey]);

  useEffect(() => {
    if (open) return;
    pairTokenRef.current += 1;
    scanTokenRef.current += 1;
    setScanActive(false);
    setPairLoading(false);
  }, [open]);

  useEffect(
    () => () => {
      pairTokenRef.current += 1;
      scanTokenRef.current += 1;
    },
    [],
  );

  const runSimilarityScan = async () => {
    const token = ++scanTokenRef.current;
    setScanActive(true);
    setScanStatus('creating');
    setScanError(null);
    setScanJob(null);
    const params: SimilarScanParams = {
      threshold: Math.max(0, Math.min(16, threshold)),
      limit: Math.max(1, Math.min(500, limit)),
      max_photos: Math.max(2, Math.min(10000, maxPhotos)),
    };
    try {
      const job = await CompareApi.startSimilarScan(params);
      if (scanTokenRef.current !== token) return;
      if (!job.id) throw new Error('扫描任务创建失败');
      setScanJob(job);
      setScanStatus('running');
      for (;;) {
        if (scanTokenRef.current !== token) return;
        const data = await CompareApi.getSimilarJob(job.id);
        if (scanTokenRef.current !== token) return;
        setScanJob(data);
        if (data.status === 'done') {
          setScanStatus('done');
          setScanActive(false);
          return;
        }
        if (data.status === 'error') {
          throw new Error(data.error || '扫描失败');
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      if (scanTokenRef.current !== token) return;
      setScanStatus('error');
      setScanError(errorText(error, '扫描失败'));
      setScanActive(false);
    }
  };

  const close = () => {
    pairTokenRef.current += 1;
    scanTokenRef.current += 1;
    setScanActive(false);
    onClose();
  };

  const verdict = pairResult ? resultLabel(pairResult) : null;
  const sameFile = !!pairResult && pairResult.sha_a === pairResult.sha_b;
  const scanPercent = (() => {
    if (!scanJob) return 0;
    const total = Number(scanJob.total) || Number(scanJob.scanned) || 0;
    const processed = Number(scanJob.processed) || Number(scanJob.hashed) || 0;
    return total ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  })();

  const renderPairSection = () => {
    if (!pair) return null;
    return (
      <>
        <div className="compare-grid">
          <ComparePhoto photos={photos} path={pair.aPath} />
          <ComparePhoto photos={photos} path={pair.bPath} />
        </div>
        {pairLoading && (
          <div className="compare-summary">
            <div className="compare-status">正在计算相似度…</div>
          </div>
        )}
        {pairError && (
          <div className="compare-summary">
            <div className="compare-status error">{pairError}</div>
          </div>
        )}
        {pairResult && verdict && (
          <div className="compare-summary">
            <div className={`compare-verdict ${verdict.tone}`}>
              {sameFile ? '文件内容完全相同' : verdict.label}
            </div>
            <CompareReasons reasons={pairResult.reasons} />
            <div className="compare-metrics">
              <div className="compare-metric">
                <span>综合可信度</span>
                <strong>{metricValue(pairResult.score, '%')}</strong>
              </div>
              <div className="compare-metric">
                <span>轮廓/边缘差异</span>
                <strong>{metricValue(pairResult.dhash_dist)} / 64</strong>
              </div>
              <div className="compare-metric">
                <span>明暗结构差异</span>
                <strong>{metricValue(pairResult.ahash_dist ?? pairResult.phash_dist)} / 64</strong>
              </div>
              <div className="compare-metric">
                <span>颜色差异</span>
                <strong>{metricValue(pairResult.color_dist)}</strong>
              </div>
              <div className="compare-metric">
                <span>画幅差异</span>
                <strong>{metricValue(pairResult.aspect_dist)}</strong>
              </div>
              <div className="compare-metric">
                <span>SHA256</span>
                <strong>{sameFile ? '一致' : '不同'}</strong>
              </div>
            </div>
            <div className="compare-hashes">
              <div>
                <span>A</span>
                <code title={pairResult.sha_a}>{hashPrefix(pairResult.sha_a)}</code>
              </div>
              <div>
                <span>B</span>
                <code title={pairResult.sha_b}>{hashPrefix(pairResult.sha_b)}</code>
              </div>
            </div>
          </div>
        )}
      </>
    );
  };

  const renderScanSection = () => {
    if (scanStatus === 'idle') return null;
    if (scanStatus === 'creating') {
      return (
        <div className="compare-summary">
          <div className="compare-status">正在创建扫描任务…</div>
        </div>
      );
    }
    if (scanStatus === 'error') {
      return (
        <div className="compare-summary">
          <div className="compare-status error">{scanError || '扫描失败'}</div>
        </div>
      );
    }
    if (scanStatus === 'running' && scanJob) {
      const pairs = Array.isArray(scanJob.pairs) ? scanJob.pairs.length : 0;
      const total = Number(scanJob.total) || Number(scanJob.scanned) || 0;
      const processed = Number(scanJob.processed) || Number(scanJob.hashed) || 0;
      return (
        <div className="compare-summary">
          <div className="compare-scan-head">正在扫描当前挂载目录… {scanPercent}%</div>
          <div className="compare-progress" aria-label="扫描进度">
            <div style={{ width: `${scanPercent}%` }} />
          </div>
          <div className="compare-note">
            已处理 {processed} / {total || '—'} 张，其中 {Number(scanJob.cached) || 0} 张来自缓存，
            成功计算 {Number(scanJob.hashed) || 0} 张，已找到 {pairs} 组。
          </div>
        </div>
      );
    }
    if (scanStatus === 'done' && scanJob) {
      const pairs = Array.isArray(scanJob.pairs) ? scanJob.pairs : [];
      return (
        <>
          <div className="compare-summary">
            <div className="compare-scan-head">
              扫描 {scanJob.scanned ?? 0} 张，成功计算 {scanJob.hashed ?? 0} 张，找到 {pairs.length} 组
            </div>
            {scanJob.truncated && (
              <div className="compare-note">
                照片数量超过扫描上限，本次只扫描前 {scanJob.max_photos} 张。
              </div>
            )}
            {!!scanJob.unreadable && (
              <div className="compare-note">{scanJob.unreadable} 张图片无法读取，已跳过。</div>
            )}
          </div>
          <div className="similar-list">
            {pairs.length ? (
              pairs.map((similarPair: SimilarPair) => {
                const similarity = resultLabel(similarPair);
                return (
                  <div className="similar-pair" key={`${similarPair.a}\n${similarPair.b}`}>
                    <div className="similar-pair-photos">
                      <ComparePhoto photos={photos} path={similarPair.a} />
                      <ComparePhoto photos={photos} path={similarPair.b} />
                    </div>
                    <div className="similar-pair-meta">
                      <span className={similarity.tone}>{similarity.label}</span>
                      <strong>{metricValue(similarPair.score, '%')}</strong>
                    </div>
                    <CompareReasons reasons={similarPair.reasons} />
                    <div className="compare-note">
                      边缘 {metricValue(similarPair.dhash_dist)}/64 · 明暗{' '}
                      {metricValue(similarPair.ahash_dist ?? similarPair.phash_dist)}/64 · 颜色{' '}
                      {metricValue(similarPair.color_dist)} · 画幅 {metricValue(similarPair.aspect_dist)}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="compare-status">没有找到符合阈值的相似照片。</div>
            )}
          </div>
        </>
      );
    }
    return null;
  };

  return (
    <Modal
      open={open}
      onCancel={close}
      title="相似照片对比"
      width={920}
      className="compare-modal"
      footer={<Button onClick={close}>关闭</Button>}
      destroyOnHidden
    >
      <div className="compare-actions">
        <div className="compare-action-block">
          <h3>手动对比</h3>
          <p>{pair ? '已选中两张照片，可以直接对比。' : '先在照片列表中选中两张照片，再打开本面板。'}</p>
          <Button
            type="primary"
            disabled={!pair || pairLoading}
            onClick={() => pair && runPairCompare(pair)}
          >
            对比选中的两张
          </Button>
        </div>
        <div className="compare-action-block">
          <h3>扫描当前挂载目录</h3>
          <p>
            自动在当前照片目录里找可能重复或很像的照片。照片很多时会比较耗时，可以先用默认设置试一次。
          </p>
          <div className="compare-scan-controls">
            <label>
              相似程度
              <Select
                size="small"
                value={threshold}
                options={THRESHOLD_OPTIONS}
                onChange={setThreshold}
              />
            </label>
            <label>
              最多显示
              <Select size="small" value={limit} options={LIMIT_OPTIONS} onChange={setLimit} />
            </label>
            <label>
              最多扫描
              <Select size="small" value={maxPhotos} options={MAX_OPTIONS} onChange={setMaxPhotos} />
            </label>
          </div>
          <Button type="primary" loading={scanActive} onClick={runSimilarityScan}>
            扫描当前目录
          </Button>
        </div>
      </div>
      <div id="compare-result">
        {renderPairSection()}
        {renderScanSection()}
      </div>
    </Modal>
  );
}
