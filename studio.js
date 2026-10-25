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
  gate(
    'Link inválido',
    'Abra o estúdio pelo botão “Abrir estúdio” dentro da Activity da VibeRoom, no Discord.'
  );
  throw new Error('sem sess');
}

const socket = createSocket({
  path: '/ws',
  params: { sess },
  auth: { sess }
});

let viewers = 0;
let live = false;
let denied = false;

function setConn(text, kind) {
  const pill = $('connPill');
  pill.textContent = text;
  pill.className = 'pill' + (kind ? ` ${kind}` : '');
}

socket.on('connect', () => setConn('Conectado', 'ok'));

socket.on('disconnect', () => {
  if (!denied) setConn('Reconectando…', 'err');
});

socket.on('connect_error', (error) => {
  setConn('Sem conexão', 'err');

  if (/inválido|expirado/i.test(error.message)) {
    denied = true;
    gate(
      'Link expirado',
      'Volte para a Activity no Discord e clique em “Abrir estúdio” de novo.'
    );
  }
});

socket.on('studio:denied', ({ message }) => {
  denied = true;
  stopShare(false);
  gate('Estúdio encerrado', message);
});

socket.on('room:state', (state) => {
  live = state.live;
  viewers = Math.max(
    0,
    state.members.filter((m) => !m.isOwner).length
  );

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

  silent.gain.value = 0;

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

    if (peak < 0.0008) return;

    socket.sendAudio(pcm.buffer);

    $('statAudio').textContent = 'transmitindo';

    clearTimeout(ensureAudio.timer);

    ensureAudio.timer = setTimeout(() => {
      $('statAudio').textContent = 'silêncio';
    }, 800);
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
  $('micBtn').textContent =
    `🎙️ Microfone: ${micOn ? 'ligado' : 'desligado'}`;

  $('micBtn').classList.toggle('primary', micOn);
}

$('micBtn').onclick = async () => {
  if (!micStream) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (error) {
      console.error('Erro ao acessar o microfone:', error);
      toast('Não consegui acessar o microfone. Libere a permissão no navegador.');
      return;
    }

    ensureAudio();
    await audioCtx.resume();

    audioCtx.createMediaStreamSource(micStream).connect(bus);
    micOn = true;
  } else {
    micOn = !micOn;

    micStream.getAudioTracks().forEach((track) => {
      track.enabled = micOn;
    });
  }

  updateMicUI();
};

// ── Vídeo: captura a tela, converte cada quadro em JPEG e envia ───────────────
let screenStream = null;
let running = false;
let busy = false;
let canvas = null;
let canvasCtx = null;

async function startShare() {
  if (denied) {
    toast('O estúdio não está autorizado. Abra-o novamente pelo Discord.');
    return;
  }

  // Verifica se o navegador oferece a API de captura de tela.
  const getDisplayMedia = navigator.mediaDevices?.getDisplayMedia;

  if (!getDisplayMedia) {
    toast(
      'Este navegador não oferece captura de tela. ' +
      'O compartilhamento móvel ainda precisa de uma solução compatível.'
    );
    return;
  }

  try {
    screenStream = await getDisplayMedia.call(
      navigator.mediaDevices,
      {
        video: {
          frameRate: { ideal: 15 },
          width: { max: 1920 },
          height: { max: 1080 }
        },
        audio: true
      }
    );
  } catch (error) {
    console.error('Erro ao compartilhar a tela:', error);

    if (error.name === 'NotAllowedError') {
      toast('Compartilhamento bloqueado ou permissão negada.');
    } else if (error.name === 'AbortError') {
      toast('O compartilhamento foi cancelado.');
    } else if (error.name === 'NotFoundError') {
      toast('Nenhuma fonte de tela disponível para compartilhar.');
    } else {
      toast('Não foi possível compartilhar a tela neste navegador.');
    }

    screenStream = null;
    return;
  }

  const videoTrack = screenStream.getVideoTracks()[0];

  if (!videoTrack) {
    screenStream.getTracks().forEach((track) => track.stop());
    screenStream = null;

    toast('O navegador não forneceu uma imagem da tela.');
    return;
  }

  videoTrack.addEventListener('ended', () => stopShare(true));

  const preview = $('preview');
  preview.srcObject = screenStream;
  preview.classList.remove('hidden');
  $('previewEmpty').classList.add('hidden');
  $('shareBtn').classList.add('hidden');
  $('stopBtn').classList.remove('hidden');

  if (screenStream.getAudioTracks().length) {
    try {
      ensureAudio();
      await audioCtx.resume();

      screenAudioNode = audioCtx.createMediaStreamSource(
        new MediaStream(screenStream.getAudioTracks())
      );

      screenAudioNode.connect(bus);
    } catch (error) {
      console.error('Erro ao transmitir o áudio da tela:', error);
      toast('A tela foi capturada, mas não foi possível ativar o áudio.');
    }
  }

  running = true;

  if ('MediaStreamTrackProcessor' in window) {
    pumpWithProcessor(videoTrack);
  } else {
    pumpWithTimer(preview);
  }
}

