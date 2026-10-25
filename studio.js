import './style.css';
import { PCM_RATE, createSocket, toast } from './common.js';

const $ = (id) => document.getElementById(id);
const sess = new URLSearchParams(location.search).get('sess');

// Qualidades: largura máxima, qualidade do JPEG e quadros por segundo.
const PRESETS = {
  max: { width: 1280, quality: 0.62, fps: 10 },
  alta: { width: 960, quality: 0.6, fps: 8 },
  media: { width: 720, quality: 0.55, fps: 8 },
  eco: { width: 480, quality: 0.5, fps: 6 },
};

function gate(title, text) {
  $('gate').classList.remove('hidden');
  $('gateTitle').textContent = title;
  $('gateText').textContent = text;
}

if (!sess) {
  gate('Link inválido', 'Abra o estúdio pelo botão “Abrir estúdio” dentro da Activity da VibeRoom, no Discord.');
  throw new Error('sem sess');
}

const socket = createSocket({ path: '/ws', params: { sess }, auth: { sess } });

let viewers = 0;
let live = false;
let denied = false;

function setConn(text, kind) {
  const pill = $('connPill');
  pill.textContent = text;
  pill.className = 'pill' + (kind ? ` ${kind}` : '');
}

socket.on('connect', () => setConn('Conectado', 'ok'));
socket.on('disconnect', () => { if (!denied) setConn('Reconectando…', 'err'); });
socket.on('connect_error', (error) => {
  setConn('Sem conexão', 'err');
  if (/inválido|expirado/i.test(error.message)) {
    denied = true;
    gate('Link expirado', 'Volte para a Activity no Discord e clique em “Abrir estúdio” de novo.');
  }
});
socket.on('studio:denied', ({ message }) => {
  denied = true;
  stopShare(false);
  gate('Estúdio encerrado', message);
});
socket.on('room:state', (state) => {
  live = state.live;
  viewers = Math.max(0, state.members.filter((m) => !m.isOwner).length);
  $('viewersPill').textContent = `👥 ${viewers} assistindo`;
  $('statViewers').textContent = String(viewers);
  $('livePill').classList.toggle('hidden', !live);
});

// ── Estatísticas ─────────────────────────────────────────────────────────────
const stats = { frames: 0, bytes: 0 };
setInterval(() => {
  $('statFps').textContent = String(stats.frames);
  $('statRate').textContent = `${Math.round(stats.bytes / 1024)} KB/s`;
  stats.frames = 0;
  stats.bytes = 0;
}, 1000);

// ── Áudio: mistura microfone + som da tela e manda em PCM 16-bit mono ────────
let audioCtx = null;
let bus = null;
let micStream = null;
let micOn = false;
let screenAudioNode = null;

function ensureAudio() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AC();
  bus = audioCtx.createGain();
  const processor = audioCtx.createScriptProcessor(2048, 1, 1);
  const silent = audioCtx.createGain();
  silent.gain.value = 0; // o processor precisa estar ligado à saída, mas não queremos ouvir eco
  bus.connect(processor);
  processor.connect(silent);
  silent.connect(audioCtx.destination);

  processor.onaudioprocess = (event) => {
    if (!socket.connected || denied) return;
    const input = event.inputBuffer.getChannelData(0);
    const samples = resample(input, audioCtx.sampleRate, PCM_RATE);
    let peak = 0;
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    if (peak < 0.0008) return; // silêncio: não gasta internet
    socket.sendAudio(pcm.buffer);
    $('statAudio').textContent = 'transmitindo';
    clearTimeout(ensureAudio.timer);
    ensureAudio.timer = setTimeout(() => { $('statAudio').textContent = 'silêncio'; }, 800);
  };
}

function resample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function updateMicUI() {
  $('micBtn').textContent = `🎙️ Microfone: ${micOn ? 'ligado' : 'desligado'}`;
  $('micBtn').classList.toggle('primary', micOn);
}

$('micBtn').onclick = async () => {
  if (!micStream) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      toast('Não consegui acessar o microfone. Libere a permissão no navegador.');
      return;
    }
    ensureAudio();
    await audioCtx.resume();
    audioCtx.createMediaStreamSource(micStream).connect(bus);
    micOn = true;
  } else {
    micOn = !micOn;
    micStream.getAudioTracks().forEach((track) => { track.enabled = micOn; });
  }
  updateMicUI();
};

// ── Vídeo: captura a tela, converte cada quadro em JPEG e envia ──────────────
let screenStream = null;
let running = false;
let busy = false;
let canvas = null;
let canvasCtx = null;

const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
let fileUrl = null;

/** Começa a transmitir a partir de um "stream" (tela, câmera ou vídeo do aparelho). */
async function beginCapture(stream, { isFile = false } = {}) {
  screenStream = stream;
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    toast('Não encontrei imagem para transmitir.');
    return stopShare(false);
  }
  videoTrack.addEventListener('ended', () => stopShare(true));

  const preview = $('preview');
  if (!isFile) preview.srcObject = stream; // no vídeo do aparelho o próprio <video> já mostra o arquivo
  preview.classList.remove('hidden');
  $('previewEmpty').classList.add('hidden');
  $('sources').classList.add('hidden');
  $('stopBtn').classList.remove('hidden');

  if (stream.getAudioTracks().length) {
    ensureAudio();
    await audioCtx.resume();
    screenAudioNode = audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    screenAudioNode.connect(bus);
  }

  running = true;
  if ('MediaStreamTrackProcessor' in window) pumpWithProcessor(videoTrack);
  else pumpWithTimer(preview);
}

