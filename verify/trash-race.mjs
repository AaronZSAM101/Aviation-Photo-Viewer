// 复现：apply 尚未落盘时立刻读回收站列表，映射是否会丢
const HOST = process.env.HOST_IP || '10.88.1.240';
const ROOT = process.env.PHOTOS_ROOT || '/verify-photos';
const http = await import('node:http');
const fsp = await import('node:fs/promises');
const path = await import('node:path');

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { host: HOST, port: 80, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const json = (r) => { try { return JSON.parse(r.body); } catch { return r.body; } };

const DIR = 'PVTrashRace';
await fsp.mkdir(path.join(ROOT, DIR), { recursive: true });

let nullOriginal = 0;
for (let i = 1; i <= 12; i += 1) {
  const name = `v${i}.jpg`;
  await fsp.writeFile(path.join(ROOT, DIR, name), `payload-${i}`);
  await req('POST', '/api/stage/clear');
  await req('POST', '/api/stage', { kind: 'delete', src: `${DIR}/${name}` });
  const apply = await req('POST', '/api/stage/apply');
  // 与 apply 之后的第一次读取同一时刻发生，模拟 parity 里 list_trash 撞上 manifest 写入
  const trash = json(await req('GET', '/api/trash/list'));
  const mine = trash.filter((t) => t.original && t.original.startsWith(DIR));
  const missing = trash.filter((t) => !t.original).length;
  if (!mine.length || missing) nullOriginal += 1;
  console.log(`#${i} apply=${apply.status} items=${trash.length} mapped=${mine.length} unmapped=${missing}`);
}
console.log(`\nrounds with an unmapped or missing trash entry: ${nullOriginal}/12`);
await req('POST', '/api/stage/clear');
await fsp.rm(path.join(ROOT, DIR), { recursive: true, force: true });
const manifestPath = path.join(ROOT, '.trash', '.manifest.json');
const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8').catch(() => '{}'));
const stray = (await req('GET', '/api/trash/list')).body.split('"name":"').length - 1;
console.log(`trash items before cleanup: ${stray}`);
for (const [name, entry] of Object.entries(manifest)) {
  if (entry?.original?.startsWith(DIR)) {
    await fsp.rm(path.join(ROOT, '.trash', name), { force: true });
    delete manifest[name];
  }
}
await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
await req('POST', '/api/cache/refresh');
