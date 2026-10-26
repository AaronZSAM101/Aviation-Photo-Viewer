const HOST = process.env.WRITE_IP || '10.88.1.36';
const http = await import('node:http');

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        host: HOST,
        port: 80,
        path,
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

// Anything the parity suite may have left behind; the run tags names with PVxxxxxx.
// Test renames stay on disk under their PVxxxxxx name — restoring them is enough to keep
// the photo count steady, and each run looks up its own TAG so old names are ignored.
const STRAY = /_RENAMED(_UI)?\.jpg$/i;

await req('POST', '/api/stage/clear');

const trash = json(await req('GET', '/api/trash/list'));
for (const item of Array.isArray(trash) ? trash : []) {
  const stage = await req('POST', '/api/stage', {
    kind: 'restore',
    src: `.trash/${item.name}`,
    dst: item.original,
  });
  const applied = await req('POST', '/api/stage/apply');
  console.log('restore', item.original, stage.status, json(applied));
  await req('POST', '/api/stage/clear');
}

await req('POST', '/api/cache/refresh');
const after = json(await req('GET', '/api/photos?sort=date-asc'));
console.log(
  'photos:',
  after.length,
  'stage:',
  JSON.stringify(json(await req('GET', '/api/stage/list'))),
  'trash:',
  JSON.stringify(json(await req('GET', '/api/trash/list'))),
);
console.log(
  'test-named files still on disk:',
  after.filter((p) => STRAY.test(`${p.folder}/${p.filename}`)).map((p) => `${p.folder}/${p.filename}`).join(',') || 'none',
);
console.log('has 40602:', after.some((p) => p.folder === 'Alpha' && p.filename === '40602.jpg'));
