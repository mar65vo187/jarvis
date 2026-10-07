'use strict';
const {Plugin,ItemView,PluginSettingTab,Setting,Notice,Modal}=require('obsidian');
const http=require('http');
const os=require('os');
const {StringDecoder}=require('string_decoder');
const VIEW='marvin-local-brain-view';
const DEFAULTS={model:'',ctx:4096,excludes:'90 Vorlagen\n99 Archiv\n61 KI Ergebnisse',includeCurrent:false,thorough:false,keepAlive:'10m'};

// Only an exact loopback destination is permitted. No configurable provider or redirects.
function timing(r){
  const sec=n=>Number.isFinite(n)?(n/1e9).toFixed(2)+' s':'nicht gemeldet';
  const rate=r.eval_duration>0&&Number.isFinite(r.eval_count)?(r.eval_count*1e9/r.eval_duration).toFixed(1)+' Token/s':'nicht gemeldet';
  return 'Laden '+sec(r.load_duration)+' · Eingabe '+sec(r.prompt_eval_duration)+' · Ausgabe '+sec(r.eval_duration)+' · '+rate;
}
function localRequest(path,body,{signal,onToken,timeout=20000,allowCloud=false}={}){
  return new Promise((resolve,reject)=>{
    if(!['/api/tags','/api/show','/api/chat','/api/ps'].includes(path))return reject(new Error('Unzulässiger Endpunkt.'));
    if(signal?.aborted)return reject(new Error('Abgebrochen.'));
    const payload=body===undefined?null:JSON.stringify(body);
    let timer,settled=false,req;
    const finish=(err,result)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
      if(err)reject(err);else resolve(result);
    };
    const cancel=()=>{req?.destroy();finish(new Error('Abgebrochen.'));};
    req=http.request({hostname:'127.0.0.1',port:11434,path,method:payload?'POST':'GET',headers:payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}},res=>{
      const decoder=new StringDecoder('utf8');let raw='',pending='',total=0,last=null,answer='';
      const stream=Boolean(onToken&&res.statusCode===200);
      const parseLine=line=>{
        if(!line.trim())return;
        const value=JSON.parse(line);if(value.error)throw new Error(String(value.error));
        if(!allowCloud&&(value.remote_host||value.remote_model))throw new Error('Unerwartete Cloud-Antwort. Anfrage wurde gestoppt.');
        const text=value.message?.content||''; answer+=text;if(text)onToken(text);last=value;
      };
      res.on('data',buf=>{
        try{
          total+=buf.length;if(total>2*1024*1024)throw new Error('Antwort zu groß. Bitte den Auftrag verkürzen.');
          const part=decoder.write(buf);
          if(stream){pending+=part;let at;while((at=pending.indexOf('\n'))>=0){parseLine(pending.slice(0,at));pending=pending.slice(at+1);}}
          else raw+=part;
        }catch(e){res.destroy();req.destroy();finish(e);}
      });
      res.on('error',e=>finish(e));
      res.on('end',()=>{
        if(settled)return;
        try{
          if(stream){pending+=decoder.end();parseLine(pending);if(!last?.done)throw new Error('Antwort wurde nicht vollständig abgeschlossen.');finish(null,{...last,message:{role:'assistant',content:answer}});}
          else{
            raw+=decoder.end();let value;try{value=JSON.parse(raw);}catch{throw new Error(`Ollama meldet HTTP ${res.statusCode}; keine gültige Antwort.`);}
            if(res.statusCode<200||res.statusCode>=300||value.error)throw new Error(String(value.error||`Ollama HTTP ${res.statusCode}`));
            finish(null,value);
          }
        }catch(e){finish(e);}
      });
    });
    req.on('error',e=>finish(new Error(e.code==='ECONNREFUSED'?'Ollama ist nicht erreichbar. Ollama öffnen und erneut prüfen.':e.message)));
    timer=setTimeout(()=>{req.destroy();finish(new Error('Zeitlimit erreicht. Versuche ein kleineres Modell oder einen kürzeren Auftrag.'));},timeout);
    signal?.addEventListener('abort',cancel,{once:true});
    if(payload)req.write(payload);req.end();
  });
}

class CloudPreview extends Modal{
  constructor(app,model,messages,finish){super(app);this.model=model;this.messages=messages;this.finish=finish;this.approved=false;}
  onOpen(){
    this.contentEl.createEl('h2',{text:'Online-Anfrage prüfen'});
    this.contentEl.createEl('p',{text:'Empfänger: Ollama Cloud · Modell: '+this.model+'. Übertragen werden die unten sichtbaren Anweisungen, deine Frage und ausgewählte Notizausschnitte. Frühere Chatnachrichten werden nicht angehängt.'});
    this.contentEl.createEl('p',{text:'Nur mit Gratis-Konto und verfügbarem Gratis-Modell nutzen, wenn es kostenlos bleiben soll. Das Plugin kennt deinen Tarif und Restbetrag nicht. Bei einem bezahlten Konto kann diese Anfrage kostenpflichtiges Guthaben verbrauchen. Keine automatischen Käufe oder Wiederholungen.'});
    this.contentEl.createEl('pre',{cls:'mlb-cloud-preview',text:this.messages.map(m=>m.role.toUpperCase()+':\n'+m.content).join('\n\n')});
    this.contentEl.createEl('button',{text:'Abbrechen'}).onclick=()=>this.close();
    this.contentEl.createEl('button',{text:'Diese Inhalte online senden',cls:'mod-cta'}).onclick=()=>{this.approved=true;this.close();};
  }
  onClose(){this.contentEl.empty();const done=this.finish;this.finish=null;done?.(this.approved);}
}

