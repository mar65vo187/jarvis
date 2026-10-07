'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),vm=require('node:vm');
const Core=require('./core');
const checks=[];
const ok=(name)=>checks.push(name);
class Element{
  constructor(tag='div',o={}){this.tag=tag;this.children=[];this.textContent=o.text||'';this.value=o.attr?.value||'';this.disabled=false;this.checked=false;this.style={};this.type=o.attr?.type||'';}
  createEl(tag,o={}){const child=new Element(tag,o);this.children.push(child);return child;}
  createDiv(o={}){return this.createEl('div',o);}
  appendText(t){this.textContent+=t;}
  addClass(){}
  setAttribute(){}
  empty(){this.children=[];this.textContent='';}
  focus(){}
}
class Plugin{constructor(app){this.app=app;}async loadData(){return null;}async saveData(x){this.data=x;}registerView(t,f){this.factory=f;}addRibbonIcon(){}addCommand(){}addSettingTab(){}registerEvent(){}}
class ItemView{constructor(leaf){this.leaf=leaf;this.app=leaf.app;this.contentEl=new Element();}}
class Modal{constructor(app){this.app=app;this.contentEl=new Element();}open(){this.onOpen();}close(){this.onClose();}}
class PluginSettingTab{constructor(app){this.app=app;this.containerEl=new Element();}}
class Notice{constructor(message){this.message=message;}}
const obsidian={Plugin,ItemView,Modal,PluginSettingTab,Notice,Setting:class{}};
const main=process.argv[2]||path.join(__dirname,'../IN-DEINEN-VAULT-KOPIEREN/.obsidian/plugins/marvin-local-brain/main.js');
const moduleObject={exports:{}};
vm.runInNewContext(fs.readFileSync(main,'utf8'),{module:moduleObject,require:name=>name==='obsidian'?obsidian:require(name),Buffer,AbortController,console,setTimeout,clearTimeout,navigator:{clipboard:{writeText:async()=>{}}}},{filename:main});
const Brain=moduleObject.exports,{localRequest,BrainView,CloudPreview}=Brain.__test;
const notes=new Map([
  ['20 Projekte/TarifWerk/TarifWerk.md','# TarifWerk\nOffene Aufgaben: Website prüfen und Kundendaten sichern. Keine erfundenen Kundenzahlen.'],
  ['20 Projekte/Jarvis/Jarvis.md','# Jarvis\nTelegram und Ollama sollen zuverlässig verbunden werden.'],
  ['30 Bereiche/Marvin kompakt.md','# Marvin\nMarvin lebt in Wiesbaden und wünscht klare Schritte.'],
  ['90 Vorlagen/Vorlage.md','Nicht verwenden: Geheimtext Vorlage.'],
  ['Privat.md','Nicht verwenden: Geheimtext privat.'],
]);
let modified=1;
const file=p=>({path:p,extension:'md',stat:{mtime:modified,size:Buffer.byteLength(notes.get(p)||'')}});
const folders=new Set();
const created=[];
const app={
  vault:{
    on:()=>({}),
    getMarkdownFiles:()=>[...notes.keys()].map(file),
    cachedRead:async f=>notes.get(f.path),
    getAbstractFileByPath:p=>notes.has(p)?file(p):folders.has(p)?{path:p}:null,
    createFolder:async p=>{folders.add(p);},
    create:async(p,s)=>{assert(!notes.has(p),'must never overwrite');notes.set(p,s);created.push(p);return file(p);}
  },
  metadataCache:{getFileCache:f=>({frontmatter:f.path==='Privat.md'?{'ki-privat':true}:{}})},
  workspace:{getActiveFile:()=>file('20 Projekte/TarifWerk/TarifWerk.md'),getLeavesOfType:()=>[],getLeaf:()=>({openFile:async()=>{}}),openLinkText:async()=>{}}
};
let scenario='normal',captured=[];
const server=http.createServer((req,res)=>{
  let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{
    const body=raw?JSON.parse(raw):null;captured.push({path:req.url,body});
    if(scenario==='hang'&&req.url==='/api/chat')return;
    if(req.url==='/api/tags'){res.end(JSON.stringify({models:[{name:'qwen3:1.7b',size:1400000000},{name:'qwen3:4b-instruct',size:2500000000},{name:'remote:cloud',size:600,remote_host:'https://ollama.com'}]}));return;}
    if(req.url==='/api/show'){res.end(JSON.stringify(scenario==='cloud'?{remote_host:'https://ollama.com',model_info:{}}:body.model==='remote:cloud'?{remote_host:'https://ollama.com',remote_model:'test-model',capabilities:['completion']}:{model_info:{'general.architecture':'qwen3'},capabilities:['completion']}));return;}
    if(req.url==='/api/ps'){res.end(JSON.stringify({models:[{name:'qwen3:4b-instruct',size:3000000000,size_vram:0}]}));return;}
    if(req.url==='/api/chat'){
      if(scenario==='quota'){res.statusCode=429;res.end(JSON.stringify({error:'Test: Kontingent erschoepft'}));return;}
      if(scenario==='error'){res.statusCode=500;res.end(JSON.stringify({error:'Test: kein Speicher'}));return;}
      if(scenario==='redirect'){res.writeHead(302,{Location:'https://example.invalid/'});res.end('{}');return;}
      if(body.messages?.length===0){res.end(JSON.stringify({done:true,load_duration:150000000}));return;}
      res.setHeader('Content-Type','application/x-ndjson');
      const response=Buffer.from(JSON.stringify({...(body.model==='remote:cloud'?{remote_host:'https://ollama.com',remote_model:'test-model'}:{}),message:{content:'Prüfe zuerst die Website. [Q1] '},done:false})+'\n'+JSON.stringify({message:{content:'Danach Daten sichern.'},done:scenario!=='truncated',load_duration:150000000,prompt_eval_duration:1000000000,eval_duration:2000000000,eval_count:30})+'\n');
      const at=response.indexOf(Buffer.from('ü'))+1;
      res.write(response.subarray(0,at));res.end(response.subarray(at));return;
    }
    res.statusCode=404;res.end('{}');
  });
});
(async()=>{
  assert(Core.excluded('90 Vorlagen/V.md','90 Vorlagen'));
  assert(!Core.excluded('90 VorlagenPlus/V.md','90 Vorlagen'));
  assert(Core.excluded('.obsidian/secret.md',''));
  assert(!Core.safeTitle('../../bad:*').includes('/'));
  assert(!Core.safeMarkdown('![x](https://x.invalid/a) <img src=x>').includes('<img'));
  ok('Ordnergrenzen, verborgene Dateien und Dateinamen geprüft; Bild-/HTML-Einbettungen in gespeicherten Antworten entschärft.');
  assert(!Core.isLocalTag({name:'local-alias',size:1400000000,remote_model:'cloud'}));
  assert.throws(()=>Core.assertLocalShow({remote_host:'https://ollama.com',model_info:{x:1}}));
  assert.throws(()=>Core.assertLocalShow({model_info:{}}));
  assert.throws(()=>Core.assertLocalShow({model_info:{x:1},capabilities:['embedding']}));
  Core.assertLocalShow({model_info:{x:1},capabilities:['completion']});
  ok('Im lokalen Modus werden Cloud-Verweise und reine Embedding-Modelle abgewiesen.');
  const chunks=[...Core.splitNote('TarifWerk.md','Website prüfen, Kundendaten sichern. TarifWerk.'),...Core.splitNote('Sport.md','Muay Thai und Training.')];
  assert.equal(Core.retrieve(chunks,'TarifWerk Website')[0].path,'TarifWerk.md');
  assert.equal(Core.retrieve(chunks,'Quantenfluktuation').length,0);
  const packed=Core.buildMessages('Meine Frage',Array(10).fill({path:'x.md',text:'a'.repeat(2000)}),[],'chat');
  assert(packed.sources.reduce((n,s)=>n+s.text.length,0)<=4800);
  ok('Wissenssuche priorisiert passende Quellen, meldet fehlende Treffer und begrenzt den Kontext.');
  const brain=new Brain(app);await brain.onload();
  let index=await brain.buildIndex();
  assert.equal(index.files,3);assert.equal(index.skipped,2);
  assert(!index.chunks.some(c=>/Geheimtext/.test(c.text)));
  notes.set('20 Projekte/TarifWerk/TarifWerk.md','# TarifWerk\nNeue bestätigte Erkenntnis: Testnotiz wurde aktualisiert.');modified++;
  index=await brain.buildIndex();assert(index.chunks.some(c=>c.text.includes('aktualisiert')));
  notes.set('20 Projekte/TarifWerk/TarifWerk.md','# TarifWerk\nOffene Aufgaben: Website prüfen und Kundendaten sichern.');modified++;
  ok('Private Notizen und Vorlagen ausgeschlossen; geänderte Notizen beim nächsten Lesen aktualisiert.');
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(11434,'127.0.0.1',resolve);});
  const view=new BrainView({app},brain);await view.onOpen();
  assert.equal(view.select.value,'qwen3:4b-instruct');
  assert.equal(view.select.children[0].value,'qwen3:1.7b');
  assert.equal(view.activeCheck.type,'checkbox');
  view.input.value='Welche offenen Aufgaben hat TarifWerk?';view.mode.value='tasks';
  await view.send();
  assert.equal(view.records.length,1);assert.equal(view.busy,false);
  assert.equal(captured.filter(x=>x.path==='/api/chat').length,1);
  assert.equal(brain.data.session.length,1);
  assert.equal(brain.data.session[0].thorough,false);
  assert(view.records[0].answer.includes('Prüfe'));
  const sent=captured.find(x=>x.path==='/api/chat').body;
  assert(sent.messages.some(m=>m.content.includes('Kundendaten sichern')));
  assert(!JSON.stringify(sent).includes('Geheimtext'));
  assert.equal(created.length,0);
  const original=notes.get('20 Projekte/TarifWerk/TarifWerk.md');
  await brain.saveResult('../Mein Plan','- [ ] Website prüfen.\n![x](https://x.invalid/a)',view.records[0],true);
  assert.equal(created.length,1);assert(created[0].startsWith('61 KI Ergebnisse/'));
  assert(notes.get(created[0]).includes('status: ki-entwurf'));
  assert(notes.get(created[0]).includes('- [ ] Website prüfen.'));
  assert.equal(notes.get('20 Projekte/TarifWerk/TarifWerk.md'),original);
  ok('Gesamtablauf mit simuliertem Ollama: Modellwahl → Notizensuche → gestreamte Antwort mit Umlauten → neue Aufgabennotiz; vorhandene Notizen unverändert.');
  assert.equal(sent.keep_alive,'10m');assert.equal(sent.think,false);
  ok('Schnellmodus nutzt genau einen Aufruf ohne Thinking und hält das Modell 10 Minuten geladen.');
  await brain.rate(view.records[0].created,'fehlerhaft');
  assert.equal(brain.data.session[0].rating,'fehlerhaft');
  const memory=await brain.saveMemory('TarifWerk Präferenz','TarifWerk: Privatkunden werden geduzt.',view.records[0]);
  assert(memory.path.startsWith('62 KI Gedaechtnis/'));
  const reindex=await brain.buildIndex();
  assert(Core.retrieve(reindex.chunks.filter(c=>c.path.startsWith('62 KI Gedaechtnis/')),'TarifWerk Privatkunden')[0].text.includes('geduzt'));
  const restored=new Brain(app);restored.loadData=async()=>JSON.parse(JSON.stringify(brain.data));await restored.onload();
  assert.equal(restored.session[0].answer,view.records[0].answer);
  assert.equal(restored.session[0].rating,'fehlerhaft');
  const reopened=new BrainView({app},restored);assert.equal(reopened.records.length,1);
  assert(reopened.history.some(m=>m.content.includes('Website')));
  ok('Chat und Bewertung nach simuliertem Plugin-Neustart wiederhergestellt; bestätigte Korrektur erneut auffindbar.');
  const firstRecord=view.records[0];
  for(let i=0;i<22;i++)await restored.remember({...firstRecord,created:String(i)});
  assert.equal(restored.session.length,20);
  await restored.clearSession();assert.equal(restored.data.session.length,0);
  assert(notes.has(memory.path));
  ok('Chat auf 20 Antworten begrenzt; Chat löschen lässt bestätigte Gedächtnisnotizen bestehen.');
  await view.performance('warm');
  assert(captured.some(x=>x.body?.messages?.length===0&&x.body.keep_alive==='10m'&&x.body.options.num_ctx===4096));
  assert(view.diagnostics.textContent.includes('Vorgeladen'));
  const testsBefore=captured.filter(x=>x.path==='/api/chat').length;
  await view.performance('test');
  assert.equal(captured.filter(x=>x.path==='/api/chat').length,testsBefore+2);
  assert(view.diagnostics.textContent.includes('15.0 Token/s'));
  assert(view.diagnostics.textContent.includes('Lauf 2:'));
  assert(view.diagnostics.textContent.includes('GPU 0.00'));
  assert.equal(brain.session.length,1);
  for(const x of captured.filter(x=>x.path==='/api/chat').slice(-2))assert(!JSON.stringify(x.body).includes('TarifWerk'));
  await view.performance('unload');
  assert.equal(captured.filter(x=>x.path==='/api/chat').at(-1).body.keep_alive,0);
  assert.equal(view.busy,false);
  ok('Vorladen, zwei getrennte Messläufe mit korrekter Tokenrate, Diagnose und Entladen ohne Notizinhalte und ohne Chatänderung.');
  const deepBefore=captured.filter(x=>x.path==='/api/chat').length;
  view.deepCheck.checked=true;view.input.value='Prüfe den TarifWerk Plan.';await view.send();
  assert.equal(captured.filter(x=>x.path==='/api/chat').length,deepBefore+3);
  assert.equal(brain.session.at(-1).thorough,true);
  ok('Optionaler gründlicher Modus führt genau drei Aufrufe aus; Schnellmodus bleibt Standard.');
  scenario='cloud';const before=captured.filter(x=>x.path==='/api/chat').length;
  view.input.value='TarifWerk';await view.send();
  assert.equal(captured.filter(x=>x.path==='/api/chat').length,before);
  ok('Cloud-Verweis im Modell verhindert das Senden der Wissensnotizen an die Chat-API.');
  scenario='normal';
  assert(Core.isCloudTag({name:'remote:cloud',remote_host:'https://ollama.com'}));
  assert(!Core.isCloudTag({name:'remote:cloud',remote_host:'https://evil.invalid'}));
  assert.throws(()=>Core.assertCloudShow({remote_host:'https://evil.invalid',remote_model:'x'}));
  assert.throws(()=>Core.assertCloudShow({model_info:{x:1}}));
  let decision=null;
  const preview=new CloudPreview(app,'remote:cloud',[{role:'user',content:'Sichtbare Daten'}],v=>decision=v);preview.open();
  assert(preview.contentEl.children.some(c=>c.textContent==='USER:\nSichtbare Daten'));
  preview.close();assert.equal(decision,false);
  const approved=new CloudPreview(app,'remote:cloud',[],v=>decision=v);approved.open();
  approved.contentEl.children.find(c=>c.textContent==='Diese Inhalte online senden').onclick();assert.equal(decision,true);
  const cancelled=new AbortController();
  const pending=BrainView.prototype.confirmCloud.call(view,'remote:cloud',[],cancelled.signal);cancelled.abort();assert.equal(await pending,false);
  ok('Online-Vorschau zeigt die Nutzlast; Schließen und Stoppen brechen ab, nur der Sendeknopf gibt frei.');
  view.route.value='cloud';view.updateRoute();await view.refresh();
  assert.equal(view.select.value,'remote:cloud');assert(view.deepCheck.disabled);assert(view.perfButtons.every(b=>b.disabled));
  assert.equal(brain.settings.model,'qwen3:4b-instruct');
  view.history=[{role:'user',content:'NIE-ONLINE-ALTER-CHAT'}];
  let previewPayload;
  view.confirmCloud=async (model,messages)=>{previewPayload=JSON.stringify(messages);return false;};
  const cloudBefore=captured.filter(x=>x.path==='/api/chat').length;
  view.input.value='Welche TarifWerk Aufgaben sind offen?';await view.send();
  assert.equal(captured.filter(x=>x.path==='/api/chat').length,cloudBefore);
  view.confirmCloud=async (model,messages)=>{previewPayload=JSON.stringify(messages);return true;};
  await view.send();
  const online=captured.filter(x=>x.path==='/api/chat').at(-1).body;
  assert.equal(captured.filter(x=>x.path==='/api/chat').length,cloudBefore+1);
  assert.equal(JSON.stringify(online.messages),previewPayload);
  assert(!previewPayload.includes('NIE-ONLINE-ALTER-CHAT'));assert(!previewPayload.includes('Geheimtext'));
  assert(previewPayload.includes('Kundendaten'));assert.equal(brain.session.at(-1).route,'cloud');
  const quotaBefore=captured.filter(x=>x.path==='/api/chat').length;
  scenario='quota';view.input.value='TarifWerk';await view.send();
  assert.equal(captured.filter(x=>x.path==='/api/chat').length,quotaBefore+1);
  assert.equal(view.busy,false);assert.equal(view.route.value,'cloud');
  ok('Online sendet genau die freigegebene Nutzlast ohne alten Chat; Kontingentfehler lösen weder Wiederholung noch Modellwechsel aus.');
  scenario='normal';view.route.value='local';view.updateRoute();await view.refresh();
  assert.equal(view.select.value,'qwen3:4b-instruct');
  const freshView=new BrainView({app},brain);await freshView.onOpen();assert.equal(freshView.route.value,'local');await freshView.onClose();
  ok('Lokales Modell bleibt gespeichert; neue Ansicht startet immer lokal.');
  scenario='error';await assert.rejects(localRequest('/api/chat',{}, {onToken:()=>{}}),/kein Speicher/);
  scenario='redirect';await assert.rejects(localRequest('/api/chat',{}),/302/);
  scenario='truncated';await assert.rejects(localRequest('/api/chat',{}, {onToken:()=>{}}),/nicht vollständig/);
  scenario='hang';const controller=new AbortController();
  const hanging=localRequest('/api/chat',{}, {signal:controller.signal,timeout:1000});setTimeout(()=>controller.abort(),20);
  await assert.rejects(hanging,/Abgebrochen/);
  await assert.rejects(localRequest('/api/chat',{}, {timeout:20}),/Zeitlimit/);
  await assert.rejects(localRequest('https://example.invalid',{}),/Unzulässiger/);
  ok('Fehler, unvollständige Streams, Abbruch, Zeitlimit, externe Ziele und Weiterleitungen geprüft.');
  await view.onClose();assert.equal(view.records.length,0);assert.equal(view.history.length,0);
  assert.equal(brain.data.session.length,3);
  ok('Schließen der Ansicht leert nur den UI-Speicher; gespeicherter Verlauf bleibt erhalten.');
  const result={summary:checks.length+' Testgruppen erfolgreich. Syntax des ausgelieferten Plugins geprüft.',checks};
  fs.writeFileSync(path.join(__dirname,'test-results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{server.closeAllConnections();server.close();});
