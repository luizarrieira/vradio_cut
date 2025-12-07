// renderer.js — Correção: Detecção de Narrações e Pipeline Fluido
import { stationsData } from './stations.js';
import { getNewsSubsetForDay } from './adv_news_list.js';

/* =================== Utils de Arquivo =================== */
function getBasename(pathStr, ext) {
  let name = pathStr.split('/').pop();
  if (ext && name.endsWith(ext)) {
    name = name.slice(0, -ext.length);
  } else if (ext === undefined && name.includes('.')) {
    name = name.replace(/\.[^/.]+$/, "");
  }
  return name;
}

/* =================== Configurações Globais =================== */
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContextClass();

const SAMPLE_RATE = 48000;

// Configuração de Ducking (Voz sobre música)
const DUCK_DOWN_TIME = 0.2; 
const DUCK_UP_TIME = 0.2;   
const DUCK_RELEASE_DELAY_MS = 10; 

const STATIC_FILE = '0x0DE98BE6.wav';

let audioMetadata = {};
let duracoesNarracoes = {}; 
let staticBuffer = null;
let isSystemStarted = false;
let currentActiveChannelId = 'rock'; 

/* =================== Utils Gerais =================== */
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
    
    let loadedCount = 0;
    for(const p of pathsToTry) {
      try {
        const r = await fetch(p);
        if(r.ok) {
          const d = await r.json();
          Object.assign(duracoesNarracoes, d);
          loadedCount++;
        }
      } catch(e) {}
    }
    
    if (loadedCount === 0) {
        console.warn("ALERTA: Nenhum arquivo duracoes_narracoes.json carregado. Narrações podem não funcionar.");
    }
    
    try {
        const staticResp = await fetch(STATIC_FILE);
        if(staticResp.ok) {
            const staticAb = await staticResp.arrayBuffer();
            staticBuffer = await audioCtx.decodeAudioData(staticAb);
        }
    } catch(e) { console.warn("Chiado estático não encontrado"); }

    log('SYSTEM', 'Dados globais carregados.');
  } catch(e) {
    console.error('Erro carregando dados globais:', e);
  }
}

// Helper para baixar e decodificar
async function getAudioBuffer(filePath) {
  try {
    const resp = await fetch(filePath);
    if (!resp.ok) throw new Error(`404 ${filePath}`);
    const ab = await resp.arrayBuffer();
    return await audioCtx.decodeAudioData(ab);
  } catch (e) {
    console.warn(`Falha ao carregar ${filePath}`, e);
    return null; 
  }
}