class SaveNoteModal extends Modal{
  constructor(app,plugin,record,asTasks){super(app);this.plugin=plugin;this.record=record;this.asTasks=asTasks;}
  onOpen(){
    this.contentEl.createEl('h2',{text:this.asTasks?'Aufgaben als neue Notiz speichern':'Antwort als neue Wissensnotiz speichern'});
    this.contentEl.createEl('p',{text:'Du kannst den Text vor dem Speichern ändern. Er wird als KI-Entwurf in „61 KI Ergebnisse“ gespeichert. Bestehende Notizen werden nicht überschrieben.'});
    const title=this.contentEl.createEl('input',{attr:{type:'text'},cls:'mlb-title'});title.value=Core.safeTitle(this.record.question.slice(0,60));
    const area=this.contentEl.createEl('textarea',{cls:'mlb-save-area'});area.value=this.record.answer;
    const save=this.contentEl.createEl('button',{text:'Neue Notiz speichern',cls:'mod-cta'});
    save.onclick=async()=>{
      if(!area.value.trim())return new Notice('Bitte einen Text eintragen.');
      save.disabled=true;
      try{await this.plugin.saveResult(title.value,area.value,this.record,this.asTasks);this.close();}catch(e){new Notice(e.message,10000);save.disabled=false;}
    };
  }
  onClose(){this.contentEl.empty();}
}


class MemoryModal extends Modal{
  constructor(app,plugin,record){super(app);this.plugin=plugin;this.record=record;}
  onOpen(){
    this.contentEl.createEl('h2',{text:'Was soll deine KI künftig berücksichtigen?'});
    this.contentEl.createEl('p',{text:'Trage die richtige Information oder deine konkrete Präferenz ein. Deine Bestätigung speichert sie als neue Gedächtnisnotiz. Relevante Korrekturen werden bei späteren Fragen verwendet. Kein Modelltraining.'});
    const title=this.contentEl.createEl('input',{attr:{type:'text'},cls:'mlb-title'});title.value=Core.safeTitle(this.record.question);
    const text=this.contentEl.createEl('textarea',{cls:'mlb-save-area',attr:{placeholder:'Die richtige Information oder meine Präferenz …'}});
    const button=this.contentEl.createEl('button',{text:'Als meine Angabe bestätigen und merken',cls:'mod-cta'});
    button.onclick=async()=>{
      if(!text.value.trim())return new Notice('Bitte die richtige Information eintragen.');
      button.disabled=true;
      try{await this.plugin.saveMemory(title.value,text.value,this.record);this.close();}catch(e){new Notice(e.message);button.disabled=false;}
    };
  }
  onClose(){this.contentEl.empty();}
}

