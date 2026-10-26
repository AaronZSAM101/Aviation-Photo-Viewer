const HOST = process.env.HOST_IP || '10.88.1.36';
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

const stage = await req('GET', '/api/stage/list');
const trash = await req('GET', '/api/trash/list');
const photos = await req('GET', '/api/photos?sort=date-asc');
const list = JSON.parse(photos.body);
console.log('photos:', list.length);
console.log('stage:', stage.body.slice(0, 500));
console.log('trash:', trash.body.slice(0, 500));
console.log(
  'test files:',
  list.filter((p) => /PARITY|DIAG/.test(p.filename)).map((p) => p.folder + '/' + p.filename),
);
