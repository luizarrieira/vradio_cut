// renderer.js — Versão Web (Sem Node/Electron)
import { stationsData } from './stations.js';
import { getNewsSubsetForDay } from './adv_news_list.js';

/* =================== Utils de Arquivo (Substitutos do Node) =================== */
// Simula path.basename do Node
function getBasename(pathStr, ext) {
  let name = pathStr.split('/').pop();
  if (ext && name.endsWith(ext)) {
    name = name.slice(0, -ext.length);
  } else if (ext === undefined && name.includes('.')) {
    // Se não passar extensão, remove a última
    name = name.replace(/\.[^/.]+$/, "");
  }
  return name;
}

/* =================== Configurações Globais =================== */
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContextClass();

const SAMPLE_RATE = 48000;

// Configuração de Ducking
const DUCK_DOWN_TIME = 0.05; 
const DUCK_UP_TIME = 0.05;   
const DUCK_RELEASE_DELAY_MS = 100; 

const STATIC_FILE = '0x0DE98BE6.wav';

let audioMetadata = {};
let duracoesNarracoes = {}; 
let staticBuffer = null;
let isSystemStarted = false;
let currentActiveChannelId = 'rock'; 

/* =================== Utils =================== */
function pad(n, len=2){ return String(n).padStart(len, '0'); }
function rand(arr){ return arr && arr.length ? arr[Math.floor(Math.random()*arr.length)] : null; }
function chance(p){ return Math.random() < p; }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function log(prefix, ...args){ console.log(`[${prefix}]`, ...args); }

function weightedPick(items){
  const total = items.reduce((s,i)=>s+i.w,0);
  let r = Math.random()*total;
  for(const it of items){ if(r < it.w) return it.k; r -= it.w; }
  return items[0].k;
}

function samplesToSeconds(samples) {
    return samples / SAMPLE_RATE;
}

/* =================== Global Data Loaders =================== */
async function loadGlobalData() {
  try {
    // Nota: Estes arquivos .json devem estar na raiz do repositório no GitHub
    const metaPath = 'audio_metadata.json';
    try {
        const metaResp = await fetch(metaPath);
        if(metaResp.ok) audioMetadata = await metaResp.json();
    } catch(e) { console.warn("Metadata opcional não encontrado"); }
    
    duracoesNarracoes = {};
    const pathsToTry = [
        `RADIO_18_90S_ROCK/duracoes_narracoes.json`, 
        `RADIO_16_SILVERLAKE/duracoes_narracoes.json`,
        `RADIO_01_CLASS_ROCK/duracoes_narracoes.json`,
        `RADIO_34_DLC_HEI4_KULT/duracoes_narracoes.json`
    ];
    for(const p of pathsToTry) {
      try {
        const r = await fetch(p);
        if(r.ok) {
          const d = await r.json();
          Object.assign(duracoesNarracoes, d);
        }
      } catch(e) {}
    }
    
    try {
        const staticResp = await fetch(STATIC_FILE);
        if(staticResp.ok) {
            const staticAb = await staticResp.arrayBuffer();
            staticBuffer = await audioCtx.decodeAudioData(staticAb);
        }
    } catch(e) { console.warn("Chiado estático não encontrado"); }

    log('SYSTEM', 'Dados globais carregados (Web Version).');
  } catch(e) {
    console.error('Erro carregando dados globais:', e);
  }
}

async function getAudioBuffer(filePath) {
  try {
    const resp = await fetch(filePath);
    if (!resp.ok) throw new Error(`404 ${filePath}`);
    const ab = await resp.arrayBuffer();
    return await audioCtx.decodeAudioData(ab);
  } catch (e) {
    console.warn(`Falha ao carregar ${filePath}`, e);
    throw e;
  }
}

/* =================== Fusion Logic =================== */
function getAudioType(pathStr) {
  if (!pathStr) return 'none';
  
  if (pathStr.includes('KULT_AD')) return 'adkult';
  if (pathStr.includes('ID_30') || pathStr.includes('ID_31') || pathStr.includes('ID_32') || pathStr.includes('ID_33') || pathStr.includes('ID_34') || pathStr.includes('ID_35') || pathStr.includes('ID_36')) return 'idlong'; 
  if (pathStr.includes('RADIO_34_DLC_HEI4_KULT') && pathStr.includes('ID_')) return 'idshort';

  if (pathStr.includes('/news/')) return 'news';
  if (pathStr.includes('/adv/')) return 'adv';
  if (pathStr.includes('/musicas/')) return 'music';
  if (pathStr.includes('ID_')) return 'id';
  if (pathStr.includes('MONO_SOLO_')) return 'solo';
  return 'id_solo_general';
}