class BrainView extends ItemView{
  constructor(leaf,plugin){super(leaf);this.plugin=plugin;this.records=plugin.session.slice();this.history=this.records.flatMap(r=>[{role:'user',content:r.question},{role:'assistant',content:r.answer}]).slice(-6);this.controller=null;this.busy=false;this.closed=false;}
  getViewType(){return VIEW;}
  getDisplayText(){return 'Marvins KI';}
  getIcon(){return 'brain';}
  async onOpen(){
    this.closed=false;const root=this.contentEl;root.empty();root.addClass('mlb-root');
    const header=root.createDiv({cls:'mlb-header'});header.createDiv({text:'MARVINS KI',cls:'mlb-eyebrow'});
    header.createEl('h2',{text:'Dein Wissen. Deine KI.'});
    header.createEl('p',{text:'Marvin Brain · lokal oder bewusst online mit Ollama'});
    const controls=root.createDiv({cls:'mlb-controls'});
    this.route=controls.createEl('select',{attr:{'aria-label':'Betriebsart'}});
    this.route.createEl('option',{text:'Lokal · auf diesem PC',attr:{value:'local'}});
    this.route.createEl('option',{text:'Online · Ollama Cloud',attr:{value:'cloud'}});
    this.route.value='local';this.route.onchange=()=>{this.updateRoute();this.refresh();};
    this.select=controls.createEl('select',{attr:{'aria-label':'Lokales Modell'}});
    this.select.createEl('option',{text:'Zuerst Ollama prüfen',attr:{value:''}});
    this.select.onchange=async()=>{if(this.route.value==='local'){this.plugin.settings.model=this.select.value;await this.plugin.saveSettings();}};
    this.check=controls.createEl('button',{text:'Ollama prüfen'});this.check.onclick=()=>this.refresh();
    this.status=root.createDiv({cls:'mlb-status',text:'Verbinde dein lokales Modell. Deine Notizen bleiben auf diesem PC.'});
    const perf=root.createDiv({cls:'mlb-actions'});
    this.perfButtons=[];
    for(const [kind,label] of [['warm','Modell vorladen'],['test','Tempo testen (2 Läufe)'],['unload','Modell entladen']]){
      const b=perf.createEl('button',{text:label});b.onclick=()=>this.performance(kind);this.perfButtons.push(b);
    }
    this.diagnostics=root.createEl('pre',{cls:'mlb-diagnostics',text:'Schnellmodus: eine Antwort, kurze Quellen. Gründlich braucht drei Durchgänge. Vorladen benötigt einmal die Ladezeit; es hält das Modell für die Arbeit bereit.'});
    perf.createEl('button',{text:'Messung kopieren'}).onclick=()=>navigator.clipboard.writeText(this.diagnostics.textContent).then(()=>new Notice('Messung kopiert.')).catch(()=>new Notice('Bitte Messung manuell kopieren.'));
    const hardware=root.createDiv({cls:'mlb-hardware'});
    hardware.textContent=`Dieser Rechner: ${(os.totalmem()/1024**3).toFixed(1)} GB RAM · aktuell ${(os.freemem()/1024**3).toFixed(1)} GB frei. Modellgröße und Geschwindigkeit bitte praktisch prüfen.`;
    const details=root.createEl('details',{cls:'mlb-help'});details.createEl('summary',{text:'Einmalige Einrichtung und Grenzen'});
    details.createEl('p',{text:'1. Ollama starten. 2. Ein lokales Modell laden. 3. „Ollama prüfen“ und Modell wählen. Ist Ollama noch nicht installiert: ollama.com/download/windows im Browser öffnen.'});
    details.createEl('p',{text:'Optionales kleineres Vergleichsmodell (ca. 1,4 GB Download):'});details.createEl('code',{text:'ollama pull qwen3:1.7b'});
    details.createEl('p',{text:'Dein bereits geladenes Vergleichsmodell (ca. 2,5 GB Datei):'});details.createEl('code',{text:'ollama pull qwen3:4b-instruct'});
    details.createEl('p',{text:'Die Downloadgröße ist nicht der RAM-Bedarf. Modelle sind nicht in der ZIP enthalten. Lokal bleibt lokal. Online sendet freigegebene Frage und Quellen an Ollama Cloud. Dafür sind Anmeldung und ein dort verfügbares Modell erforderlich. Die Gratisnutzung ist begrenzt; siehe ONLINE-ANLEITUNG.txt. Kein Computerzugriff oder Hintergrundagent.'});
    const bar=root.createDiv({cls:'mlb-mode-row'});
    this.mode=bar.createEl('select',{attr:{'aria-label':'Auftragsart'}});
    for(const [value,text]of Object.entries({chat:'Fragen beantworten',plan:'Plan erstellen',tasks:'Aufgaben vorbereiten',draft:'Text entwerfen'}))this.mode.createEl('option',{attr:{value},text});

    const depth=bar.createEl('label');this.deepCheck=depth.createEl('input',{attr:{type:'checkbox'}});this.deepCheck.checked=this.plugin.settings.thorough;depth.appendText(' Gründlich: Entwurf → Prüfung → Endfassung');
    this.deepCheck.onchange=async()=>{this.plugin.settings.thorough=this.deepCheck.checked;await this.plugin.saveSettings();};
    const label=bar.createEl('label');this.activeCheck=label.createEl('input',{attr:{type:'checkbox'}});this.activeCheck.checked=this.plugin.settings.includeCurrent;label.appendText(' Geöffnete Notiz einbeziehen');
    this.activeCheck.onchange=async()=>{this.plugin.settings.includeCurrent=this.activeCheck.checked;await this.plugin.saveSettings();};
    const examples=root.createDiv({cls:'mlb-examples'});
    for(const [name,q]of [['TarifWerk','Welche offenen Punkte zu TarifWerk sollte ich zuerst klären?'],['Mein Tag','Plane meinen Tag anhand meiner offenen Aufgaben und Prioritäten.'],['Jarvis','Was ist der nächste konkrete Schritt für meinen Jarvis?']]){
      const b=examples.createEl('button',{text:name});b.onclick=()=>{if(this.busy)return;this.input.value=q;this.input.focus();};
    }
    this.chat=root.createDiv({cls:'mlb-chat'});this.chat.setAttribute('aria-live','polite');
    this.chat.createEl('p',{text:'Stelle eine Frage zu deinem Wissen. Verwendete Notizausschnitte werden unter der Antwort angezeigt.',cls:'mlb-empty'});

    for(const record of this.records){
      const card=this.chat.createDiv({cls:'mlb-bubble mlb-assistant'});
      card.createEl('small',{text:'Gespeichertes Gespräch · '+record.created+' · '+record.model});
      card.createEl('strong',{text:record.question});card.createDiv({cls:'mlb-answer',text:record.answer});
      card.createEl('small',{text:'Kontext der damaligen Antwort: '+record.sources.map(s=>s.path).join(', ')});
      this.answerActions(card,record);
    }
    this.input=root.createEl('textarea',{cls:'mlb-input',attr:{placeholder:'Was möchtest du wissen oder vorbereiten?',maxlength:'2000','aria-label':'Dein Auftrag'}});
    this.input.onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();this.send();}};
    const actions=root.createDiv({cls:'mlb-actions'});
    this.sendBtn=actions.createEl('button',{text:'Mit meinem Wissen antworten',cls:'mod-cta'});this.sendBtn.onclick=()=>this.send();
    this.stopBtn=actions.createEl('button',{text:'Stoppen'});this.stopBtn.disabled=true;this.stopBtn.onclick=()=>this.controller?.abort();

    this.clearBtn=actions.createEl('button',{text:'Gespeicherten Chat leeren'});this.clearBtn.onclick=async()=>{
      if(this.busy)return;this.clearBtn.disabled=true;
      try{await this.plugin.clearSession();this.history=[];this.records=[];this.chat.empty();new Notice('Chatverlauf geleert. Wissens- und Gedächtnisnotizen bleiben erhalten.');}catch(e){new Notice('Chat konnte nicht gelöscht werden: '+e.message);}finally{this.clearBtn.disabled=false;}
    };
    root.createEl('small',{text:'Die letzten 20 Antworten werden lokal gespeichert und nach Neustart angezeigt. Dauerhaftes Fachwissen bleibt in deinen Notizen. Betrieb nur bei laufendem PC, Obsidian und Ollama. Strg+Enter sendet.'});
    await this.refresh();
  }
  setBusy(v){this.busy=v;this.sendBtn.disabled=v;this.select.disabled=v;this.check.disabled=v;this.clearBtn.disabled=v;this.stopBtn.disabled=!v;this.input.disabled=v;this.mode.disabled=v;this.activeCheck.disabled=v;this.deepCheck.disabled=v||this.route.value==='cloud';this.route.disabled=v;for(const b of this.perfButtons||[])b.disabled=v||this.route.value==='cloud';}
  updateRoute(){
    const cloud=this.route.value==='cloud';
    if(cloud)this.deepCheck.checked=false;
    this.setBusy(this.busy);
    this.status.textContent=cloud?'Online: Vorschau vor jeder Übertragung. Gratis-Kontingent und Modellzugang im Ollama-Konto prüfen.':'Lokal: Notizen werden an das Modell auf diesem PC übergeben.';
  }
  async confirmCloud(model,messages,signal){
    return new Promise(resolve=>{
      const modal=new CloudPreview(this.app,model,messages,ok=>{signal.removeEventListener('abort',abort);resolve(ok);});
      const abort=()=>modal.close();signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted){signal.removeEventListener('abort',abort);resolve(false);return;}modal.open();
    });
  }
  async refresh(){
    if(this.busy||this.refreshing||this.closed)return;this.refreshing=true;
    this.check.disabled=true;this.select.disabled=true;this.route.disabled=true;this.sendBtn.disabled=true;this.status.textContent='Prüfe Ollama auf diesem PC …';
    try{
      const response=await localRequest('/api/tags');if(this.closed)return;
      const cloud=this.route.value==='cloud';
      const list=(response.models||[]).filter(cloud?Core.isCloudTag:Core.isLocalTag).sort((a,b)=>a.size-b.size);
      this.select.empty();
      if(!list.length){this.select.createEl('option',{attr:{value:''},text:cloud?'Noch kein Cloud-Modell':'Noch kein lokales Modell'});this.status.textContent=cloud?'Cloud-Modell fehlt. Erst 02-ONLINE-EINRICHTEN.cmd verwenden; siehe ONLINE-ANLEITUNG.txt.':'Ollama erreichbar. Erst 01-EINRICHTEN.cmd verwenden.';return;}
      for(const model of list)this.select.createEl('option',{attr:{value:model.name},text:cloud?model.name+' · ONLINE':`${model.name} · ${(model.size/1e9).toFixed(1)} GB Datei`});
      const previous=cloud?'':this.plugin.settings.model;
      this.select.value=list.some(m=>m.name===previous)?previous:(list.find(m=>m.name==='marvin-brain:4b-v2')||list.find(m=>m.name==='qwen3:4b-instruct')||list[0]).name;
      if(!cloud){this.plugin.settings.model=this.select.value;await this.plugin.saveSettings();}
      this.status.textContent=cloud?'Online bereit zur Vorschau. Frage und ausgewählte Quellen verlassen nach Freigabe diesen PC. Konto-Limits gelten.':`Ollama erreichbar · ${list.length} lokale Modellkandidaten. Modelltyp wird vor jeder Anfrage geprüft.`;
    }catch(e){if(!this.closed)this.status.textContent=e.message;}
    finally{this.refreshing=false;if(!this.closed)this.setBusy(this.busy);}
  }
  async performance(kind){
    if(this.busy||this.refreshing||this.closed)return;
    if(this.route.value==='cloud')return new Notice('Tempo-Test und Vorladen sind nur lokal verfügbar.');
    const model=this.select.value;if(!model)return new Notice('Bitte ein lokales Modell wählen.');
    this.setBusy(true);this.controller=new AbortController();const signal=this.controller.signal;
    const lines=['Modell: '+model,'CPU: '+(os.cpus()[0]?.model||'unbekannt'),'RAM: '+(os.totalmem()/1024**3).toFixed(1)+' GB; frei: '+(os.freemem()/1024**3).toFixed(1)+' GB','Kontext: '+this.plugin.settings.ctx+' · think:false'];
    const show=text=>{if(!this.closed)this.diagnostics.textContent=lines.concat(text||[]).join('\n');};
    try{
      const tags=await localRequest('/api/tags',undefined,{signal});
      if(!(tags.models||[]).some(m=>m.name===model&&Core.isLocalTag(m)))throw new Error('Lokales Modell nicht verfügbar.');
      Core.assertLocalShow(await localRequest('/api/show',{model},{signal}));
      if(kind==='test'){
        for(let i=1;i<=2;i++){
          show('Lauf '+i+'/2 läuft …');const started=Date.now();let first=null;
          const result=await localRequest('/api/chat',{model,messages:[{role:'user',content:'Nenne genau fünf kurze Tipps zur Tagesplanung. Je Tipp höchstens sechs Wörter. Keine Einleitung.'}],stream:true,think:false,keep_alive:this.plugin.settings.keepAlive,options:{num_ctx:this.plugin.settings.ctx,num_predict:120,temperature:0}},{signal,timeout:300000,onToken:()=>{if(first===null)first=Date.now()-started;}});
          lines.push('Lauf '+i+': '+timing(result)+' · erste Ausgabe '+(first===null?'fehlt':(first/1000).toFixed(2)+' s')+' · gesamt '+((Date.now()-started)/1000).toFixed(2)+' s');
        }
        lines.push('Kurzer Basistest ohne Notizen. Lauf 1 kann bereits warm sein; Lauf 2 nutzt oft zusätzlich einen Eingabe-Cache. Wissensfragen benötigen mehr Zeit.');
      }else{
        show(kind==='warm'?'Modell wird vorgeladen …':'Modell wird entladen …');
        const started=Date.now();
        await localRequest('/api/chat',{model,messages:[],stream:false,keep_alive:kind==='unload'?0:this.plugin.settings.keepAlive,options:{num_ctx:this.plugin.settings.ctx}},{signal,timeout:300000});
        lines.push(kind==='unload'?'Entladen angefordert; nächste Antwort lädt erneut.':'Vorgeladen in '+((Date.now()-started)/1000).toFixed(2)+' s. Haltezeit nach Nutzung: '+this.plugin.settings.keepAlive+'.');
      }
      try{
        const ps=await localRequest('/api/ps',undefined,{signal});
        for(const m of ps.models||[])lines.push('Geladen: '+m.name+' · Speicher '+(m.size/1024**3).toFixed(2)+' GiB · davon GPU '+(m.size_vram/1024**3).toFixed(2)+' GiB');
      }catch(e){if(signal.aborted)throw e;lines.push('Speicherbelegung nicht verfügbar.');}
      show();
    }catch(e){show(e.message);}
    finally{this.controller=null;if(!this.closed)this.setBusy(false);}
  }
  async send(){
    if(this.busy||this.refreshing||this.closed)return;
    const cloud=this.route.value==='cloud';
    const question=this.input.value.trim();if(!question)return;
    const model=this.select.value;if(!model)return new Notice('Bitte zuerst Ollama prüfen und ein lokales Modell wählen.');
    this.setBusy(true);this.controller=new AbortController();const signal=this.controller.signal;
    const user=this.chat.createDiv({cls:'mlb-bubble mlb-user'});user.createEl('strong',{text:'Du'});user.createEl('p',{text:question});
    const answerBox=this.chat.createDiv({cls:'mlb-bubble mlb-assistant'});answerBox.createEl('strong',{text:'Marvins KI'});
    const answerText=answerBox.createDiv({cls:'mlb-answer',text:'Prüfe das Modell und suche passende Notizen …'});
    let received='',submitted=false;
    try{
      const tags=await localRequest('/api/tags',undefined,{signal});
      if(!(tags.models||[]).some(m=>m.name===model&&(cloud?Core.isCloudTag(m):Core.isLocalTag(m))))throw new Error('Modell passt nicht zur gewählten Betriebsart. Bitte Ollama erneut prüfen.');
      const info=await localRequest('/api/show',{model},{signal});
      if(cloud)Core.assertCloudShow(info);else Core.assertLocalShow(info);
      const index=await this.plugin.buildIndex(signal);
      const query=question+' '+(cloud?[]:this.history).filter(m=>m.role==='user').slice(-1).map(m=>m.content.slice(0,160)).join(' ');
      let sources=Core.retrieve(index.chunks,query,4,this.plugin.settings.ctx>=8192?10000:3200);

      const memories=Core.retrieve(index.chunks.filter(c=>c.path.startsWith('62 KI Gedaechtnis/')),query,2,1400);
      if(memories.length)sources=[...memories,...sources.filter(s=>!memories.some(m=>m.path===s.path))];
      // Prefer current user-authored profile as useful personal context, not duplicated instructions.
      const profile=index.chunks.find(c=>c.path==='30 Bereiche/Marvin kompakt.md'&&c.start===0);
      if(profile&&!sources.some(s=>s.path===profile.path))sources.push({path:profile.path,text:profile.text.slice(0,700),start:0});
      if(this.activeCheck.checked){
        const active=this.app.workspace.getActiveFile();
        if(active&&active.extension==='md'&&!Core.excluded(active.path,this.plugin.settings.excludes)&&active.stat.size<=300000){
          const text=await this.app.vault.cachedRead(active);
          if(!this.plugin.isPrivate(active))sources=[{path:active.path,text:Core.cleanText(text).slice(0,1800),start:0},...sources.filter(s=>s.path!==active.path)];
        }
      }
      if(signal.aborted)throw new Error('Abgebrochen.');
      const thorough=!cloud&&this.deepCheck.checked;
      const built=Core.buildMessages(question,sources,cloud?[]:this.history,this.mode.value,this.plugin.settings.ctx,thorough);
      built.messages[0].content+='\nAktives Modell: '+model+'. Betriebsart: '+(cloud?'Ollama Cloud (online)':'lokal auf diesem PC')+'.';
      this.status.textContent=`${index.files} Notizen durchsucht · ${built.sources.length} Ausschnitte verwendet${index.skipped?' · '+index.skipped+' ausgeschlossen/zu groß':''}.`;
      this.showSources(answerBox,built.sources);
      if(cloud){
        answerText.textContent='Warte auf Freigabe der Online-Vorschau …';
        if(!await this.confirmCloud(model,built.messages,signal))throw new Error('Online-Anfrage nicht freigegeben. Nichts gesendet.');
      }
      if(signal.aborted)throw new Error('Abgebrochen.');
      answerText.textContent='Modell lädt / antwortet …';submitted=true;
      const started=Date.now();

      const generate=(messages,onToken,max=900)=>localRequest('/api/chat',cloud?{model,messages,stream:true,options:{num_predict:max}}:{model,messages,stream:true,think:false,keep_alive:this.plugin.settings.keepAlive,options:{temperature:0.2,num_ctx:this.plugin.settings.ctx,num_predict:max}},{signal,timeout:300000,onToken,allowCloud:cloud});
      let response,review='',draft='';
      const displayToken=token=>{received+=token;if(!this.closed){answerText.textContent=received;this.chat.scrollTop=this.chat.scrollHeight;}};
      if(thorough){
        answerText.textContent='1/3 · Entwurf wird erstellt …';
        const first=await generate(built.messages,()=>{},650);draft=first.message.content;
        if(!draft.trim())throw new Error('Kein Entwurf erhalten. Bitte ein anderes lokales Modell versuchen.');
        if(!this.closed)answerText.textContent='2/3 · Prüfe den Entwurf auf unbelegte Aussagen, Widersprüche und fehlende Schritte …';
        const base=[built.messages[0],built.messages[built.messages.length-1]];
        const reviewMessages=[...base,{role:'assistant',content:draft.slice(0,1800)},{role:'user',content:'Prüfe diesen Antwortentwurf ausschließlich gegen Auftrag und beigefügte Quellen. Liefere eine kurze Mängelliste: unbelegte Behauptungen, Quellenkonflikte, fehlende Angaben oder Schritte. Keine ausführlichen internen Überlegungen. Erfinde keine neuen Fakten. Wenn kein konkreter Mangel erkennbar ist, sage das.'}];
        const second=await generate(reviewMessages,()=>{},400);review=second.message.content;
        if(!review.trim())throw new Error('Keine Prüfung erhalten. Keine Endfassung als geprüft ausgegeben.');
        if(!this.closed)answerText.textContent='3/3 · Endfassung wird erstellt …';
        response=await generate([...base,{role:'assistant',content:draft.slice(0,1400)},{role:'user',content:'Erstelle die endgültige Antwort zum ursprünglichen Auftrag. Berücksichtige diese möglicherweise ebenfalls fehlerhafte Mängelliste nur, soweit Quellen und Auftrag sie stützen. Keine erfundenen Fakten, keine falschen Aktionsbestätigungen. Gib die Endantwort mit Unsicherheiten und passenden Quellen aus.\nMängelliste:\n'+review.slice(0,1000)}],displayToken);
      }else response=await generate(built.messages,displayToken,this.mode.value==='chat'?450:700);
      if(!received.trim())throw new Error('Das Modell hat keinen Antworttext geliefert. Bitte ein anderes lokales Modell versuchen.');
      const record={question,answer:received,model,route:cloud?'cloud':'local',sources:built.sources,created:new Date().toISOString(),thorough,seconds:Math.round((Date.now()-started)/1000)};
      this.records.push(record);this.records=this.records.slice(-20);this.history.push({role:'user',content:question},{role:'assistant',content:received});this.history=this.history.slice(-6);
      let persisted=true;
      try{await this.plugin.remember(record);}catch(e){persisted=false;if(!this.closed)new Notice('Antwort erstellt, Chat aber nicht dauerhaft gespeichert: '+e.message,10000);}
      if(this.closed)return;
      answerBox.createEl('small',{text:record.seconds+' s · '+model+' · '+(thorough?'3 Durchgänge mit demselben Modell; kein unabhängiger Beweis':'1 Durchgang')+' · '+(persisted?'Chat gespeichert':'Chat NICHT gespeichert')+(response.done_reason==='length'?' · Ausgabelimit erreicht':'')});
      answerBox.createEl('small',{text:(thorough?'Endfassung: ':'')+timing(response)});
      if(thorough){const report=answerBox.createEl('details');report.createEl('summary',{text:'Kurze Modellprüfung ansehen'});report.createEl('p',{text:review});}
      this.answerActions(answerBox,record);
      this.input.value='';
    }catch(e){
      if(!this.closed){answerText.textContent=(received?received+'\n\n[Unvollständige Antwort]\n':'')+e.message;this.status.textContent=submitted?'Anfrage beendet; keine Notiz gespeichert.':'Anfrage nicht an das Modell gesendet.';}
    }finally{this.controller=null;if(!this.closed){this.setBusy(false);this.input.focus();this.chat.scrollTop=this.chat.scrollHeight;}}
  }

  answerActions(parent,record){
    const actions=parent.createDiv({cls:'mlb-answer-actions'});
    actions.createEl('button',{text:'Als Wissensnotiz speichern'}).onclick=()=>new SaveNoteModal(this.app,this.plugin,record,false).open();
    actions.createEl('button',{text:'Als Aufgabennotiz speichern'}).onclick=()=>new SaveNoteModal(this.app,this.plugin,record,true).open();
    actions.createEl('button',{text:'Korrektur / Präferenz merken'}).onclick=()=>new MemoryModal(this.app,this.plugin,record).open();
    actions.createEl('button',{text:'Hilfreich'}).onclick=()=>this.plugin.rate(record.created,'hilfreich').then(()=>new Notice('Bewertung gespeichert.')).catch(e=>new Notice(e.message));
    actions.createEl('button',{text:'Fehlerhaft'}).onclick=()=>this.plugin.rate(record.created,'fehlerhaft').then(()=>new Notice('Bewertung gespeichert. Nutze „Korrektur merken“ für die richtige Information.')).catch(e=>new Notice(e.message));
    actions.createEl('button',{text:'Antwort kopieren'}).onclick=()=>navigator.clipboard.writeText(record.answer).then(()=>new Notice('Antwort kopiert.')).catch(()=>new Notice('Text bitte manuell kopieren.'));
  }
  showSources(parent,sources){
    const block=parent.createEl('details',{cls:'mlb-sources'});block.createEl('summary',{text:`Verwendeter Kontext (${sources.length} Ausschnitte; kein Beleg für die Richtigkeit jeder Aussage)`});
    sources.forEach((s,i)=>{
      const item=block.createDiv();const b=item.createEl('button',{text:`Q${i+1} · ${s.path}`});b.onclick=()=>this.app.workspace.openLinkText(s.path,'',true);
      item.createEl('pre',{text:s.text});
    });
  }
  async onClose(){this.closed=true;this.controller?.abort();this.history=[];this.records=[];}
}

