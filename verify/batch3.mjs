// 批3 定向验证：
//  A. 路径边界：保留目录、符号链接逃逸、暂存/执行两道校验
//  B. 运行时切换照片目录：列表/资源跟随新库、有待处理操作时拒绝切换、缓存写回新库
//  C. 部分扫描失败：不可读子目录必须真正上报，而不是悄悄返回不完整列表
const HOST = process.env.HOST_IP || '127.0.0.1';
const SCAN_HOST = process.env.SCAN_IP || '';
const SCAN_PORT = Number(process.env.SCAN_PORT || 80);
const ROOT = process.env.PHOTOS_ROOT || '/verify-photos';
const LIB = pathJoin(ROOT, 'library');
const LIB2 = pathJoin(ROOT, 'library2');
const OUTSIDE = pathJoin(ROOT, 'outside');
const http = await import('node:http');
const fsp = await import('node:fs/promises');
const path = await import('node:path');

function pathJoin(...parts) {
  return parts.join('/').replace(/\/+/g, '/');
}

// 1x1 白色 JPEG，足够让缩略图/预览/哈希接口有真实图片可读
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
  'base64',
);

function reqTo(host, method, urlPath, body, port = 80) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        host,
        port,
        path: urlPath,
        method,
        headers: data
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
      },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const req = (method, urlPath, body) => reqTo(HOST, method, urlPath, body);
const scanReq = (method, urlPath) => reqTo(SCAN_HOST, method, urlPath, undefined, SCAN_PORT);
const json = (r) => {
  try {
    return JSON.parse(r.body);
  } catch {
    return r.body;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (subpath) => subpath.split('/').map(encodeURIComponent).join('/');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${String(detail).slice(0, 300)}`}`);
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await sleep(500);
  }
}

async function stageCount() {
  return json(await req('GET', '/api/stage/list')).length;
}

async function photoPaths() {
  return (json(await req('GET', '/api/photos?sort=name-asc')) || []).map((p) => `${p.folder}/${p.filename}`);
}

async function clearQueue() {
  await req('POST', '/api/stage/clear');
}

// ── 准备两个库与一个“库外”目录（卷根下的 outside，服务端的 PHOTOS_DIR 是 library）──
await clearQueue();
for (const dir of ['library/PVPaths', 'library2/PVSwitch', 'library/PVSame', 'outside']) {
  await fsp.rm(path.join(ROOT, dir), { recursive: true, force: true });
}
await fsp.mkdir(path.join(LIB, 'PVPaths'), { recursive: true });
await fsp.mkdir(path.join(LIB2, 'PVSwitch'), { recursive: true });
await fsp.mkdir(path.join(LIB, 'PVSame'), { recursive: true });
await fsp.mkdir(path.join(LIB2, 'PVSame'), { recursive: true });
await fsp.mkdir(OUTSIDE, { recursive: true });
await fsp.writeFile(path.join(LIB, 'PVPaths/a.jpg'), JPEG);
await fsp.writeFile(path.join(LIB, 'PVSame/same.jpg'), JPEG);
await fsp.writeFile(path.join(LIB2, 'PVSame/same.jpg'), JPEG);
await fsp.writeFile(path.join(LIB2, 'PVSwitch/b.jpg'), JPEG);
await fsp.writeFile(path.join(OUTSIDE, 'keep.txt'), 'outside');
// 库内符号链接：一个指向库外的目录，一个指向系统文件
await fsp.symlink(OUTSIDE, path.join(LIB, 'PVPaths/escape'));
await fsp.symlink('/etc/passwd', path.join(LIB, 'PVPaths/leak.jpg'));
await req('POST', '/api/cache/refresh');
await sleep(800);