function getFusionTime(pathA, pathB) {
  if (pathA === null) return 0.0;

  const typeA = getAudioType(pathA);
  const typeB = getAudioType(pathB);

  if (typeA === 'news' || typeB === 'news') return 0.2;

  const metaA = audioMetadata[pathA] || { fusionEndType: pathA.includes('/musicas/') ? 'abrupt' : 'normal' };
  const metaB = audioMetadata[pathB] || { fusionStartType: 'normal' };
  
  const endTypeA = metaA.fusionEndType;
  const startTypeB = metaB.fusionStartType;

  if (typeA === 'music' && pathA.includes('RADIO_34_DLC_HEI4_KULT')) {
      const rankA = (endTypeA === 'fade-out') ? 'normal' : 'possible';
      const rankB = startTypeB;
      if (rankA === 'none' || rankB === 'none') return 0.5;
      if (rankA === 'normal' && rankB === 'normal') return 1.5;
      return 1.0;
  }

  if (typeA === 'idshort' || typeB === 'idshort') return 1.0;
  if (typeA === 'idlong') return 2.0;
  if (typeB === 'idlong') return 1.0;
  if (typeA === 'adkult' || typeB === 'adkult') return 0.5;

  if (endTypeA === 'none' || startTypeB === 'none') return 0.0;
  
  if (typeA === 'music') {
    if (endTypeA === 'fade-out') return startTypeB === 'normal' ? 1.5 : 1.0;
    if (endTypeA === 'abrupt') return startTypeB === 'normal' ? 1.0 : 0.5;
    return 0.2; 
  }
  if (typeA === 'adv' && typeB === 'id') return (endTypeA === 'normal' && startTypeB === 'normal') ? 0.5 : 0.2;
  if (typeA === 'solo' || typeA === 'id' || typeA === 'id_solo_general') {
    return (endTypeA === 'normal' && startTypeB === 'normal') ? 1.0 : 0.5;
  }
  return 0.2;
}

/* =================== CLASSE RÁDIO STATION =================== */
class RadioStation {
  constructor(id, name, basePath, config) {
    this.id = id;
    this.name = name;
    this.basePath = basePath;
    
    // Config agora vem direto do objeto importado, sem fs
    this.files = {
      musicas: config.musicas || [],
      id: config.ids || [],
      solo: config.solos || [],
      adv: config.adv || [],
      news: config.news || [],
      narracoesGeneral: config.general || [],
      introNarrations: config.introNarrations || {},
      timePools: config.timePools || {},
      endto: config.endto || {},
      idshort: config.idshort || [],
      idlong: config.idlong || [],
      adkult: config.adkult || []
    };

    this.started = false;
    this.isPreloading = false;
    this.nextJob = null;
    this.currentFollowupHint = null;
    this.lastTrackPath = null;
    this.timelineEndTime = 0;
    
    this.queues = { music: [], id: [], adv: [] };

    this.masterGain = audioCtx.createGain();
    this.masterGain.connect(audioCtx.destination);
    this.masterGain.gain.value = (id === currentActiveChannelId) ? 1.0 : 0.0;

    this.musicGain = audioCtx.createGain();
    this.musicGain.connect(this.masterGain);
    
    this.narrationGain = audioCtx.createGain();
    this.narrationGain.connect(this.masterGain);

    this.activeNarrations = 0;
    this.duckTimeout = null;
    
    this.duckTargetVolume = (this.id === 'kult') ? 0.5 : 0.4;
  }

  log(...args) { log(this.id.toUpperCase(), ...args); }

  resetQueues() {
    const shuffle = (arr) => { const a = arr.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; };
    this.queues.music = shuffle(this.files.musicas);
    this.queues.id = shuffle(this.files.id);
    this.queues.adv = shuffle(this.files.adv);
  }

  async nextMusic() { if(!this.queues.music.length) this.resetQueues(); return this.queues.music.shift(); }
  async nextID() { if(!this.queues.id.length) this.resetQueues(); return this.queues.id.shift(); }
  async nextAdv() { 
    if(!this.queues.adv.length) this.resetQueues(); 
    return this.queues.adv.length ? this.queues.adv.shift() : null; 
  }