class BrainSettings extends PluginSettingTab{
  constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
  display(){
    const el=this.containerEl;el.empty();el.createEl('h2',{text:'Marvins lokale KI'});
    const rated=this.plugin.session.filter(r=>r.rating);
    el.createEl('p',{text:'Letzte 20 Gespräche: '+rated.filter(r=>r.rating==='hilfreich').length+' hilfreich, '+rated.filter(r=>r.rating==='fehlerhaft').length+' fehlerhaft bewertet. Diese Nutzerbewertungen sind kein Leistungsbenchmark.'});

    el.createEl('p',{text:'Feste Verbindung: http://127.0.0.1:11434. Keine API-Schlüssel im Plugin; Online-Anmeldung übernimmt Ollama. Kein automatischer Cloud-Fallback. Modelle werden in der KI-Ansicht gewählt.'});
    new Setting(el).setName('Modell im Speicher halten').setDesc('10 Minuten vermeiden häufiges Neuladen. Belegt RAM; bei Speicherdruck kürzer wählen oder Modell entladen.').addDropdown(d=>d.addOption('1m','1 Minute').addOption('10m','10 Minuten').addOption('30m','30 Minuten').setValue(this.plugin.settings.keepAlive).onChange(async value=>{this.plugin.settings.keepAlive=value;await this.plugin.saveSettings();}));
    new Setting(el).setName('Kontextgröße').setDesc('4096 spart RAM. 8192 erlaubt mehr Notiztext, benötigt aber mehr Speicher.').addDropdown(d=>d.addOption('4096','Sparsam · 4096').addOption('8192','Mehr Kontext · 8192').setValue(String(this.plugin.settings.ctx)).onChange(async value=>{this.plugin.settings.ctx=Number(value);await this.plugin.saveSettings();}));
    new Setting(el).setName('Ausgeschlossene Ordner oder Dateien').setDesc('Ein Vault-Pfad pro Zeile. Vorlagen, Archiv und ungeprüfte KI-Ausgaben sind standardmäßig ausgenommen. Zusätzlich schließt ki-privat: true in den Notizeigenschaften eine Datei aus.').addTextArea(t=>t.setValue(this.plugin.settings.excludes).onChange(async value=>{this.plugin.settings.excludes=value;this.plugin.cache.clear();await this.plugin.saveSettings();}));
    el.createEl('p',{text:'Es werden nur Markdown-Notizen gelesen, keine PDFs, Bilder oder Anhänge. Dateien über 300 KB und ein Gesamtumfang über 8 Millionen Zeichen werden nicht vollständig indexiert; die Ansicht meldet ausgelassene Dateien. Nach Änderungen an Notizen wird der Suchindex bei der nächsten Frage aktualisiert.'});
    el.createEl('p',{text:'Gespeicherte Ergebnisse liegen als neue Entwurfsnotizen in 61 KI Ergebnisse. Prüfe eine Erkenntnis und übernimm sie bei Bedarf manuell in deine bestehende Wissensnotiz. Das ist Wissenspflege, kein Modelltraining.'});
  }
}