// ── A1：读接口不接受保留目录与符号链接 ─────────────────────────────────────
let r = await req('GET', `/photos/.photo_viewer/meta.json`);
check('cache dir is not downloadable', r.status === 400 || r.status === 403, `${r.status}`);
r = await req('GET', `/photos/.trash/whatever`);
check('trash dir is not downloadable', r.status === 400 || r.status === 403, `${r.status}`);
r = await req('GET', `/photos/PVPaths/leak.jpg`);
check('symlinked file is refused', r.status === 403, `${r.status} ${r.body.slice(0, 80)}`);
r = await req('GET', `/thumb/PVPaths/leak.jpg`);
check('thumb will not follow a symlinked file', r.status === 403, `${r.status}`);
r = await req('GET', `/preview/PVPaths/leak.jpg`);
check('preview will not follow a symlinked file', r.status === 403, `${r.status}`);
r = await req('GET', `/api/hash/PVPaths/leak.jpg`);
check('hash will not follow a symlinked file', r.status === 403, `${r.status}`);
r = await req('GET', `/photos/PVPaths/escape/keep.txt`);
check('symlinked directory cannot escape the library', r.status === 403, `${r.status}`);
r = await req('GET', `/photos/%2e%2e%2foutside%2fkeep.txt`);
check('encoded traversal is rejected', r.status === 400, `${r.status}`);
r = await req('GET', `/api/hash/%40eaDir%2Fthumb.jpg`);
check('reserved @-prefixed dirs are rejected', r.status === 400, `${r.status}`);

// 正常文件仍然可读
r = await req('GET', `/photos/PVPaths/a.jpg`);
check('regular photo still downloads', r.status === 200 && r.body.length > 0, `${r.status}`);
r = await req('GET', `/thumb/PVPaths/a.jpg`);
check('regular photo thumbnail still works', r.status === 200, `${r.status}`);
r = await req('GET', `/preview/PVPaths/a.jpg`);
check('regular photo preview still works', r.status === 200, `${r.status}`);
r = await req('GET', `/api/hash/PVPaths/a.jpg`);
const hashBody = json(r);
check(
  'regular photo hashes',
  r.status === 200 && typeof hashBody.sha256 === 'string' && hashBody.sha256.length === 64,
  `${r.status} ${r.body.slice(0, 80)}`,
);

// ── A2：暂存阶段就拒绝保留目录与非法源 ─────────────────────────────────────
const rejections = [
  ['delete cache file', { kind: 'delete', src: '.photo_viewer/meta.json' }],
  ['move into trash', { kind: 'move', src: 'PVPaths/a.jpg', dst: '.trash/x' }],
  ['copy into @dir', { kind: 'copy', src: 'PVPaths/a.jpg', dst: '@eaDir/x.jpg' }],
  ['restore a normal photo', { kind: 'restore', src: 'PVPaths/a.jpg' }],
  ['restore nested trash name', { kind: 'restore', src: '.trash/a/b' }],
  ['parent traversal', { kind: 'move', src: 'PVPaths/a.jpg', dst: '../outside/x.jpg' }],
];
for (const [label, body] of rejections) {
  r = await req('POST', '/api/stage', body);
  check(`stage rejects ${label}`, r.status === 400, `${r.status} ${r.body.slice(0, 120)}`);
}
check('nothing invalid was queued', (await stageCount()) === 0, `${await stageCount()}`);

// ── A3：预检看到的是真实目标 → 通过符号链接指向的已存在文件也拒绝覆盖 ───────
await fsp.writeFile(path.join(OUTSIDE, 'pre.jpg'), 'precious');
r = await req('POST', '/api/stage', { kind: 'move', src: 'PVPaths/a.jpg', dst: 'PVPaths/escape/pre.jpg' });
check('staging a move through a symlink is accepted (checked at apply)', r.status === 201, `${r.status}`);
r = await req('POST', '/api/stage/apply');
check('apply refuses the symlinked destination', r.status === 409, `${r.status} ${r.body.slice(0, 160)}`);
check('outside file untouched', (await fsp.readFile(path.join(OUTSIDE, 'pre.jpg'), 'utf8')) === 'precious');
check('source still in place', (await fsp.readFile(path.join(LIB, 'PVPaths/a.jpg'))).length === JPEG.length);
await clearQueue();