  onNarrationStart() {
    this.activeNarrations++;
    if(this.duckTimeout) { clearTimeout(this.duckTimeout); this.duckTimeout = null; }
    const now = audioCtx.currentTime;
    
    this.musicGain.gain.cancelScheduledValues(now);
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, now);
    this.musicGain.gain.linearRampToValueAtTime(this.duckTargetVolume, now + DUCK_DOWN_TIME);
  }

  onNarrationEnd() {
    this.activeNarrations = Math.max(0, this.activeNarrations-1);
    if(this.activeNarrations === 0) {
      this.duckTimeout = setTimeout(() => {
        const now = audioCtx.currentTime;
        this.musicGain.gain.cancelScheduledValues(now);
        this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, now);
        this.musicGain.gain.linearRampToValueAtTime(1.0, now + DUCK_UP_TIME);
        this.duckTimeout = null;
      }, DUCK_RELEASE_DELAY_MS);
    }
  }

  filterCandidates(pool, zoneLenSamples) {
    if(!pool || !pool.length) return [];
    const out = [];
    for(const p of pool) {
      const fname = p.split('/').pop();
      const dSamples = duracoesNarracoes[fname];
      if(typeof dSamples === 'number' && dSamples <= zoneLenSamples) {
          out.push({path:p, dur:dSamples});
      }
    }
    return out;
  }

  resolveNarration(musicObj, zoneType) {
    const isIntro = zoneType === 'intro';
    const zoneStart = isIntro ? musicObj.introStart : musicObj.finalStart;
    const zoneEnd = isIntro ? musicObj.introEnd : musicObj.finalEnd;
    
    if(zoneStart == null || zoneEnd == null) return null;

    const chanceThreshold = (this.id === 'kult') ? 0.7 : 0.9;
    if(!chance(chanceThreshold)) return null;

    const zoneLenSamples = zoneEnd - zoneStart;
    
    const r = Math.random();
    let pool = [];
    let subgroup = null;

    if(isIntro) {
      if(r < 0.4) pool = this.files.narracoesGeneral;
      else if(r < 0.8) pool = this.files.introNarrations[musicObj.name] || [];
      else {
        const h = new Date().getHours();
        if(h>=4 && h<=10) pool = this.files.timePools.morning || [];
        else if(h>=17 && h<=21) pool = this.files.timePools.evening || [];
      }
    } else {
      if (this.id === 'kult') {
          if(r < 0.7) pool = this.files.narracoesGeneral;
      } else {
          if(r < 0.7) pool = this.files.narracoesGeneral;
          else {
            const k = weightedPick([{k:'toad',w:3}, {k:'tonews',w:2}]);
            pool = this.files.endto[k] || [];
            subgroup = k;
          }
      }
    }
    
    const candidates = this.filterCandidates(pool, zoneLenSamples);
    if(!candidates.length) return null;
    const chosen = candidates[Math.floor(Math.random()*candidates.length)];
    return { ...chosen, subgroup };
  }

  async prepareNextSequence() {
    if(this.isPreloading) return;
    this.isPreloading = true;
    
    let seqType;
    if (this.id === 'kult') {
        seqType = weightedPick([
            {k:'idkult+musica', w:4}, {k:'musica', w:4}, {k:'adkult+idkult+musica', w:3}, {k:'djsolo+musica', w:2}, {k:'adkult+djsolo+musica', w:1}
        ]);
    } else {
        seqType = weightedPick([
            {k:'djsolo+musica', w:4}, {k:'musica', w:4}, {k:'id+musica', w:3}, {k:'adv+id+musica', w:2}, {k:'djsolo+id+musica', w:1}
        ]);
        if(this.currentFollowupHint === 'toad') seqType = 'adv+id+musica';
        else if(this.currentFollowupHint === 'tonews') seqType = 'news+id+musica';
    }

    const job = { type: seqType, items: [], endtoTrigger: null };
    const promises = [];
    
    const add = async (type) => {
      if(type === 'id') { const i = await this.nextID(); if(i) job.items.push({path:i, type:'id'}); }
      if(type === 'adv') { const a = await this.nextAdv(); if(a) job.items.push({path:a, type:'adv'}); }
      if(type === 'solo') { const s = rand(this.files.solo); if(s) job.items.push({path:s, type:'solo'}); }
      
      if(type === 'news') { 
        const today = new Date().getDate();
        const validNewsNames = getNewsSubsetForDay(today);
        
        // CORREÇÃO PARA WEB: Usar o helper getBasename em vez de path.basename
        const todaysNewsPaths = this.files.news.filter(p => {
            const fileName = getBasename(p, '.wav'); 
            return validNewsNames.includes(fileName);
        });

        const n = rand(todaysNewsPaths); 
        if(n) job.items.push({path:n, type:'news'}); 
      }
      
      if(type === 'idkult') {
          const isLong = chance(0.7);
          const pool = isLong ? this.files.idlong : this.files.idshort;
          const selected = rand(pool);
          if(selected) job.items.push({path:selected, type: isLong ? 'idlong' : 'idshort'});
      }
      if(type === 'adkult') {
          const a = rand(this.files.adkult);
          if(a) job.items.push({path:a, type:'adkult'});
      }

      if(type === 'musica') {
        const m = await this.nextMusic();
        if(m) {
          const intro = this.resolveNarration(m, 'intro');
          const final = this.resolveNarration(m, 'final');
          job.items.push({ path: m.arquivo, type:'music', musicObj: m, intro, final });
          if(final) job.endtoTrigger = final.subgroup;
          if(intro) promises.push(getAudioBuffer(intro.path));
          if(final) promises.push(getAudioBuffer(final.path));
        }
      }
    };

    const parts = seqType.split('+');
    for(const p of parts) {
      await add(p === 'djsolo' ? 'solo' : p);
    }

    job.items.forEach(i => promises.push(getAudioBuffer(i.path)));
    
    try {
      await Promise.all(promises);
      this.nextJob = job;
      this.log(`Próxima sequência pronta: ${seqType}`);
    } catch(e) {
      console.error(`Erro preload ${this.id}`, e);
    } finally {
      this.isPreloading = false;
    }
  }

  async executeSequence(job) {
    if(this.timelineEndTime < audioCtx.currentTime) {
      this.timelineEndTime = audioCtx.currentTime + 0.1;
      this.lastTrackPath = null;
    }

    const playbackPromises = [];

    for(const item of job.items) {
      try {
        const buf = await getAudioBuffer(item.path);
        const fusion = getFusionTime(this.lastTrackPath, item.path);
        const start = this.timelineEndTime - fusion;
        
        this.timelineEndTime = start + buf.duration;
        this.lastTrackPath = item.path;

        if(item.type === 'music' && this.id === currentActiveChannelId) {
            const delay = Math.max(0, (start - audioCtx.currentTime)*1000);
            setTimeout(() => {
               if(this.id === currentActiveChannelId) {
                   const el = document.getElementById('capa');
                   if(el) el.src = item.musicObj.capa;
               }
            }, delay);
        }

        if(item.type === 'music') {
          playbackPromises.push(this.playMusic(item, start));
        } else {
          playbackPromises.push(this.playBuffer(buf, start, item.type));
        }
      } catch(e) { console.error(e); }
    }

    Promise.all(playbackPromises).catch(e => console.error(e));
    return this.timelineEndTime;
  }

  playBuffer(buffer, time, type) {
    return new Promise(resolve => {
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      const gain = (type === 'music') ? this.musicGain : this.narrationGain;
      if (type === 'adv' || type === 'news' || type === 'adkult') {
          src.connect(this.narrationGain);
      } else {
          src.connect(gain);
      }
      src.onended = resolve;
      src.start(time);
    });
  }

  async playMusic(item, time) {
    const src = audioCtx.createBufferSource();
    const buf = await getAudioBuffer(item.path);
    src.buffer = buf;
    src.connect(this.musicGain);
    src.start(time);

    if(item.intro) {
      this.scheduleNarration(item.intro, time, item.musicObj.introStart, item.musicObj.introEnd);
    }
    if(item.final) {
      this.scheduleNarration(item.final, time, item.musicObj.finalStart, item.musicObj.finalEnd);
    }
    return new Promise(r => src.onended = r);
  }

  async scheduleNarration(narr, musicStart, zoneStart, zoneEnd) {
    try {
      const buf = await getAudioBuffer(narr.path);
      const narrLengthSamples = buf.length;
      let startOffsetSamples = zoneEnd - narrLengthSamples;
      if (startOffsetSamples < zoneStart) {
          startOffsetSamples = zoneStart;
      }
      const offsetSeconds = samplesToSeconds(startOffsetSamples);
      const absStartTime = musicStart + offsetSeconds; 
      
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.narrationGain);
      
      const now = audioCtx.currentTime;
      const duckDelay = Math.max(0, (absStartTime - now)*1000 - 40);
      setTimeout(() => this.onNarrationStart(), duckDelay);
      
      src.onended = () => this.onNarrationEnd();
      src.start(absStartTime);
    } catch(e) { console.error('Erro ao agendar narração:', e); }
  }

  async run() {
    this.started = true;
    this.resetQueues();
    this.timelineEndTime = audioCtx.currentTime + 0.1; 
    
    while(this.started) {
      try {
        if(!this.nextJob) await this.prepareNextSequence();
        if(!this.nextJob) { await sleep(1000); continue; }
        
        const job = this.nextJob;
        this.nextJob = null;
        this.currentFollowupHint = job.endtoTrigger;
        
        const jobEndTime = await this.executeSequence(job);
        
        this.prepareNextSequence();
        
        const now = audioCtx.currentTime;
        const wakeTime = jobEndTime - 5.0;
        const sleepMs = (wakeTime - now) * 1000;
        if(sleepMs > 0) await sleep(sleepMs);
        
      } catch(e) {
        console.error(`Erro loop ${this.name}`, e);
        await sleep(2000);
      }
    }
  }
}