/* =================== Lógica de Fusão =================== */
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
  if (!pathA) return 0.0;

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
    this.duckTargetVolume = (this.id === 'kult') ? 0.5 : 0.3; 
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

  // --- CORREÇÃO IMPORTANTE AQUI: Busca de Duração Robusta ---
  filterCandidates(pool, zoneLenSamples) {
    if(!pool || !pool.length) return [];
    
    const out = [];
    for(const p of pool) {
      // Tenta encontrar a duração no JSON usando várias chaves possíveis
      const fullPath = p; // ex: RADIO_XX/narracoes/FILE.wav
      const fileName = p.split('/').pop(); // ex: FILE.wav
      const fileNameNoExt = fileName.replace('.wav', '').replace('.mp3', ''); // ex: FILE
      
      const dSamples = duracoesNarracoes[fullPath] || duracoesNarracoes[fileName] || duracoesNarracoes[fileNameNoExt];
      
      if(typeof dSamples === 'number') {
        // Se couber na zona, adiciona
        if(dSamples <= zoneLenSamples) {
            out.push({path:p, dur:dSamples});
        }
      } else {
        // Opcional: Descomente para debugar se suas chaves não baterem
        // console.warn('Duração não encontrada para:', p);
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

  // --- FASE 1: PRELOAD ---
  async preloadSequenceJob() {
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
    const parts = seqType.split('+');
    
    const resolveItem = async (type) => {
      if(type === 'djsolo') type = 'solo';
      let itemData = { type, path: null, buffer: null };

      if(type === 'id') itemData.path = await this.nextID();
      else if(type === 'adv') itemData.path = await this.nextAdv();
      else if(type === 'solo') itemData.path = rand(this.files.solo);
      else if(type === 'idkult') {
          const isLong = chance(0.7);
          itemData.path = rand(isLong ? this.files.idlong : this.files.idshort);
      }
      else if(type === 'adkult') {
          itemData.path = rand(this.files.adkult);
      }
      else if(type === 'news') { 
        const today = new Date().getDate();
        const validNewsNames = getNewsSubsetForDay(today);
        const available = this.files.news.filter(p => validNewsNames.includes(getBasename(p, '.wav')));
        itemData.path = rand(available); 
      }
      else if(type === 'musica') {
        const m = await this.nextMusic();
        if(m) {
            itemData.path = m.arquivo;
            itemData.musicObj = m;
            itemData.introObj = this.resolveNarration(m, 'intro');
            itemData.finalObj = this.resolveNarration(m, 'final');
            if(itemData.finalObj) job.endtoTrigger = itemData.finalObj.subgroup;
        }
      }

      if(itemData.path) job.items.push(itemData);
    };

    for(const p of parts) await resolveItem(p);

    const promises = [];
    for (const item of job.items) {
        promises.push(getAudioBuffer(item.path).then(b => item.buffer = b));
        if(item.introObj) promises.push(getAudioBuffer(item.introObj.path).then(b => item.introBuffer = b));
        if(item.finalObj) promises.push(getAudioBuffer(item.finalObj.path).then(b => item.finalBuffer = b));
    }

    await Promise.all(promises);
    job.items = job.items.filter(i => i.buffer !== null);
    return job;
  }

  // --- FASE 2: AGENDAMENTO ---
  scheduleSequence(job) {
    if(!job || !job.items.length) return this.timelineEndTime;

    if(this.timelineEndTime < audioCtx.currentTime) {
        this.timelineEndTime = audioCtx.currentTime + 0.1; 
        this.lastTrackPath = null;
    }

    for(const item of job.items) {
        const fusionTime = getFusionTime(this.lastTrackPath, item.path);
        const startTime = this.timelineEndTime - fusionTime;
        
        this.timelineEndTime = startTime + item.buffer.duration;
        this.lastTrackPath = item.path;

        if(item.type === 'music' && this.id === currentActiveChannelId) {
            const delayMs = Math.max(0, (startTime - audioCtx.currentTime) * 1000);
            setTimeout(() => {
               if(this.id === currentActiveChannelId) {
                   const el = document.getElementById('capa');
                   if(el) el.src = item.musicObj.capa;
               }
            }, delayMs);
        }

        this.playBuffer(item.buffer, startTime, item.type);

        if(item.type === 'music') {
            if(item.introObj && item.introBuffer) {
                this.scheduleOverlay(item.introBuffer, startTime, item.musicObj.introStart, item.musicObj.introEnd);
            }
            if(item.finalObj && item.finalBuffer) {
                this.scheduleOverlay(item.finalBuffer, startTime, item.musicObj.finalStart, item.musicObj.finalEnd);
            }
        }
    }
    
    this.currentFollowupHint = job.endtoTrigger;
    return this.timelineEndTime;
  }

  playBuffer(buffer, time, type) {
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    const gainNode = (type === 'music') ? this.musicGain : this.narrationGain;
    
    if (type === 'adv' || type === 'news' || type === 'adkult') {
        src.connect(this.narrationGain);
    } else {
        src.connect(gainNode);
    }
    src.start(time);
  }

  scheduleOverlay(buffer, musicAbsStart, zoneStartSamples, zoneEndSamples) {
      const len = buffer.length;
      let offset = zoneEndSamples - len;
      if (offset < zoneStartSamples) offset = zoneStartSamples; 
      
      const absStart = musicAbsStart + samplesToSeconds(offset);
      
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.narrationGain);
      
      const now = audioCtx.currentTime;
      // Garante que o ducking só agende se for no futuro ou agora, nunca negativo
      const duckStart = Math.max(0, (absStart - now)*1000 - 50); 
      const durMs = buffer.duration * 1000;
      
      setTimeout(() => this.onNarrationStart(), duckStart);
      setTimeout(() => this.onNarrationEnd(), duckStart + durMs);

      src.start(absStart);
  }

  async run() {
    this.started = true;
    this.resetQueues();
    this.timelineEndTime = audioCtx.currentTime + 0.1;

    let currentJob = await this.preloadSequenceJob();

    while(this.started) {
        try {
            const sequenceFinishTime = this.scheduleSequence(currentJob);

            const nextJobPromise = this.preloadSequenceJob();

            const now = audioCtx.currentTime;
            const waitSeconds = sequenceFinishTime - now - 4.0;
            
            if(waitSeconds > 0) await sleep(waitSeconds * 1000);

            const nextJob = await nextJobPromise;
            
            if(nextJob) currentJob = nextJob;
            else {
                await sleep(500);
                currentJob = await this.preloadSequenceJob();
            }

        } catch(e) {
            console.error(`Erro rádio ${this.name}`, e);
            await sleep(5000);
        }
    }
  }
}

/* =================== STARTUP & SWITCHING =================== */
let stationRock = null;
let stationSilver = null;
let stationClassRock = null;
let stationKult = null;

async function switchChannel(newId) {
  if(newId === currentActiveChannelId) return;
  
  log('SYSTEM', `Mudando: ${currentActiveChannelId} -> ${newId}`);
  
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
  
  if(oldStation) {
      oldStation.masterGain.gain.cancelScheduledValues(now);
      oldStation.masterGain.gain.setTargetAtTime(0, now, 0.2);
  }
  
  currentActiveChannelId = newId;
  if(window.updateRadioUI) window.updateRadioUI(newId);
  
  if(staticBuffer) {
    const src = audioCtx.createBufferSource();
    src.buffer = staticBuffer;
    const staticGain = audioCtx.createGain();
    staticGain.connect(audioCtx.destination);
    src.connect(staticGain);
    src.start(now);
    staticGain.gain.setValueAtTime(0, now);
    staticGain.gain.linearRampToValueAtTime(0.6, now + 0.1); 
    staticGain.gain.exponentialRampToValueAtTime(0.01, now + 1.5);
  }

  if(newStation) {
      newStation.masterGain.gain.cancelScheduledValues(now);
      newStation.masterGain.gain.setValueAtTime(0, now);
      newStation.masterGain.gain.linearRampToValueAtTime(1, now + 1.0);

      const currentTrack = newStation.files.musicas.find(m => 
          newStation.lastTrackPath && newStation.lastTrackPath.includes(m.arquivo.split('/').pop())
      );
      const el = document.getElementById('capa');
      if(el) el.src = currentTrack ? currentTrack.capa : `${newStation.basePath}/capas/default.jpg`;
  }
}

async function startSystem() {
  if(isSystemStarted) return;
  isSystemStarted = true;
  
  if(audioCtx.state === 'suspended') await audioCtx.resume();
  
  await loadGlobalData();
  
  stationRock = new RadioStation('rock', 'Vinewood Boulevard Radio', 'RADIO_18_90S_ROCK', stationsData.getRock());
  stationSilver = new RadioStation('silverlake', 'Radio Mirror Park', 'RADIO_16_SILVERLAKE', stationsData.getSilver());
  stationClassRock = new RadioStation('class_rock', 'Los Santos Rock Radio', 'RADIO_01_CLASS_ROCK', stationsData.getClassRock());
  stationKult = new RadioStation('kult', 'Kult FM 99.1', 'RADIO_34_DLC_HEI4_KULT', stationsData.getKult());
  
  stationRock.run().catch(e => console.error('Rock error', e));
  stationSilver.run().catch(e => console.error('Silver error', e));
  stationClassRock.run().catch(e => console.error('ClassRock error', e));
  stationKult.run().catch(e => console.error('Kult error', e));
  
  log('SYSTEM', 'SISTEMA INICIADO.');
}

window.__RADIO = {
  startRadio: startSystem,
  switchChannel: switchChannel
};