// ── A4：执行时父目录被换成符号链接（入队后出现的链接）────────────────────
r = await req('POST', '/api/stage', { kind: 'move', src: 'PVPaths/a.jpg', dst: 'PVPaths/laterdir/pwn.jpg' });
check('staging into a not-yet-created folder is accepted', r.status === 201, `${r.status} ${r.body.slice(0, 120)}`);
await fsp.symlink(OUTSIDE, path.join(LIB, 'PVPaths/laterdir'));
r = await req('POST', '/api/stage/apply');
const failed = json(r).failed;
check('apply rejects a parent that became a symlink', r.status === 500, `${r.status} ${r.body.slice(0, 160)}`);
check(
  'failure explains the symlink rejection',
  !!failed && /符号链接/.test(failed.error || ''),
  JSON.stringify(failed),
);
check('nothing was written outside the library', !(await fsp.stat(path.join(OUTSIDE, 'pwn.jpg')).catch(() => null)));
check('source survived the rejection', (await fsp.stat(path.join(LIB, 'PVPaths/a.jpg')).catch(() => null)) !== null);
check('failed op stayed queued', (await stageCount()) === 1, `${await stageCount()}`);
await clearQueue();

// ── A5：合法的新目录仍可创建并写入 ─────────────────────────────────────────
r = await req('POST', '/api/stage', { kind: 'copy', src: 'PVPaths/a.jpg', dst: 'PVPaths/new/sub/copy.jpg' });
r = await req('POST', '/api/stage/apply');
check('a normal nested destination still applies', r.status === 200 && json(r).applied === 1, `${r.status} ${r.body.slice(0, 120)}`);
check('nested copy exists', (await fsp.stat(path.join(LIB, 'PVPaths/new/sub/copy.jpg')).catch(() => null)) !== null);

// ── A6：扫描摘要接口 ───────────────────────────────────────────────────────
r = await req('GET', '/api/scan/status');
const status = json(r);
check(
  'scan status reports a clean scan',
  r.status === 200 && status.at > 0 && status.scanned > 0 && Array.isArray(status.errors) && status.errors.length === 0,
  JSON.stringify(status).slice(0, 160),
);
const listResponse = await req('GET', '/api/photos');
check(
  'list response carries scan headers',
  listResponse.headers['x-scan-errors'] === '0' && listResponse.headers['x-scan-truncated'] === '0',
  JSON.stringify(listResponse.headers),
);

// ── B：运行时切换照片目录 ───────────────────────────────────────────────────
const allow = json(await req('GET', '/api/admin/allow_set_dir'));
check('runtime dir change is allowed in this instance', allow.allowed === true, JSON.stringify(allow));

// 先让当前库的缓存落盘，作为“旧库不再被写”的参照
await waitFor(
  () => fsp.stat(path.join(LIB, '.photo_viewer/meta.json')).catch(() => null),
  100000,
  'library meta cache flush',
);
const oldMetaStat = await fsp.stat(path.join(LIB, '.photo_viewer/meta.json'));
check('old library cache file exists before the switch', oldMetaStat.size > 0, `${oldMetaStat.size}`);

r = await req('POST', '/api/admin/set_photos_dir', { path: LIB2 });
check('switch to the second library succeeds', r.status === 200, `${r.status} ${r.body.slice(0, 120)}`);
let paths = await photoPaths();
check(
  'listing follows the new library',
  paths.includes('PVSwitch/b.jpg') && !paths.includes('PVPaths/a.jpg'),
  paths.join(','),
);
r = await req('GET', `/photos/PVPaths/a.jpg`);
check('old library files stop being served', r.status === 404, `${r.status}`);
r = await req('GET', `/thumb/PVPaths/a.jpg`);
check('old library thumbnails stop being served', r.status === 404, `${r.status}`);
r = await req('GET', `/api/hash/PVPaths/a.jpg`);
check('old library hashes stop being served', r.status === 404, `${r.status}`);
r = await req('GET', `/thumb/PVSwitch/b.jpg`);
check('new library thumbnails work', r.status === 200, `${r.status}`);