/* =================== INSTANCES & STARTUP =================== */
let stationRock = null;
let stationSilver = null;
let stationClassRock = null;
let stationKult = null;

async function switchChannel(newId) {
  if(newId === currentActiveChannelId) return;
  
  log('SYSTEM', `Trocando de ${currentActiveChannelId} para ${newId}`);
  
  let oldStation, newStation;
  if(currentActiveChannelId === 'rock') oldStation = stationRock;
  else if(currentActiveChannelId === 'silverlake') oldStation = stationSilver;
  else if(currentActiveChannelId === 'class_rock') oldStation = stationClassRock;
  else if(currentActiveChannelId === 'kult') oldStation = stationKult;

  if(newId === 'rock') newStation = stationRock;
  else if(newId === 'silverlake') newStation = stationSilver;
  else if(newId === 'class_rock') newStation = stationClassRock;
  else if(newId === 'kult') newStation = stationKult;
  
  const now = audioCtx.currentTime;
  
  if(oldStation && oldStation.masterGain) oldStation.masterGain.gain.setValueAtTime(0, now);
  currentActiveChannelId = newId;
  
  if(window.updateRadioUI) window.updateRadioUI(newId);
  
  if(staticBuffer) {
    const src = audioCtx.createBufferSource();
    src.buffer = staticBuffer;
    const staticGain = audioCtx.createGain();
    staticGain.connect(audioCtx.destination);
    src.connect(staticGain);
    src.start(now); 
    staticGain.gain.setValueAtTime(1, now + 2.8);
    staticGain.gain.linearRampToValueAtTime(0, now + 3.0);
  }

  await sleep(2000);
  
  if(newStation) newStation.masterGain.gain.setValueAtTime(1, audioCtx.currentTime);

  const currentImg = newStation.files.musicas.find(m => newStation.lastTrackPath && newStation.lastTrackPath.includes(m.id))?.capa || `${newStation.basePath}/capas/default.jpg`;
  document.getElementById('capa').src = currentImg;
}

