// renderer.js — Versão Web (Pipeline Otimizado: Carrega Próximo Enquanto Toca Atual)
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

/* =================== Utils =================== */
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

// Helper para baixar e decodificar áudio
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

  // Regra base: Notícias tem fusão rápida
  if (typeA === 'news' || typeB === 'news') return 0.2;

  const metaA = audioMetadata[pathA] || { fusionEndType: pathA.includes('/musicas/') ? 'abrupt' : 'normal' };
  const metaB = audioMetadata[pathB] || { fusionStartType: 'normal' };
  
  const endTypeA = metaA.fusionEndType;
  const startTypeB = metaB.fusionStartType;

  // Regras específicas da Kult FM
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
  
  // Regra geral para falas
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
    this.currentFollowupHint = null; // Dica para o PRÓXIMO job (ex: tocar news depois da musica)
    this.lastTrackPath = null;       // Caminho do arquivo anterior para calcular fusão
    this.timelineEndTime = 0;        // Tempo absoluto do AudioContext onde o próximo áudio deve começar
    
    this.queues = { music: [], id: [], adv: [] };

    // Ganho Mestre (Volume da Rádio)
    this.masterGain = audioCtx.createGain();
    this.masterGain.connect(audioCtx.destination);
    this.masterGain.gain.value = (id === currentActiveChannelId) ? 1.0 : 0.0;

    // Canais de Música e Voz (para Ducking)
    this.musicGain = audioCtx.createGain();
    this.musicGain.connect(this.masterGain);
    
    this.narrationGain = audioCtx.createGain();
    this.narrationGain.connect(this.masterGain);

    this.activeNarrations = 0;
    this.duckTimeout = null;
    this.duckTargetVolume = (this.id === 'kult') ? 0.5 : 0.3; // Kult tem música mais alta no fundo
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

  // --- Ducking System (Abaixa a música quando tem voz) ---
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

  // --- Lógica de Seleção de Narrações (Intro/Outro) ---
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

  // --- PREPARAÇÃO DA SEQUÊNCIA (DOWNLOAD E DECODE) ---
  // Esta função agora retorna o Job pronto com buffers, sem afetar o estado global de reprodução
  async createSequenceJob() {
    let seqType;
    
    // Define a estrutura da próxima sequência
    if (this.id === 'kult') {
        seqType = weightedPick([
            {k:'idkult+musica', w:4}, {k:'musica', w:4}, {k:'adkult+idkult+musica', w:3}, {k:'djsolo+musica', w:2}, {k:'adkult+djsolo+musica', w:1}
        ]);
    } else {
        seqType = weightedPick([
            {k:'djsolo+musica', w:4}, {k:'musica', w:4}, {k:'id+musica', w:3}, {k:'adv+id+musica', w:2}, {k:'djsolo+id+musica', w:1}
        ]);
        // Força tipos específicos baseados na música anterior
        if(this.currentFollowupHint === 'toad') seqType = 'adv+id+musica';
        else if(this.currentFollowupHint === 'tonews') seqType = 'news+id+musica';
    }

    const job = { 
        type: seqType, 
        items: [], 
        endtoTrigger: null 
    };

    // Função auxiliar para adicionar item à lista de download
    const prepareItem = async (type) => {
      let path = null;
      let musicObj = null;
      let introObj = null;
      let finalObj = null;

      if(type === 'id') path = await this.nextID();
      else if(type === 'adv') path = await this.nextAdv();
      else if(type === 'solo') path = rand(this.files.solo);
      else if(type === 'news') { 
        const today = new Date().getDate();
        const validNewsNames = getNewsSubsetForDay(today);
        const todaysNewsPaths = this.files.news.filter(p => validNewsNames.includes(getBasename(p, '.wav')));
        path = rand(todaysNewsPaths); 
      }
      else if(type === 'idkult') {
          const isLong = chance(0.7);
          path = rand(isLong ? this.files.idlong : this.files.idshort);
      }
      else if(type === 'adkult') {
          path = rand(this.files.adkult);
      }
      else if(type === 'musica') {
        musicObj = await this.nextMusic();
        if(musicObj) {
            path = musicObj.arquivo;
            introObj = this.resolveNarration(musicObj, 'intro');
            finalObj = this.resolveNarration(musicObj, 'final');
            if(finalObj) job.endtoTrigger = finalObj.subgroup;
        }
      }

      if(path) {
          job.items.push({ 
              path, 
              type: type === 'djsolo' ? 'solo' : type, // normaliza type
              musicObj, 
              introObj, 
              finalObj,
              buffer: null,      // Será preenchido
              introBuffer: null, // Será preenchido
              finalBuffer: null  // Será preenchido
          });
      }
    };

    // Constrói a lista de itens
    const parts = seqType.split('+');
    for(const p of parts) {
      await prepareItem(p === 'djsolo' ? 'solo' : p);
    }

    // --- CARREGAMENTO PARALELO ---
    // Baixa todos os arquivos necessários para esta sequência AGORA
    // Isso garante que quando o job for executado, não haverá espera
    const downloadPromises = [];

    for (const item of job.items) {
        // Carrega o arquivo principal
        downloadPromises.push(
            getAudioBuffer(item.path).then(buf => item.buffer = buf)
        );

        // Se tiver intro (voz sobre música), carrega também
        if(item.introObj) {
            downloadPromises.push(
                getAudioBuffer(item.introObj.path).then(buf => item.introBuffer = buf)
            );
        }
        // Se tiver final (voz sobre música), carrega também
        if(item.finalObj) {
            downloadPromises.push(
                getAudioBuffer(item.finalObj.path).then(buf => item.finalBuffer = buf)
            );
        }
    }

    try {
        await Promise.all(downloadPromises);
        this.log(`Sequência pronta na memória: ${seqType}`);
        return job;
    } catch(e) {
        console.error(`Erro ao baixar sequência para ${this.id}`, e);
        return null; // Retorna null se falhar para tentar de novo
    }
  }

  // --- AGENDAMENTO (EXECUÇÃO) ---
  // Apenas agenda os buffers já carregados no AudioContext
  async scheduleJob(job) {
    // Se for a primeira vez, define o tempo atual como inicio
    if(this.timelineEndTime < audioCtx.currentTime) {
      this.timelineEndTime = audioCtx.currentTime + 0.1;
      this.lastTrackPath = null;
    }

    for(const item of job.items) {
      if(!item.buffer) continue; // Pula se deu erro no download

      // Calcula fusão com o arquivo ANTERIOR
      const fusion = getFusionTime(this.lastTrackPath, item.path);
      
      // O início deste arquivo é (Fim do anterior - tempo de fusão)
      const startTime = this.timelineEndTime - fusion;
      
      // Atualiza o ponteiro de tempo para o fim deste arquivo
      this.timelineEndTime = startTime + item.buffer.duration;
      this.lastTrackPath = item.path;

      // UI Update (Troca a capa no momento exato)
      if(item.type === 'music' && this.id === currentActiveChannelId) {
          const delayMs = Math.max(0, (startTime - audioCtx.currentTime)*1000);
          setTimeout(() => {
             if(this.id === currentActiveChannelId) {
                 const el = document.getElementById('capa');
                 if(el) el.src = item.musicObj.capa;
             }
          }, delayMs);
      }

      // Agenda o áudio principal
      this.playBuffer(item.buffer, startTime, item.type);

      // Agenda as narrações sobrepostas (Intro/Final) se for música
      if(item.type === 'music') {
          if(item.introObj && item.introBuffer) {
              this.scheduleNarrationOverlay(item.introBuffer, startTime, item.musicObj.introStart, item.musicObj.introEnd);
          }
          if(item.finalObj && item.finalBuffer) {
              this.scheduleNarrationOverlay(item.finalBuffer, startTime, item.musicObj.finalStart, item.musicObj.finalEnd);
          }
      }
    }
    
    return this.timelineEndTime; // Retorna quando essa sequência inteira termina
  }

  playBuffer(buffer, time, type) {
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    
    // Roteamento de canais (Voz vs Música)
    const gainNode = (type === 'music') ? this.musicGain : this.narrationGain;
    
    // Exceção: Comerciais e Notícias saem pelo canal de voz (para dar ducking se necessário, embora raro)
    if (type === 'adv' || type === 'news' || type === 'adkult') {
        src.connect(this.narrationGain);
    } else {
        src.connect(gainNode);
    }
    
    src.start(time);
  }

  scheduleNarrationOverlay(buffer, musicStartTime, zoneStartSamples, zoneEndSamples) {
      const narrLengthSamples = buffer.length;
      
      // Tenta encaixar a fala no final da zona permitida (back-timed)
      let startOffsetSamples = zoneEndSamples - narrLengthSamples;
      
      // Se a fala for maior que a zona, começa no início da zona
      if (startOffsetSamples < zoneStartSamples) {
          startOffsetSamples = zoneStartSamples;
      }
      
      const offsetSeconds = samplesToSeconds(startOffsetSamples);
      const absStartTime = musicStartTime + offsetSeconds;
      
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.narrationGain);
      
      // Agenda o Ducking (abaixar volume da música)
      const now = audioCtx.currentTime;
      // Só agenda ducking se for no futuro
      const duckDelay = Math.max(0, (absStartTime - now)*1000 - 50); // 50ms antes
      
      setTimeout(() => this.onNarrationStart(), duckDelay);
      
      // Agenda fim do Ducking
      const durationMs = buffer.duration * 1000;
      setTimeout(() => this.onNarrationEnd(), duckDelay + durationMs);

      src.start(absStartTime);
  }

  // --- LOOP PRINCIPAL (PIPELINE) ---
  async run() {
    this.started = true;
    this.resetQueues();
    this.timelineEndTime = audioCtx.currentTime + 0.1; 
    
    this.log("Iniciando pipeline...");

    // 1. Carrega o PRIMEIRO job (bloqueante apenas no start)
    let currentJob = await this.createSequenceJob();
    if(!currentJob) return; // Erro fatal

    while(this.started) {
      try {
        // 2. Agenda o job ATUAL para tocar
        // O `scheduleJob` é síncrono no sentido de agendamento (retorna rápido)
        // Ele retorna o `sequenceEndTime` (tempo absoluto que vai acabar)
        const sequenceEndTime = await this.scheduleJob(currentJob);
        
        // Atualiza dica para a próxima geração
        this.currentFollowupHint = currentJob.endtoTrigger;

        // 3. IMEDIATAMENTE começa a carregar o PRÓXIMO job em paralelo
        // Não usamos await aqui ainda!
        const nextJobPromise = this.createSequenceJob();

        // 4. Calcula quanto tempo temos para dormir até precisar trocar de job
        // Queremos acordar um pouco antes do fim da sequência atual (ex: 3 segundos antes)
        const now = audioCtx.currentTime;
        const sleepTimeSec = sequenceEndTime - now - 3.0; // Acorda 3s antes do fim

        if(sleepTimeSec > 0) {
            // Dorme enquanto a música toca e o próximo job baixa em background
            await sleep(sleepTimeSec * 1000);
        }

        // 5. Agora esperamos o download terminar (se já não tiver terminado)
        const nextJob = await nextJobPromise;
        
        if (nextJob) {
            // Troca os ponteiros para o próximo loop
            currentJob = nextJob;
        } else {
            // Se falhou o download, tenta gerar um novo de emergência (curto)
            await sleep(1000); 
            currentJob = await this.createSequenceJob();
        }

      } catch(e) {
        console.error(`Erro crítico no loop da rádio ${this.name}`, e);
        await sleep(5000); // Espera de segurança
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
  
  // Crossfade visual/áudio das estações
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
  
  // Muta a antiga
  if(oldStation && oldStation.masterGain) {
      oldStation.masterGain.gain.cancelScheduledValues(now);
      oldStation.masterGain.gain.setTargetAtTime(0, now, 0.5);
  }
  currentActiveChannelId = newId;
  
  if(window.updateRadioUI) window.updateRadioUI(newId);
  
  // Toca estática na transição
  if(staticBuffer) {
    const src = audioCtx.createBufferSource();
    src.buffer = staticBuffer;
    const staticGain = audioCtx.createGain();
    staticGain.connect(audioCtx.destination);
    src.connect(staticGain);
    src.start(now); 
    staticGain.gain.setValueAtTime(0.8, now);
    staticGain.gain.exponentialRampToValueAtTime(0.01, now + 1.5);
  }

  // Liga a nova
  if(newStation) {
      newStation.masterGain.gain.cancelScheduledValues(now);
      newStation.masterGain.gain.setTargetAtTime(1, now, 0.1);

      // Atualiza capa
      const currentImg = newStation.files.musicas.find(m => newStation.lastTrackPath && newStation.lastTrackPath.includes(m.id))?.capa || `${newStation.basePath}/capas/default.jpg`;
      const el = document.getElementById('capa');
      if(el) el.src = currentImg;
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
  
  // Inicia todas em paralelo
  stationRock.run().catch(e => console.error('Rock error', e));
  stationSilver.run().catch(e => console.error('Silver error', e));
  stationClassRock.run().catch(e => console.error('ClassRock error', e));
  stationKult.run().catch(e => console.error('Kult error', e));
  
  log('SYSTEM', 'Sistema iniciado. Pipeline ativo.');
}

window.__RADIO = {
  startRadio: startSystem,
  switchChannel: switchChannel
};