class MarvinLocalBrain extends Plugin{
  async onload(){

    const stored=await this.loadData();
    this.settings={...DEFAULTS,...(stored?.settings||stored||{})};
    this.session=Array.isArray(stored?.session)?stored.session.filter(r=>r&&typeof r.question==='string'&&typeof r.answer==='string').slice(-20).map(r=>({...r,sources:Array.isArray(r.sources)?r.sources:[]})):[];
    this.persistTail=Promise.resolve();

    if(![4096,8192].includes(this.settings.ctx))this.settings.ctx=4096;
    if(!['1m','10m','30m'].includes(this.settings.keepAlive))this.settings.keepAlive='10m';
    this.cache=new Map();
    this.registerView(VIEW,leaf=>new BrainView(leaf,this));
    this.addRibbonIcon('brain','Marvins KI öffnen',()=>this.activate());
    this.addCommand({id:'open-brain',name:'Marvins KI öffnen',callback:()=>this.activate()});
    this.addSettingTab(new BrainSettings(this.app,this));
    this.registerEvent(this.app.vault.on('modify',file=>this.cache.delete(file.path)));
    this.registerEvent(this.app.vault.on('delete',file=>this.cache.delete(file.path)));
    this.registerEvent(this.app.vault.on('rename',(file,old)=>{this.cache.delete(old);this.cache.delete(file.path);}));
  }