async function startSystem() {
  if(isSystemStarted) return;
  isSystemStarted = true;
  
  if(audioCtx.state === 'suspended') await audioCtx.resume();
  
  await loadGlobalData();
  
  // Agora usamos 'stationsData' importado diretamente
  stationRock = new RadioStation('rock', 'Vinewood Boulevard Radio', 'RADIO_18_90S_ROCK', stationsData.getRock());
  stationSilver = new RadioStation('silverlake', 'Radio Mirror Park', 'RADIO_16_SILVERLAKE', stationsData.getSilver());
  stationClassRock = new RadioStation('class_rock', 'Los Santos Rock Radio', 'RADIO_01_CLASS_ROCK', stationsData.getClassRock());
  stationKult = new RadioStation('kult', 'Kult FM 99.1', 'RADIO_34_DLC_HEI4_KULT', stationsData.getKult());
  
  stationRock.run().catch(e => console.error('Rock error', e));
  stationSilver.run().catch(e => console.error('Silver error', e));
  stationClassRock.run().catch(e => console.error('ClassRock error', e));
  stationKult.run().catch(e => console.error('Kult error', e));
  
  log('SYSTEM', 'Sistema iniciado. 4 rádios rodando.');
}

window.__RADIO = {
  startRadio: startSystem,
  switchChannel: switchChannel
};

// Auto start logic via UI button handled in HTML