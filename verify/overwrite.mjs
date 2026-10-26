// 批1 定向验证：覆盖语义（默认拒绝覆盖、批次同目标、执行时目标出现、无半成品残留）
// 只跑在 pv-scratch-photos 这个测试卷上，绝不碰真实照片库。
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
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
}

const DIR = 'PVOverwrite';
const p = (name) => path.join(ROOT, DIR, name);
const rel = (name) => `${DIR}/${name}`;

async function readText(file) {
  return fsp.readFile(file, 'utf8').catch(() => null);
}

async function stageListCount() {
  return (await req('GET', '/api/stage/list')).body.split('"id"').length - 1;
}

async function reset() {
  await req('POST', '/api/stage/clear');
  await fsp.rm(path.join(ROOT, DIR), { recursive: true, force: true });
  await fsp.mkdir(path.join(ROOT, DIR), { recursive: true });
  await fsp.writeFile(p('a.jpg'), 'AAA');
  await fsp.writeFile(p('b.jpg'), 'BBB');
  await fsp.writeFile(p('x.jpg'), 'PRECIOUS');
  await req('POST', '/api/cache/refresh');
}

// ── C1/C2：目标已存在 → 拒绝覆盖，操作留在队列，磁盘不动 ──────────────────
await reset();
let r = await req('POST', '/api/stage', { kind: 'move', src: rel('a.jpg'), dst: rel('x.jpg') });
check('stage move onto an existing file is accepted', r.status === 201, `${r.status} ${r.body}`);
r = await req('POST', '/api/stage/apply');
let body = json(r);
check('apply rejects the overwrite (409)', r.status === 409, `${r.status} ${r.body}`);
check(
  '409 names both source and destination',
  Array.isArray(body.conflicts) &&
    body.conflicts.length === 1 &&
    body.conflicts[0].src === rel('a.jpg') &&
    body.conflicts[0].dst === rel('x.jpg') &&
    body.conflicts[0].reason === 'destination-exists',
  JSON.stringify(body),
);
check('rejected op stays in the queue', (await stageListCount()) === 1);
check('destination untouched', (await readText(p('x.jpg'))) === 'PRECIOUS');
check('source untouched', (await readText(p('a.jpg'))) === 'AAA');

// ── C3：批次内两个操作抢一个磁盘上还不存在的目标 ─────────────────────────
await reset();
await req('POST', '/api/stage', { kind: 'move', src: rel('a.jpg'), dst: rel('new.jpg') });
await req('POST', '/api/stage', { kind: 'move', src: rel('b.jpg'), dst: rel('new.jpg') });
r = await req('POST', '/api/stage/apply');
body = json(r);
check('intra-batch same destination is rejected', r.status === 409, `${r.status} ${r.body}`);
check(
  'the second op is reported as batch-same-destination',
  Array.isArray(body.conflicts) &&
    body.conflicts.length === 1 &&
    body.conflicts[0].reason === 'batch-same-destination' &&
    body.conflicts[0].src === rel('b.jpg') &&
    body.conflicts[0].dst === rel('new.jpg'),
  JSON.stringify(body),
);
check('both ops stay in the queue', (await stageListCount()) === 2);
check('nothing moved', (await readText(p('a.jpg'))) === 'AAA' && (await readText(p('b.jpg'))) === 'BBB');
check('the contested destination was never created', (await readText(p('new.jpg'))) === null);

// 两个操作都被挡住时，冲突清单应逐条列出源与目标
await reset();
await req('POST', '/api/stage', { kind: 'move', src: rel('a.jpg'), dst: rel('x.jpg') });
await req('POST', '/api/stage', { kind: 'move', src: rel('b.jpg'), dst: rel('x.jpg') });
r = await req('POST', '/api/stage/apply');
body = json(r);
check(
  'both blocked ops are listed with their own source',
  Array.isArray(body.conflicts) &&
    body.conflicts.length === 2 &&
    body.conflicts.map((c) => c.src).join(',') === `${rel('a.jpg')},${rel('b.jpg')}`,
  JSON.stringify(body),
);

// ── C4：用户确认过的替换仍然可用（分批队列里 replace=true） ────────────────
await reset();
r = await req('POST', '/api/stage', { kind: 'rename', src: rel('a.jpg'), dst: rel('x.jpg'), replace: true });
check('confirmed replacement is accepted at stage time', r.status === 201, `${r.status} ${r.body}`);
r = await req('POST', '/api/stage/apply');
body = json(r);
check('confirmed replacement applies', r.status === 200 && body.applied === 1, `${r.status} ${r.body}`);
check('replaced destination holds the new content', (await readText(p('x.jpg'))) === 'AAA');
check('source is gone', (await readText(p('a.jpg'))) === null);

// ── C5：同批次先删后占同一个路径是合法的 ──────────────────────────────────
await reset();
await req('POST', '/api/stage', { kind: 'delete', src: rel('x.jpg') });
await req('POST', '/api/stage', { kind: 'move', src: rel('a.jpg'), dst: rel('x.jpg') });
r = await req('POST', '/api/stage/apply');
body = json(r);
check('delete-then-move into the vacated path applies', r.status === 200 && body.applied === 2, `${r.status} ${r.body}`);
check('the moved file now owns the path', (await readText(p('x.jpg'))) === 'AAA');
const trash = json(await req('GET', '/api/trash/list'));
const deleted = trash.find((item) => item.original === rel('x.jpg'));
check('the deleted file keeps its trash mapping', !!deleted, JSON.stringify(trash));