  async saveSettings(){
    const snapshot=JSON.parse(JSON.stringify({version:2,settings:this.settings,session:this.session}));
    this.persistTail=this.persistTail.catch(()=>{}).then(()=>this.saveData(snapshot));return this.persistTail;
  }
  async remember(record){
    const stored={...record,question:record.question.slice(0,2000),answer:record.answer.slice(0,14000),sources:record.sources.map(s=>({path:s.path}))};
    this.session=[...this.session,stored].slice(-20);await this.saveSettings();
  }
  async clearSession(){const previous=this.session;this.session=[];try{await this.saveSettings();}catch(e){this.session=previous;throw e;}}
  async rate(created,rating){
    const entry=this.session.find(r=>r.created===created);if(!entry)throw new Error('Dieses Gespräch liegt nicht mehr unter den letzten 20 Einträgen.');
    entry.rating=rating;await this.saveSettings();
  }
  async saveMemory(title,text,record){
    const folder='62 KI Gedaechtnis';
    if(!this.app.vault.getAbstractFileByPath(folder)){try{await this.app.vault.createFolder(folder);}catch(e){if(!this.app.vault.getAbstractFileByPath(folder))throw e;}}
    const stamp=new Date().toISOString().replace(/[T:.Z]/g,'-');
    const base=folder+'/'+stamp+' '+Core.safeTitle(title);let path=base+'.md',n=2;while(this.app.vault.getAbstractFileByPath(path))path=base+' '+(n++)+'.md';
    const body='---\ntyp: korrektur\nstatus: nutzerangabe\nstand: '+JSON.stringify(new Date().toISOString())+'\n---\n\n# '+Core.safeTitle(title)+'\n\n## Von Marvin bestätigte Angabe\n'+Core.safeMarkdown(text.slice(0,6000))+'\n\n## Zugehörige Frage\n'+Core.safeMarkdown(record.question)+'\n\nNutzerangabe; keine unabhängige Tatsachenprüfung. Bei einer Änderung diese Notiz in Obsidian aktualisieren oder archivieren.\n';
    const file=await this.app.vault.create(path,body);new Notice('Gedächtnisnotiz gespeichert. Bei passenden Fragen wird sie berücksichtigt.');return file;
  }

