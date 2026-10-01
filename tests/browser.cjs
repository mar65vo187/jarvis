const { chromium } = require('../.browser-check/node_modules/playwright');
const { spawn } = require('child_process');
const assert = require('assert');
const path=require('path');
const fs=require('fs');
const os=require('os');
const http=require('http');
const root=path.resolve(__dirname,'..');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-browser-'));
const output=path.join(root,'dist','browser-check');
fs.mkdirSync(output,{recursive:true});
(async()=>{
 const mock=http.createServer((req,res)=>{
  let raw='';req.on('data',d=>raw+=d);req.on('end',()=>{
   res.setHeader('Content-Type','application/json');
   if(req.url==='/api/tags'){res.end(JSON.stringify({models:[{name:'qwen3:8b'}]}));return;}
   const payload=JSON.parse(raw||'{}');const messages=payload.messages||[];
   const last=messages[messages.length-1]||{};
   let response={message:{content:'Datei angelegt und geprüft.'}};
   if(last.role!=='tool')response={message:{content:'',tool_calls:[{function:{name:'write_file',arguments:{path:path.join(data,'workspace','browser.txt'),content:'Hallo Marvin'}}}]}};
   res.end(JSON.stringify(response));
  });
 });
 await new Promise(r=>mock.listen(18767,'127.0.0.1',r));
 const server=spawn(process.env.JARVIS_PYTHON||'python',['-m','jarvis'],{cwd:root,env:{...process.env,DATA_DIR:data,JARVIS_ENV_FILE:path.join(data,'.env'),JARVIS_PROVIDER:'claude',JARVIS_PRIVACY:'smart',OLLAMA_BASE_URL:'http://127.0.0.1:18767',PORT:'18766',PYTHONUNBUFFERED:'1'}});
 let logs='';server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
 let browser;
 try {
  for(let i=0;i<50;i++){try {const h=await(await fetch('http://127.0.0.1:18766/health')).json();assert.equal(h.app,'jarvis');break;}catch(e){if(i===49)throw e;await new Promise(r=>setTimeout(r,100));}}
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:18766');
  await page.locator('#setup').waitFor({state:'visible'});
  await page.locator('[name=OWNER_INFO]').fill('Marvin und TarifWerk');
  await page.locator('[name=JARVIS_PROVIDER]').selectOption('claude');
  await page.screenshot({path:path.join(output,'setup.png'),fullPage:true});
  await page.getByRole('button',{name:'SPEICHERN & STARTEN'}).click();
  await page.locator('#setup').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('#providerName').textContent==='Claude');
  assert((await page.locator('#kiMsg').innerText()).includes('API-Schlüssel fehlt'));
  assert.equal(await page.locator('#login').isVisible(),false);
  await page.getByRole('button',{name:'KI-VERBINDUNG TESTEN'}).click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Anthropic-API-Schlüssel'));
  await page.locator('#speakBtn').click();
  await page.locator('#inp').fill('Hallo Jarvis');
  await page.locator('#bar button').click();
  await page.waitForFunction(()=>document.querySelector('#chat').textContent.includes('KI konnte die Anfrage nicht ausführen'));
  await page.locator('#stopBtn').click();
  await page.waitForFunction(()=>document.querySelector('#stopBtn').textContent.includes('AUFHEBEN'));
  await page.getByRole('link',{name:'EINSTELLUNGEN'}).click();
  await page.locator('#setup').waitFor({state:'visible'});
  await page.locator('[name=CLAUDE_DAILY_BUDGET_USD]').fill('1.25');
  await page.getByRole('button',{name:'SPEICHERN & STARTEN'}).click();
  await page.locator('#setup').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('#costMsg').textContent.includes('1.25'));
  await page.screenshot({path:path.join(output,'dashboard.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true});
  const sizes=await page.evaluate(()=>({width:innerWidth,content:document.documentElement.scrollWidth}));
  assert(sizes.content<=sizes.width+1,JSON.stringify(sizes));
  await page.setViewportSize({width:1440,height:1000});
  page.on('dialog',d=>d.accept());
  await page.locator('#stopBtn').click();
  await page.waitForFunction(()=>document.querySelector('#stopBtn').textContent==='NOTAUS');
  await page.getByRole('link',{name:'EINSTELLUNGEN'}).click();
  await page.locator('[name=JARVIS_PROVIDER]').selectOption('ollama');
  await page.getByRole('button',{name:'SPEICHERN & STARTEN'}).click();
  await page.locator('#setup').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('#ki').textContent==='BEREIT');
  await page.locator('#inp').fill('Erstelle eine Browser-Test-Datei.');
  await page.locator('#bar button').click();
  await page.waitForFunction(()=>document.querySelector('#chat').textContent.includes('Datei angelegt und geprüft.'));
  assert.equal(fs.readFileSync(path.join(data,'workspace','browser.txt'),'utf8'),'Hallo Marvin');
  await page.screenshot({path:path.join(output,'tool-roundtrip.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',checks:['page render','setup save','provider status','missing-key diagnostics','AI check','chat HTTP flow','notaus','settings live update','mobile layout','Ollama HTTP tool roundtrip','file verified on disk','no JavaScript errors'],errors}));
 }finally{
  if(browser)await browser.close();
  server.kill('SIGTERM');
  await new Promise(r=>{server.once('exit',r);setTimeout(r,1500)});
  mock.close();
  fs.writeFileSync(path.join(output,'server.log'),logs);
  console.log('SERVER LOG',logs);
 }
})().catch(e=>{console.error(e);process.exit(1)});