async function startScreen() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: true,
    });
    await beginCapture(stream);
  } catch {
    toast(
      isMobile
        ? 'Este aparelho não compartilha a tela pelo navegador (vale para qualquer marca). Use Câmera ou Vídeo do aparelho.'
        : 'Compartilhamento cancelado ou bloqueado pelo navegador.',
    );
  }
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false, // o som é o do botão Microfone
    });
    await beginCapture(stream);
  } catch {
    toast('Não consegui abrir a câmera. Libere a permissão da câmera no navegador.');
  }
}

/** Escolhe um vídeo da galeria e transmite (imagem + som do vídeo). */
function startFile(file) {
  const preview = $('preview');
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = URL.createObjectURL(file);
  preview.srcObject = null;
  preview.src = fileUrl;
  preview.muted = false;
  preview.loop = true;
  preview.controls = true;
  preview.classList.remove('hidden');
  $('previewEmpty').classList.add('hidden');
  preview.addEventListener(
    'playing',
    () => {
      const capture = preview.captureStream || preview.mozCaptureStream;
      if (!capture) return toast('Este navegador não consegue transmitir vídeo do aparelho.');
      beginCapture(capture.call(preview), { isFile: true });
    },
    { once: true },
  );
  preview.play().catch(() => toast('Toque no botão ▶ do vídeo para começar a transmitir.'));
}

function stopShare(notify = true) {
  running = false;
  busy = false;
  screenAudioNode?.disconnect();
  screenAudioNode = null;
  screenStream?.getTracks().forEach((track) => track.stop());
  screenStream = null;
  const preview = $('preview');
  preview.pause();
  preview.srcObject = null;
  preview.removeAttribute('src');
  preview.load();
  preview.controls = false;
  preview.muted = true;
  preview.classList.add('hidden');
  if (fileUrl) {
    URL.revokeObjectURL(fileUrl);
    fileUrl = null;
  }
  $('previewEmpty').classList.remove('hidden');
  $('sources').classList.remove('hidden');
  $('stopBtn').classList.add('hidden');
  if (notify && socket.connected) socket.emit('studio:stop');
}

/** Envia um quadro; o "ack" do servidor libera o próximo (a internet lenta manda menos quadros). */
async function sendBlob(blob) {
  if (!socket.connected) {
    busy = false;
    return;
  }
  const buffer = await blob.arrayBuffer();
  const release = setTimeout(() => { busy = false; }, 1500);
  socket.sendFrame(buffer, () => {
    clearTimeout(release);
    busy = false;
    stats.frames += 1;
    stats.bytes += buffer.byteLength;
  });
}

function drawToCanvas(source, srcW, srcH, preset) {
  const width = Math.min(preset.width, srcW);
  const height = Math.round((width * srcH) / srcW);
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    canvasCtx = canvas.getContext('2d');
  }
  canvasCtx.drawImage(source, 0, 0, width, height);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: preset.quality });
}

// Chrome/Edge: lê os quadros direto da captura — continua funcionando mesmo com esta aba em segundo plano.
async function pumpWithProcessor(track) {
  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();
  let last = 0;
  while (running) {
    const { value: frame, done } = await reader.read();
    if (done) break;
    const preset = PRESETS[$('quality').value];
    const now = performance.now();
    if (busy || now - last < 1000 / preset.fps) {
      frame.close();
      continue;
    }
    last = now;
    busy = true;
    try {
      const blob = await drawToCanvas(frame, frame.displayWidth, frame.displayHeight, preset);
      frame.close();
      await sendBlob(blob);
    } catch {
      frame.close();
      busy = false;
    }
  }
  reader.cancel().catch(() => {});
}

// Plano B (outros navegadores): usa um temporizador. Mantenha esta aba visível.
function pumpWithTimer(video) {
  $('hint').textContent = '⚠ Este navegador não permite transmitir em segundo plano. Mantenha esta aba visível (ou use Chrome/Edge).';
  const tick = async () => {
    if (!running) return;
    const preset = PRESETS[$('quality').value];
    if (!busy && video.videoWidth) {
      busy = true;
      try {
        const blob = await drawToCanvas(video, video.videoWidth, video.videoHeight, preset);
        await sendBlob(blob);
      } catch {
        busy = false;
      }
    }
    setTimeout(tick, 1000 / preset.fps);
  };
  tick();
}

$('shareBtn').onclick = startScreen;
$('camBtn').onclick = startCamera;
$('fileBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (file) startFile(file);
};
if (isMobile) $('mobileNote').classList.remove('hidden');
$('stopBtn').onclick = () => stopShare(true);
window.addEventListener('beforeunload', () => { if (socket.connected) socket.emit('studio:stop'); });