  async activate(){
    let leaf=this.app.workspace.getLeavesOfType(VIEW)[0];
    if(!leaf){leaf=this.app.workspace.getLeaf('tab');await leaf.setViewState({type:VIEW,active:true});}
    await this.app.workspace.revealLeaf(leaf);
  }
  isPrivate(file){const fm=this.app.metadataCache.getFileCache(file)?.frontmatter;return fm?.['ki-privat']===true||fm?.['ki-privat']==='true';}
  async buildIndex(signal){
    const chunks=[];let files=0,skipped=0,size=0;
    const all=this.app.vault.getMarkdownFiles().slice().sort((a,b)=>a.path.localeCompare(b.path));
    const live=new Set(all.map(f=>f.path));for(const path of this.cache.keys())if(!live.has(path))this.cache.delete(path);
    for(const file of all){
      if(signal?.aborted)throw new Error('Abgebrochen.');
      if(Core.excluded(file.path,this.settings.excludes)||file.stat.size>300000||this.isPrivate(file)){this.cache.delete(file.path);skipped++;continue;}
      let entry=this.cache.get(file.path);
      if(!entry||entry.mtime!==file.stat.mtime||entry.size!==file.stat.size){
        const text=await this.app.vault.cachedRead(file);entry={mtime:file.stat.mtime,size:file.stat.size,textlen:text.length,chunks:Core.splitNote(file.path,text)};this.cache.set(file.path,entry);
      }
      if(size+entry.textlen>8000000){this.cache.delete(file.path);skipped++;continue;}
      size+=entry.textlen;chunks.push(...entry.chunks);files++;
      if(files%20===0)await new Promise(resolve=>setTimeout(resolve,0));
    }
    return{chunks,files,skipped};
  }
  async saveResult(title,answer,record,asTasks){
    const folder='61 KI Ergebnisse';
    if(!this.app.vault.getAbstractFileByPath(folder)){
      try{await this.app.vault.createFolder(folder);}catch(e){if(!this.app.vault.getAbstractFileByPath(folder))throw e;}
    }
    const stamp=new Date().toISOString().replace(/[T:.Z]/g,'-');
    const basename=`${folder}/${stamp} ${Core.safeTitle(title)}`;
    let path=basename+'.md',n=2;while(this.app.vault.getAbstractFileByPath(path))path=basename+' '+(n++)+'.md';
    const refs=[...new Set(record.sources.map(s=>s.path))].map(p=>'- [['+p.replace(/\.md$/,'')+']]').join('\n');
    const body=`---\ntyp: ${asTasks?'aufgaben':'wissen'}\nstatus: ki-entwurf\nerstellt: ${JSON.stringify(record.created)}\nmodell: ${JSON.stringify(record.model)}\n---\n\n# ${Core.safeTitle(title)}\n\n> KI-Entwurf. Vor einer Übernahme in bestätigtes Wissen prüfen.\n\n## Auftrag\n${Core.safeMarkdown(record.question)}\n\n## Ergebnis\n${Core.safeMarkdown(answer)}\n\n## Verwendeter Kontext\n${refs||'Keine Notizquellen.'}\n`;
    const file=await this.app.vault.create(path,body);
    await this.app.workspace.getLeaf('tab').openFile(file);new Notice('Neue KI-Entwurfsnotiz gespeichert.');return file;
  }
  onunload(){for(const leaf of this.app.workspace.getLeavesOfType(VIEW))leaf.view?.controller?.abort();this.cache?.clear();}
}
module.exports=MarvinLocalBrain;
module.exports.__test={localRequest,BrainView,SaveNoteModal,CloudPreview,DEFAULTS};
