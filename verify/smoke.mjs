const bases = (process.env.BASES || 'http://10.88.1.31,http://10.88.1.141').split(',');

for (const base of bases) {
  const html = await fetch(`${base}/`);
  const text = await html.text();
  const js = /assets\/(index-[\w.-]+\.js)/.exec(text);
  const css = /assets\/(index-[\w.-]+\.css)/.exec(text);
  const jsRes = await fetch(`${base}/assets/${js ? js[1] : 'missing'}`);
  const cssRes = await fetch(`${base}/assets/${css ? css[1] : 'missing'}`);
  const photos = await fetch(`${base}/api/photos`);
  const list = await photos.json();
  const deep = await fetch(`${base}/view/${encodeURIComponent(list[0].folder + '/' + list[0].filename)}`);
  const deepText = await deep.text();
  const thumb = await fetch(`${base}/thumb/${encodeURIComponent(list[0].folder + '/' + list[0].filename)}`);
  console.log(
    base,
    JSON.stringify({
      html: html.status,
      bundle: js && js[1],
      js: jsRes.status,
      css: cssRes.status,
      photos: list.length,
      deepLink: deep.status,
      spaRoot: /id="root"/.test(deepText),
      thumb: thumb.status,
      thumbType: thumb.headers.get('content-type'),
    }),
  );
}