// 有待处理操作时切换必须被拒绝，避免相对路径作用到另一个库
r = await req('POST', '/api/stage', { kind: 'delete', src: 'PVSwitch/b.jpg' });
check('a staged op is accepted in the new library', r.status === 201, `${r.status}`);
r = await req('POST', '/api/admin/set_photos_dir', { path: LIB });
check('switching with pending ops is refused', r.status === 409, `${r.status} ${r.body.slice(0, 120)}`);
check('the refused switch kept the library', (await photoPaths()).includes('PVSwitch/b.jpg'));
await clearQueue();

// 缓存必须写到新库，旧库的缓存文件不再变化
await waitFor(
  () => fsp.stat(path.join(LIB2, '.photo_viewer/meta.json')).catch(() => null),
  100000,
  'new library meta cache flush',
);
const newMetaStat = await fsp.stat(path.join(LIB2, '.photo_viewer/meta.json'));
check('new library received the meta cache', newMetaStat.size > 0, `${newMetaStat.size}`);
const oldMetaAfter = await fsp.stat(path.join(LIB, '.photo_viewer/meta.json'));
check(
  'old library cache file was not touched after the switch',
  oldMetaAfter.mtimeMs === oldMetaStat.mtimeMs && oldMetaAfter.size === oldMetaStat.size,
  `${oldMetaStat.mtimeMs}/${oldMetaStat.size} -> ${oldMetaAfter.mtimeMs}/${oldMetaAfter.size}`,
);

r = await req('POST', '/api/admin/set_photos_dir', { path: LIB });
check('switching back succeeds once the queue is empty', r.status === 200, `${r.status} ${r.body.slice(0, 120)}`);
paths = await photoPaths();
check('original library is listed again', paths.includes('PVPaths/a.jpg'), paths.join(','));

// ── C：部分扫描失败必须上报 ────────────────────────────────────────────────
if (SCAN_HOST) {
  r = await scanReq('GET', '/api/photos');
  let scanList = json(r);
  check('unreadable subdir does not hide readable photos', r.status === 200 && Array.isArray(scanList) && scanList.some((p) => p.folder === 'PVScan/ok'), r.body.slice(0, 160));
  check('list response reports the scan error count', Number(r.headers['x-scan-errors']) >= 1, JSON.stringify(r.headers));
  r = await scanReq('GET', '/api/scan/status');
  const scanStatus = json(r);
  check(
    'scan status names the unreadable directory',
    r.status === 200 &&
      Array.isArray(scanStatus.errors) &&
      scanStatus.errors.some((e) => String(e.path).includes('secret')),
    JSON.stringify(scanStatus).slice(0, 240),
  );
  check('scan status is not marked truncated', scanStatus.truncated === false, JSON.stringify(scanStatus.truncated));
  check('scan status counts the readable photo', scanStatus.scanned === 1, JSON.stringify(scanStatus.scanned));
  r = await scanReq('GET', '/thumb/PVScan/ok/a.jpg');
  check('readable photos still get thumbnails', r.status === 200, `${r.status}`);
}

// ── 收尾：清掉测试目录与符号链接（不接触库外真实数据）──────────────────────
await clearQueue();
await req('POST', '/api/admin/set_photos_dir', { path: LIB });
for (const dir of ['PVPaths', 'PVSame']) {
  await fsp.rm(path.join(LIB, dir), { recursive: true, force: true });
}
for (const dir of ['PVSwitch', 'PVSame']) {
  await fsp.rm(path.join(LIB2, dir), { recursive: true, force: true });
}
await fsp.rm(OUTSIDE, { recursive: true, force: true });
await req('POST', '/api/cache/refresh');

const failedChecks = results.filter((res) => !res.ok);
console.log(`\n${results.length - failedChecks.length}/${results.length} batch3 checks passed`);
process.exit(failedChecks.length ? 1 : 0);