function stopShare(notify = true) {
  running = false;
  busy = false;

  screenAudioNode?.disconnect();
  screenAudioNode = null;

  screenStream?.getTracks().forEach((track) => track.stop());
  screenStream = null;

  const preview = $('preview');

  if (preview) {
    preview.srcObject = null;
    preview.classList.add('hidden');
  }

  $('previewEmpty').classList.remove('hidden');
  $('shareBtn').classList.remove('hidden');
  $('stopBtn').classList.add('hidden');

  if (notify && socket.connected) {
    socket.emit('studio:stop');
  }
}

/** Envia um quadro; o ack do servidor libera o próximo. */
async function sendBlob(blob) {
  if (!socket.connected || denied) {
    busy = false;
    return;
  }

  const buffer = await blob.arrayBuffer();

  const release = setTimeout(() => {
    busy = false;
  }, 1500);

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

  return canvas.convertToBlob({
    type: 'image/jpeg',
    quality: preset.quality
  });
}

// Chrome/Edge compatíveis: lê os quadros diretamente da captura.
async function pumpWithProcessor(track) {
  let reader;

  try {
    const processor = new MediaStreamTrackProcessor({ track });
    reader = processor.readable.getReader();

    let last = 0;

    while (running) {
      const { value: frame, done } = await reader.read();

      if (done) break;

      const preset = PRESETS[$('quality').value] || PRESETS.media;
      const now = performance.now();

      if (busy || now - last < 1000 / preset.fps) {
        frame.close();
        continue;
      }

      last = now;
      busy = true;

      try {
        const blob = await drawToCanvas(
          frame,
          frame.displayWidth,
          frame.displayHeight,
          preset
        );

        frame.close();
        await sendBlob(blob);
      } catch (error) {
        console.error('Erro ao processar quadro:', error);
        frame.close();
        busy = false;
      }
    }
  } catch (error) {
    console.error('Erro na captura de quadros:', error);
    toast('A captura começou, mas não foi possível processar o vídeo.');
    stopShare(true);
  } finally {
    reader?.cancel().catch(() => {});
  }
}

// Plano B para navegadores sem MediaStreamTrackProcessor.
// Mantenha a aba do estúdio visível durante a transmissão.
function pumpWithTimer(video) {
  $('hint').textContent =
    '⚠ Este navegador pode não transmitir em segundo plano. ' +
    'Mantenha a aba do estúdio visível.';

  const tick = async () => {
    if (!running) return;

    const preset = PRESETS[$('quality').value] || PRESETS.media;

    if (!busy && video.videoWidth && video.videoHeight) {
      busy = true;

      try {
        const blob = await drawToCanvas(
          video,
          video.videoWidth,
          video.videoHeight,
          preset
        );

        await sendBlob(blob);
      } catch (error) {
        console.error('Erro ao capturar quadro:', error);
        busy = false;
      }
    }

    if (running) {
      setTimeout(tick, 1000 / preset.fps);
    }
  };

  tick();
}

$('shareBtn').onclick = startShare;
$('stopBtn').onclick = () => stopShare(true);

window.addEventListener('beforeunload', () => {
  if (socket.connected) socket.emit('studio:stop');
});
          
