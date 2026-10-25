
/** Utilidades compartilhadas entre a Activity e o Estúdio. */

export const PCM_RATE = 24000;

export function toast(message) {
  const el = document.getElementById('toast');
  if (!el) return;

  el.textContent = message;
  el.classList.add('show');

  clearTimeout(toast.timer);

  toast.timer = setTimeout(() => {
    el.classList.remove('show');
  }, 3000);
}

/** Cria o avatar sem inserir HTML fornecido pelo usuário. */
export function avatarEl(name, url, small = false) {
  const el = document.createElement('span');

  el.className = 'avatar' + (small ? ' sm' : '');

  const initial =
    (name || '?').trim().slice(0, 1).toUpperCase() || '?';

  if (url && url.startsWith('https://cdn.discordapp.com/')) {
    const img = document.createElement('img');

    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = url;

    img.onerror = () => {
      img.remove();
      el.textContent = initial;
    };

    el.appendChild(img);
  } else {
    el.textContent = initial;
  }

  return el;
}

export function clock(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Reproduz o áudio PCM 16-bit mono recebido do estúdio. */
export class PcmPlayer {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.nextTime = 0;
    this.volume = 1;
  }

  async enable() {
    if (!this.ctx) {
      const AC =
        window.AudioContext || window.webkitAudioContext;

      this.ctx = new AC();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }

    if (this.ctx.state !== 'running') {
      await this.ctx.resume();
    }
  }

  get enabled() {
    return Boolean(this.ctx && this.ctx.state === 'running');
  }

  setVolume(value) {
    this.volume = value;

    if (this.gain) {
      this.gain.gain.value = value;
    }
  }

  push(arrayBuffer) {
    if (!this.enabled) return;

    const bytes = arrayBuffer.byteLength & ~1;
    if (!bytes) return;

    const int16 = new Int16Array(arrayBuffer.slice(0, bytes));
    const floats = new Float32Array(int16.length);

    for (let i = 0; i < int16.length; i++) {
      floats[i] = int16[i] / 32768;
    }

    const buffer = this.ctx.createBuffer(
      1,
      floats.length,
      PCM_RATE
    );

    buffer.copyToChannel(floats, 0);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    const now = this.ctx.currentTime;

    if (this.nextTime < now + 0.03) {
      this.nextTime = now + 0.22;
    }

    if (this.nextTime > now + 1.2) return;

    source.start(this.nextTime);
    this.nextTime += buffer.duration;
  }
}

/**
 * Conexão WebSocket da sala.
 * Texto: JSON com evento e dados.
 * Binário: byte 1 = vídeo; byte 2 = áudio.
 */
export function createSocket({
  path = '/ws',
  params = {},
  auth,
}) {
  const handlers = new Map();
  const pending = new Map();

  let ws = null;
  let nextId = 1;
  let frameCb = null;
  let retry = 0;
  let stopped = false;

  const fire = (event, ...args) => {
    (handlers.get(event) || []).forEach((fn) => fn(...args));
  };

  const sendText = (msg) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };

  const sendBinary = (kind, buffer) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const out = new Uint8Array(1 + buffer.byteLength);
    out[0] = kind;
    out.set(new Uint8Array(buffer), 1);

    ws.send(out);
    return true;
  };

  const api = {
    connected: false,

    on(event, fn) {
      if (!handlers.has(event)) {
        handlers.set(event, []);
      }

      handlers.get(event).push(fn);
      return api;
    },

    emit(event, data, cb) {
      if (typeof data === 'function') {
        cb = data;
        data = undefined;
      }

      const msg = { e: event, d: data };

      if (cb) {
        msg.i = nextId++;
        pending.set(msg.i, cb);
      }

      sendText(msg);
    },

    /** Envia um quadro JPEG e aguarda a confirmação do servidor. */
    sendFrame(buffer, cb) {
      frameCb = cb;

      if (!sendBinary(1, buffer)) {
        frameCb = null;
        cb?.();
      }
    },

    /** Envia áudio PCM. */
    sendAudio(buffer) {
      sendBinary(2, buffer);
    },

    close() {
      stopped = true;
      ws?.close();
    },
  };

  function open() {
    if (stopped) return;

    const protocol =
      location.protocol === 'https:' ? 'wss:' : 'ws:';

    const query = new URLSearchParams(params);

    ws = new WebSocket(
      `${protocol}//${location.host}${path}?${query}`
    );

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      ws.send(JSON.stringify({
        e: 'auth',
        d: auth,
      }));
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        const kind = new Uint8Array(event.data, 0, 1)[0];

        fire(
          kind === 1 ? 'v' : 'a',
          event.data.slice(1)
        );

        return;
      }

      let msg;

      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.e === 'authed') {
        api.connected = true;
        retry = 0;
        fire('connect');
      } else if (msg.e === 'frame-ack') {
        const cb = frameCb;
        frameCb = null;
        cb?.();
      } else if (msg.a !== undefined) {
        const cb = pending.get(msg.a);
        pending.delete(msg.a);
        cb?.(msg.d);
      } else if (msg.e === 'connect_error') {
        if (msg.d?.fatal) stopped = true;
        fire('connect_error', msg.d || {});
      } else {
        fire(msg.e, msg.d);
      }
    };

    ws.onclose = () => {
      const wasConnected = api.connected;
      api.connected = false;

      if (wasConnected) {
        fire('disconnect');
      }

      if (!stopped) {
        setTimeout(
          open,
          Math.min(8000, 500 * 2 ** retry++)
        );
      }
    };

    ws.onerror = () => {};
  }

  open();
  return api;
      }
  
