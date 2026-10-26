// 批2 定向验证：只读实例的查询不写盘，且回收站列表照常可用（不迁移、不改名）
const HOST = process.env.HOST_IP || '127.0.0.1';
const ROOT = process.env.PHOTOS_ROOT || '/verify-photos';
const http = await import('node:http');
const fsp = await import('node:fs/promises');
const path = await import('node:path');

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        host: HOST,
        port: 80,
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

const json = (r) => {
  try {
    return JSON.parse(r.body);
  } catch {
    return r.body;
  }
};
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
}

const DIR = 'PVReadOnly';
const LEGACY = 'Alpha_Old.jpg-00000000-0000-0000-0000-000000000000';

async function snapshot() {
  const out = [];
  async function walk(dir, prefix) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(`${relPath}/`);
        await walk(full, relPath);
      } else {
        const stat = await fsp.stat(full);
        out.push(`${relPath}|${stat.size}|${stat.mtimeMs}`);
      }
    }
  }
  await walk(ROOT, '');
  return out;
}

// 夹具由测试自己准备（应用本身不该写入任何东西）
await fsp.rm(path.join(ROOT, DIR), { recursive: true, force: true });
await fsp.rm(path.join(ROOT, '.trash'), { recursive: true, force: true });
await fsp.rm(path.join(ROOT, '.photo_viewer'), { recursive: true, force: true });
await fsp.mkdir(path.join(ROOT, DIR), { recursive: true });
await fsp.mkdir(path.join(ROOT, '.trash'), { recursive: true });
await fsp.writeFile(path.join(ROOT, DIR, 'ro.jpg'), 'RO');
await fsp.writeFile(path.join(ROOT, '.trash', LEGACY), 'P');

const before = await snapshot();

const config = await req('GET', '/api/config');
check('config loads in read-only mode', config.status === 200 && json(config).readOnly === true, `${config.status} ${config.body}`);

const photos = await req('GET', '/api/photos?sort=date-asc');
check(
  'the photo list is served in read-only mode',
  photos.status === 200 && Array.isArray(json(photos)) && json(photos).some((x) => x.filename === 'ro.jpg'),
  `${photos.status} ${String(photos.body).slice(0, 160)}`,
);

for (const urlPath of [
  '/api/folders',
  `/thumb/${encodeURI(`${DIR}/ro.jpg`)}`,
  `/preview/${encodeURI(`${DIR}/ro.jpg`)}`,
  `/photos/${encodeURI(`${DIR}/ro.jpg`)}`,
  `/api/hash/${encodeURI(`${DIR}/ro.jpg`)}`,
]) {
  const r = await req('GET', urlPath);
  // 夹具不是真正的图片，解码类接口返回 422 属于预期；关键是没有 5xx、也没有写盘
  check(`GET ${urlPath.split('?')[0]} is served`, r.status === 200 || r.status === 422, `${r.status} ${String(r.body).slice(0, 120)}`);
}

const trash = await req('GET', '/api/trash/list');
const items = json(trash);
check('trash still lists items without migrating', trash.status === 200 && Array.isArray(items) && items.some((x) => x.name === LEGACY), `${trash.status} ${trash.body}`);
check('the legacy name was not renamed', (await fsp.readdir(path.join(ROOT, '.trash'))).includes(LEGACY));
check(
  'read-only GET did not create a manifest',
  !(await fsp.readdir(path.join(ROOT, '.trash'))).includes('.manifest.json'),
);

const stageWrite = await req('POST', '/api/stage', { kind: 'delete', src: `${DIR}/ro.jpg` });
check('staging is refused in read-only mode', stageWrite.status === 403, `${stageWrite.status}`);
const applyWrite = await req('POST', '/api/stage/apply');
check('applying is refused in read-only mode', applyWrite.status === 403, `${applyWrite.status}`);

const after = await snapshot();
const added = after.filter((x) => !before.includes(x));
const removed = before.filter((x) => !after.includes(x));
check(
  'no query wrote to the photos volume',
  added.length === 0 && removed.length === 0,
  `added=${JSON.stringify(added.slice(0, 8))} removed=${JSON.stringify(removed.slice(0, 8))}`,
);

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} read-only checks passed`);
process.exit(failed.length ? 1 : 0);
