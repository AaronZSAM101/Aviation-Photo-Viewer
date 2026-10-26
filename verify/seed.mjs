// 给可写测试卷铺一份最小照片集（9 张有效 JPEG，两个目录），仅用于 parity 的写操作流程
const HOST = process.env.WRITE_IP || '127.0.0.1';
const ROOT = process.env.PHOTOS_ROOT || '/verify-photos';
const http = await import('node:http');
const fsp = await import('node:fs/promises');
const path = await import('node:path');

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: HOST, port: 80, path: urlPath, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
  'base64',
);

await req('POST', '/api/stage/clear');
await fsp.rm(path.join(ROOT, 'ParitySeed'), { recursive: true, force: true });
await fsp.rm(path.join(ROOT, 'ParitySeed2'), { recursive: true, force: true });
await fsp.rm(path.join(ROOT, '.trash'), { recursive: true, force: true });
await fsp.mkdir(path.join(ROOT, 'ParitySeed'), { recursive: true });
await fsp.mkdir(path.join(ROOT, 'ParitySeed2'), { recursive: true });
const names = ['P1.jpg', 'P2.jpg', 'P3.jpg', 'P4.jpg', 'P5.jpg', 'P6.jpg'];
for (const [i, name] of names.entries()) {
  const file = path.join(ROOT, 'ParitySeed', name);
  await fsp.writeFile(file, JPEG);
  const t = new Date(Date.UTC(2024, 0, 1 + i, 12, 0, 0));
  await fsp.utimes(file, t, t);
}
for (const name of ['Q1.jpg', 'Q2.jpg', 'Q3.jpg']) {
  const file = path.join(ROOT, 'ParitySeed2', name);
  await fsp.writeFile(file, JPEG);
  const t = new Date(Date.UTC(2024, 1, 1, 12, 0, 0));
  await fsp.utimes(file, t, t);
}

await req('POST', '/api/cache/refresh');
const list = JSON.parse((await req('GET', '/api/photos?sort=date-asc')).body);
console.log('seeded photos:', list.length, list.map((p) => `${p.folder}/${p.filename}`).join(','));
const cleared = JSON.parse((await req('GET', '/api/stage/list')).body);
console.log('stage after seed:', JSON.stringify(cleared), '| restore from trash:', (await req('POST', '/api/stage/clear')).status);
