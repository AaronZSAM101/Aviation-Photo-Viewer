// 批2 定向验证：批次结果逐条上报、manifest 写失败不丢文件、陈旧映射自愈、并发 apply 不丢映射
// 只跑在测试卷上，绝不碰真实照片库。
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
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
}

const DIR = 'PVBatch2';
const TRASH = path.join(ROOT, '.trash');
const MANIFEST = path.join(TRASH, '.manifest.json');
const p = (name) => path.join(ROOT, DIR, name);
const rel = (name) => `${DIR}/${name}`;

const readText = (file) => fsp.readFile(file, 'utf8').catch(() => null);
const readManifest = () => readText(MANIFEST).then((t) => (t ? JSON.parse(t) : {}));
const trashFiles = () =>
  fsp
    .readdir(TRASH)
    .then((names) => names.filter((n) => /^[0-9a-f]{32}$/.test(n)).sort())
    .catch(() => []);
const queue = () => req('GET', '/api/stage/list').then((r) => json(r));
const trash = () => req('GET', '/api/trash/list').then((r) => json(r));

async function reset() {
  await req('POST', '/api/stage/clear');
  await fsp.rm(path.join(ROOT, DIR), { recursive: true, force: true });
  // 每个用例从空回收站开始，避免上一段留下的文件干扰计数
  await fsp.rm(TRASH, { recursive: true, force: true });
  await fsp.mkdir(path.join(ROOT, DIR), { recursive: true });
  await fsp.writeFile(p('a.jpg'), 'AAA');
  await fsp.writeFile(p('b.jpg'), 'BBB');
  await fsp.writeFile(p('c.jpg'), 'CCC');
  await req('POST', '/api/cache/refresh');
}

// ── T1：每个操作的结局逐条返回，pending 反映真实剩余 ─────────────────────
await reset();
await req('POST', '/api/stage', { kind: 'delete', src: rel('a.jpg') });
await req('POST', '/api/stage', { kind: 'copy', src: rel('b.jpg'), dst: rel('b-copy.jpg') });
let r = await req('POST', '/api/stage/apply');
let body = json(r);
check('a mixed batch applies cleanly', r.status === 200 && body.applied === 2, `${r.status} ${r.body}`);
check(
  'every operation reports its own outcome',
  Array.isArray(body.results) &&
    body.results.length === 2 &&
    body.results.every((x) => x.status === 'applied' && x.id && x.kind && x.src),
  JSON.stringify(body.results),
);
check('pending is zero after a clean batch', body.pending === 0, JSON.stringify(body.pending));
check('the copy landed and the delete left the library', (await readText(p('b-copy.jpg'))) === 'BBB' && (await readText(p('a.jpg'))) === null);

// ── T2：manifest 写不进去时，文件不动、操作留在队列 ───────────────────────
await reset();
await fsp.mkdir(TRASH, { recursive: true });
await fsp.rm(MANIFEST, { force: true });
await fsp.mkdir(MANIFEST, { recursive: true }); // 同名目录让原子写必然失败
await req('POST', '/api/stage', { kind: 'delete', src: rel('a.jpg') });
r = await req('POST', '/api/stage/apply');
body = json(r);
check('apply reports a failed manifest write as an error', r.status === 500, `${r.status} ${r.body}`);
check(
  'the failed operation is reported as failed',
  body.failed?.kind === 'delete' && body.results?.[0]?.status === 'failed' && !!body.results?.[0]?.error,
  JSON.stringify(body),
);
check('the rejected delete stays queued', body.pending === 1 && (await queue()).length === 1, `${body.pending}`);
check('the file never left the library', (await readText(p('a.jpg'))) === 'AAA');
check('nothing was placed in the trash', (await trashFiles()).length === 0, JSON.stringify(await trashFiles()));
const strays = (await fsp.readdir(TRASH)).filter((n) => n.endsWith('.tmp'));
check('no temp manifest files are left behind', strays.length === 0, JSON.stringify(strays));

// 修复 manifest 之后，同一个操作可以直接重试
await fsp.rmdir(MANIFEST);
r = await req('POST', '/api/stage/apply');
body = json(r);
const mapped = await readManifest();
const names = await trashFiles();
check(
  'the retry succeeds once the manifest is writable',
  r.status === 200 && body.applied === 1 && names.length === 1 && mapped[names[0]]?.original === rel('a.jpg'),
  `${r.status} ${r.body} ${JSON.stringify(mapped)}`,
);

// ── T3：陈旧映射（有映射没文件）在可写实例的列表里被清掉 ─────────────────
const ghost = 'deadbeefdeadbeefdeadbeefdeadbeef';
await fsp.writeFile(
  MANIFEST,
  JSON.stringify({ ...mapped, [ghost]: { original: 'Ghost/x.jpg' } }, null, 2),
);
const listed = await trash();
const afterList = await readManifest();
check(
  'a mapping without a trash file is not listed',
  Array.isArray(listed) && !listed.some((x) => x.name === ghost),
  JSON.stringify(listed),
);
check('the stale mapping is dropped from disk', !(ghost in afterList), JSON.stringify(afterList));

// ── T4：并发 apply 不丢映射 ──────────────────────────────────────────────
await reset();
const victims = ['a.jpg', 'b.jpg', 'c.jpg'];
for (const name of victims) {
  await req('POST', '/api/stage', { kind: 'delete', src: rel(name) });
}
const [first, second] = await Promise.all([
  req('POST', '/api/stage/apply'),
  req('POST', '/api/stage/apply'),
]);
const totalApplied = [first, second].reduce((sum, x) => sum + (json(x).applied || 0), 0);
const after = await readManifest();
const files = await trashFiles();
check('two concurrent applies still apply the batch', totalApplied === 3, `${first.body} | ${second.body}`);
check('every deleted file is in the trash', files.length === 3, JSON.stringify(files));
check(
  'every trash file has its original path on disk',
  files.every((name) => after[name]?.original?.startsWith(`${DIR}/`)),
  JSON.stringify(after),
);
const postQueue = await queue();
check('the queue is empty afterwards', postQueue.length === 0, JSON.stringify(postQueue));

await req('POST', '/api/stage/clear');
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} batch2 checks passed`);
process.exit(failed.length ? 1 : 0);