// 还原到已存在的路径同样要被拒绝
r = await req('POST', '/api/stage', { kind: 'restore', src: `.trash/${deleted.name}`, dst: rel('x.jpg') });
check('staged restore is accepted', r.status === 201, `${r.status} ${r.body}`);
r = await req('POST', '/api/stage/apply');
body = json(r);
check('restore over an existing file is rejected', r.status === 409, `${r.status} ${r.body}`);
check('restore rejection reports src and dst', body.conflicts?.[0]?.dst === rel('x.jpg'), JSON.stringify(body));
check('restore stays queued and the trash file survives', (await stageListCount()) === 1);

// ── C6：预检通过之后目标才出现 → 执行时的 EEXIST 才是权威 ──────────────────
// 前面塞几个大复制把批次拖长，复制进行中再往目标路径写文件，
// 这样预检看不到目标、执行时却已存在，走的就是 link() 的 EEXIST 分支。
// 固定延时不可靠：整个批次在本卷上不到 200ms，容易在批次结束后才落盘。
// 改成盯住第一张复制结果的落盘点，一出现就立刻写目标——批次自己决定窗口。
const BIG_SIZE = 400 * 1024 * 1024;
const SLOW_COPIES = 12;
let race = null;
await reset();
await fsp.writeFile(p('big.jpg'), Buffer.alloc(BIG_SIZE, 1));
const prefix = [];
for (let i = 1; i <= SLOW_COPIES; i += 1) {
  const dst = rel(`slow-${i}.jpg`);
  prefix.push(dst);
  await req('POST', '/api/stage', { kind: 'copy', src: rel('big.jpg'), dst });
}
await req('POST', '/api/stage', { kind: 'copy', src: rel('b.jpg'), dst: rel('race.jpg') });
const applying = req('POST', '/api/stage/apply');
const planted = await (async () => {
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      await fsp.access(p('slow-1.jpg'));
      break;
    } catch {
      if (Date.now() > deadline) return false;
    }
    await sleep(1);
  }
  // 第一张已落盘，后面的复制还在执行：此时创建目标，预检必然看不到它
  await fsp.writeFile(p('race.jpg'), 'RACE');
  return true;
})();
r = await applying;
body = json(r);
if (planted && r.status === 409 && body.conflicts?.[0]?.error) {
  race = { prefix };
  check('the batch was still running when the destination appeared', true);
} else {
  await req('POST', '/api/stage/clear');
}
check('a destination that appears mid-batch is rejected', !!race, `${r.status} ${r.body}`);
if (race) {
  check(
    'execution-time conflict comes from the filesystem, not the precheck',
    !!body.conflicts[0].error && !body.conflicts[0].reason,
    JSON.stringify(body),
  );
  check(
    'execution-time conflict reports the copy op with src and dst',
    body.conflicts[0].src === rel('b.jpg') &&
      body.conflicts[0].dst === rel('race.jpg') &&
      body.applied === race.prefix.length,
    JSON.stringify(body),
  );
  check('the racing destination content survives', (await readText(p('race.jpg'))) === 'RACE');
  check('earlier completed copies are on disk', (await readText(p('slow-1.jpg'))) !== null);
  check('the conflicting copy stays queued', (await stageListCount()) === 1);
}

// ── C7：失败不留半成品，也不留临时文件 ────────────────────────────────────
async function findTemp(dir) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return out; // 只读/精简卷上可能根本没有缓存目录
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await findTemp(full)));
    } else if (entry.name.endsWith('.pvtmp')) {
      out.push(full);
    }
  }
  return out;
}
const temps = await findTemp(ROOT);
check('no .pvtmp leftovers', temps.length === 0, temps.join(','));
const metaFiles = await findTemp(path.join(ROOT, '.photo_viewer'));
check('no stray temp files in the cache dir', metaFiles.length === 0, metaFiles.join(','));

// ── 收尾：把测试卷恢复原状 ────────────────────────────────────────────────
await req('POST', '/api/stage/clear');
await fsp.rm(path.join(ROOT, DIR), { recursive: true, force: true });
// C5 删掉的文件此刻躺在 .trash 里，且原始路径已随测试目录删除：直接清掉这两处残留
const trashAfter = json(await req('GET', '/api/trash/list'));
const orphans = trashAfter.filter((item) => item.original?.startsWith(`${DIR}/`));
const manifestPath = path.join(ROOT, '.trash', '.manifest.json');
if (orphans.length) {
  for (const item of orphans) {
    await fsp.rm(path.join(ROOT, '.trash', item.name), { force: true });
  }
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8').catch(() => '{}'));
  for (const item of orphans) delete manifest[item.name];
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}
await req('POST', '/api/cache/refresh');

const failed = results.filter((res) => !res.ok);
console.log(`\n${results.length - failed.length}/${results.length} overwrite checks passed`);
process.exit(failed.length ? 1 : 0);
