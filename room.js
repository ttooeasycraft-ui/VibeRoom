/**
 * Durable Object "Room": uma instância por sala (instanceId da Activity).
 * Cuida do WebSocket de quem assiste, do chat, do dono e do estúdio que transmite.
 *
 * Mensagens de texto: JSON {e: evento, d: dados, i: id-para-resposta}.
 * Mensagens binárias: 1º byte = tipo (1 = quadro JPEG, 2 = áudio PCM 16-bit 24 kHz), resto = dados.
 */
import { fetchDiscordUser, getSecret, signSession, verifySession } from './auth.js';
import { RoomManager } from './rooms.js';

const KIND_VIDEO = 1;
const KIND_AUDIO = 2;
const MAX_TEXT = 10_000;
const MAX_FRAME = 600_000;
const MAX_AUDIO = 40_000;

const clean = (value, max = 400) =>
  String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new RoomManager({
      adminIds: String(env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    this.conns = new Map();
    this.roomId = null;
    this.sweeper = null;
  }

  // ── Entrada: o Worker manda o pedido de WebSocket para cá ──────────────────
  async fetch(request) {
    const url = new URL(request.url);
    const roomId = clean(url.searchParams.get('r'), 64);
    if (!roomId) return new Response('sala ausente', { status: 400 });
    this.roomId = roomId;
    // eslint-disable-next-line no-undef
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.attach(server, { origin: url.searchParams.get('o') || '' });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Liga um WebSocket do lado do servidor (separado do fetch para dar para testar). */
  attach(ws, { origin = '' } = {}) {
    ws.accept?.();
    const conn = { id: crypto.randomUUID(), ws, origin, authed: false, role: null, inflight: 0, lastAck: Date.now() };
    this.conns.set(conn.id, conn);
    ws.addEventListener('message', (event) =>
      this.onMessage(conn, event.data).catch((error) => console.error('[Room] erro:', error)),
    );
    const bye = () => this.onClose(conn);
    ws.addEventListener('close', bye);
    ws.addEventListener('error', bye);
    conn.timer = setTimeout(() => {
      if (conn.authed) return;
      this.sendError(conn, 'Tempo esgotado para entrar.');
    }, 10_000);
    conn.timer.unref?.(); // no Node (testes) não segura o processo aberto
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.sweep(), 10_000);
      this.sweeper.unref?.();
    }
    return conn;
  }

  // ── Envio ───────────────────────────────────────────────────────────────────
  sendRaw(conn, data) {
    try {
      if (conn.ws.readyState === 1) conn.ws.send(data);
    } catch {
      /* conexão caiu */
    }
  }

  send(conn, event, data) {
    this.sendRaw(conn, JSON.stringify({ e: event, d: data }));
  }

  reply(conn, msg, result) {
    if (msg.i !== undefined) this.sendRaw(conn, JSON.stringify({ a: msg.i, d: result }));
  }

  sendError(conn, message) {
    this.send(conn, 'connect_error', { message, fatal: true });
    try {
      conn.ws.close(1008, 'auth');
    } catch {
      /* ok */
    }
  }

  broadcast(event, data) {
    const text = JSON.stringify({ e: event, d: data });
    for (const conn of this.conns.values()) if (conn.authed) this.sendRaw(conn, text);
  }

  broadcastState(room) {
    this.broadcast('room:state', this.rooms.publicState(room));
  }

  systemMessage(room, text) {
    const message = { id: crypto.randomUUID(), system: true, text, at: Date.now() };
    this.rooms.addChat(room, message);
    this.broadcast('chat:message', message);
  }

  // ── Mensagens recebidas ─────────────────────────────────────────────────────
  async onMessage(conn, data) {
    if (typeof data !== 'string') return this.onBinary(conn, data);
    if (data.length > MAX_TEXT) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!conn.authed) {
      if (msg.e === 'auth') await this.authenticate(conn, msg.d || {});
      return;
    }
    if (conn.role === 'studio') this.onStudioEvent(conn, msg);
    else this.onViewerEvent(conn, msg);
  }

  async authenticate(conn, auth) {
    try {
      if (auth.sess) {
        const body = await verifySession(auth.sess, getSecret(this.env));
        if (!body || body.kind !== 'studio' || String(body.room) !== this.roomId) {
          throw new Error('Link do estúdio inválido ou expirado');
        }
        conn.role = 'studio';
        conn.userId = String(body.uid);
        conn.name = clean(body.name, 32);
      } else if (auth.token) {
        conn.role = 'viewer';
        conn.user = await fetchDiscordUser(String(auth.token));
      } else if (this.env.ALLOW_DEMO === 'true' && auth.demo) {
        conn.role = 'viewer';
        conn.user = { id: `demo-${clean(auth.demo.id, 24) || crypto.randomUUID()}`, name: clean(auth.demo.name, 32) || 'Convidado', avatarUrl: '' };
      } else {
        throw new Error('Não autorizado');
      }
    } catch (error) {
      return this.sendError(conn, error.message || 'Não autorizado');
    }
    conn.authed = true;
    clearTimeout(conn.timer);
    this.send(conn, 'authed');
    if (conn.role === 'studio') this.studioJoin(conn);
    else this.viewerJoin(conn);
  }

  // ── Quem assiste ────────────────────────────────────────────────────────────
  viewerJoin(conn) {
    const { user } = conn;
    const { room, isNewUser } = this.rooms.join(this.roomId, user, conn.id);
    this.send(conn, 'hello', {
      me: { id: user.id, name: user.name, avatarUrl: user.avatarUrl, isAdmin: this.rooms.isAdmin(user.id) },
      state: this.rooms.publicState(room),
      chat: room.chat,
    });
    if (room.live && room.lastFrame) {
      conn.inflight += 1;
      this.sendRaw(conn, room.lastFrame);
    }
    this.broadcastState(room);
    if (isNewUser) this.systemMessage(room, `${user.name} entrou na sala`);
  }

  ownerRoom(conn) {
    const room = this.rooms.get(this.roomId);
    return room && room.ownerId === conn.user.id ? room : null;
  }

  onViewerEvent(conn, msg) {
    const { user } = conn;
    const room = this.rooms.get(this.roomId);
    if (!room) return;

    switch (msg.e) {
      case 'fa': // o espectador mostrou um quadro: pode mandar o próximo
        conn.inflight = Math.max(0, conn.inflight - 1);
        conn.lastAck = Date.now();
        break;

      case 'chat:send': {
        const text = clean(msg.d?.text, 400);
        if (!text) return;
        if (room.chatLocked && room.ownerId !== user.id) return this.send(conn, 'toast', { message: 'O dono silenciou o chat.' });
        if (!this.rooms.checkChatRate(room, user.id)) return;
        const message = {
          id: crypto.randomUUID(),
          userId: user.id,
          name: user.name,
          avatarUrl: user.avatarUrl,
          isOwner: room.ownerId === user.id,
          text,
          at: Date.now(),
        };
        this.rooms.addChat(room, message);
        this.broadcast('chat:message', message);
        break;
      }

      case 'chat:clear':
        if (!this.ownerRoom(conn)) return;
        room.chat = [];
        this.broadcast('chat:cleared');
        this.systemMessage(room, 'O dono limpou o chat');
        break;

      case 'chat:lock':
        if (!this.ownerRoom(conn)) return;
        room.chatLocked = Boolean(msg.d);
        this.broadcastState(room);
        this.systemMessage(room, room.chatLocked ? 'O dono silenciou o chat' : 'O chat foi liberado');
        break;

      case 'owner:transfer': {
        const result = this.rooms.transfer(this.roomId, user.id, String(msg.d?.userId || ''));
        if (!result) return this.reply(conn, msg, { ok: false, error: 'Não foi possível passar a sala.' });
        this.kickStudio(result.room, 'Você não é mais o dono da sala.');
        this.broadcastState(result.room);
        this.systemMessage(result.room, `${result.target.name} agora é o dono da sala 👑`);
        this.reply(conn, msg, { ok: true });
        break;
      }

      case 'owner:claim': {
        const result = this.rooms.claim(this.roomId, user.id);
        if (!result) return this.reply(conn, msg, { ok: false, error: 'Só administradores podem assumir a sala.' });
        this.kickStudio(result.room, 'A sala foi assumida por um administrador.');
        this.broadcastState(result.room);
        this.systemMessage(result.room, `${user.name} assumiu a sala 👑`);
        this.reply(conn, msg, { ok: true });
        break;
      }

      case 'studio:link': {
        if (!this.ownerRoom(conn)) return this.reply(conn, msg, { ok: false, error: 'Só o dono da sala pode abrir o estúdio.' });
        const secret = getSecret(this.env);
        const base = String(this.env.PUBLIC_URL || conn.origin || '').replace(/\/+$/, '');
        if (!secret || !base) return this.reply(conn, msg, { ok: false, error: 'Servidor sem SESSION_SECRET ou PUBLIC_URL.' });
        signSession({ kind: 'studio', uid: user.id, name: user.name, room: this.roomId }, secret).then((sess) => {
          this.reply(conn, msg, { ok: true, url: `${base}/studio.html?sess=${encodeURIComponent(sess)}&r=${encodeURIComponent(this.roomId)}` });
        });
        break;
      }
      default:
    }
  }

  // ── Estúdio (quem transmite) ────────────────────────────────────────────────
  studioJoin(conn) {
    const room = this.rooms.get(this.roomId);
    if (!room || room.ownerId !== conn.userId) {
      this.send(conn, 'studio:denied', { message: 'Você não é o dono desta sala (ou a sala já fechou). Abra o estúdio de novo pela Activity.' });
      try { conn.ws.close(1000, 'denied'); } catch { /* ok */ }
      return;
    }
    if (room.studioSocketId && room.studioSocketId !== conn.id) {
      this.kickStudio(room, 'Outro estúdio foi aberto para esta sala.');
    }
    room.studioSocketId = conn.id;
    this.send(conn, 'studio:ready', { name: conn.name, state: this.rooms.publicState(room) });
  }

  activeStudio(conn) {
    const room = this.rooms.get(this.roomId);
    return room && room.studioSocketId === conn.id && room.ownerId === conn.userId ? room : null;
  }

  onStudioEvent(conn, msg) {
    if (msg.e === 'studio:stop') {
      const room = this.activeStudio(conn);
      if (room && room.live) this.stopLive(room);
    }
  }

  onBinary(conn, buffer) {
    if (conn.role !== 'studio' || !conn.authed) return;
    const view = new Uint8Array(buffer);
    const kind = view[0];
    const room = this.activeStudio(conn);

    if (kind === KIND_VIDEO) {
      this.send(conn, 'frame-ack'); // libera o próximo quadro no estúdio
      if (!room || view.length < 2 || view.length > MAX_FRAME) return;
      room.lastFrame = buffer;
      if (!room.live) {
        room.live = true;
        this.broadcastState(room);
      }
      const now = Date.now();
      for (const viewer of this.conns.values()) {
        if (!viewer.authed || viewer.role !== 'viewer') continue;
        if (viewer.inflight >= 3 && now - viewer.lastAck > 3000) viewer.inflight = 0; // espectador travou: recomeça
        if (viewer.inflight >= 3) continue; // espectador lento: pula este quadro
        viewer.inflight += 1;
        this.sendRaw(viewer, buffer);
      }
    } else if (kind === KIND_AUDIO) {
      if (!room || view.length < 3 || view.length > MAX_AUDIO) return;
      for (const viewer of this.conns.values()) {
        if (viewer.authed && viewer.role === 'viewer') this.sendRaw(viewer, buffer);
      }
    }
  }

  stopLive(room) {
    room.live = false;
    room.lastFrame = null;
    this.broadcastState(room);
  }

  kickStudio(room, message) {
    const id = room.studioSocketId;
    room.studioSocketId = null;
    const studio = id ? this.conns.get(id) : null;
    if (studio) {
      this.send(studio, 'studio:denied', { message });
      try { studio.ws.close(1000, 'kicked'); } catch { /* ok */ }
    }
    if (room.live) this.stopLive(room);
  }

  // ── Saída e manutenção ──────────────────────────────────────────────────────
  onClose(conn) {
    if (!this.conns.delete(conn.id)) return;
    clearTimeout(conn.timer);
    if (conn.authed) {
      if (conn.role === 'viewer') {
        const { room, user } = this.rooms.leave(this.roomId, conn.id);
        if (room) {
          this.broadcastState(room);
          if (user) this.systemMessage(room, `${user.name} saiu da sala`);
        }
      } else {
        const room = this.rooms.get(this.roomId);
        if (room && room.studioSocketId === conn.id) {
          room.studioSocketId = null;
          if (room.live) this.stopLive(room);
        }
      }
    }
    if (this.conns.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  sweep() {
    for (const event of this.rooms.sweep()) {
      if (event.type !== 'owner-changed') continue;
      const room = this.rooms.get(event.roomId);
      if (!room) continue;
      this.kickStudio(room, 'Você não é mais o dono da sala.');
      this.broadcastState(room);
      this.systemMessage(room, `${event.ownerName} agora é o dono da sala 👑`);
    }
  }
}
