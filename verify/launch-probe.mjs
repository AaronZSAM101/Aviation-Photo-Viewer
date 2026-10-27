import p from "puppeteer-core";
const t=Date.now();
const b=await p.launch({executablePath:process.env.CHROME_PATH,args:["--no-sandbox","--disable-dev-shm-usage","--disable-gpu"]});
console.log("launched in",Date.now()-t,"ms");
const pg=await b.newPage();await pg.goto(process.env.BASE);
console.log("title:",await pg.title());
await b.close();
