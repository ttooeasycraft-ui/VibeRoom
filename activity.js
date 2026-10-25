import './style.css';
import { DiscordSDK } from '@discord/embedded-app-sdk';
import { PcmPlayer, avatarEl, clock, createSocket, toast } from './common.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// Dentro do Discord a página roda em {clientId}.discordsays.com e recebe ?frame_id=...
const embedded = params.has('frame_id') || location.hostname.endsWith('discordsays.com');

const player = new PcmPlayer();
let sdk = null;
let socket = null;
let me = null;
let state = null;
let isOwner = false;
let muted = false;

function gate(title, text) {
  $('gate').classList.remove('hidden');
  $('gateTitle').textContent = title;
  $('gateText').textContent = text;
}

function setConn(text, kind) {
  const pill = $('connPill');
  pill.textContent = text;
  pill.className = 'pill' + (kind ? ` ${kind}` : '');
}

// ── Início: login pelo Discord (ou modo de teste no navegador) ────────────────
async function start() {
  let auth;
  let roomId;
  let path = '/ws';

  if (embedded) {
    const clientId = location.hostname.split('.')[0];
    sdk = new DiscordSDK(clientId);
    await sdk.ready();
    const { code } = await sdk.commands.authorize({
      client_id: clientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify'],
    });
    const response = await fetch('/.proxy/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw new Error(data.error || 'Não consegui entrar com o Discord');
    await sdk.commands.authenticate({ access_token: data.access_token });
    roomId = sdk.instanceId;
    auth = { token: data.access_token };
    path = '/.proxy/ws'; // WebSocket passando pelo proxy do Discord
  } else {
    const config = await fetch('/api/config').then((r) => r.json()).catch(() => ({ demo: false }));
    const demoName = params.get('demo');
    if (!config.demo || !demoName) {
      gate('Abra pelo Discord', 'A VibeRoom funciona como Activity: entre em uma chamada de voz e escolha a VibeRoom em Atividades.');
      return;
    }
    let id = sessionStorage.getItem('vr-demo-id');
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('vr-demo-id', id);
    }
    roomId = params.get('room') || 'sala-teste';
    auth = { demo: { name: demoName, id } };
  }

  connect(auth, path, roomId);
}

function connect(auth, path, roomId) {
  socket = createSocket({ path, params: { room: roomId }, auth });

  socket.on('connect', () => setConn('Conectado', 'ok'));
  socket.on('disconnect', () => setConn('Reconectando…', 'err'));
  socket.on('connect_error', (error) => {
    setConn('Sem conexão', 'err');
    if (/Token|autoriz/i.test(error.message)) gate('Não consegui entrar', 'O login com o Discord falhou. Feche e abra a Activity de novo.');
  });

  socket.on('hello', (hello) => {
    me = hello.me;
    $('feed').textContent = '';
    hello.chat.forEach(addMessage);
    applyState(hello.state);
  });
  socket.on('room:state', applyState);
  socket.on('chat:message', addMessage);
  socket.on('chat:cleared', () => { $('feed').textContent = ''; });
  socket.on('toast', ({ message }) => toast(message));
  socket.on('v', onFrame);
  socket.on('a', (buffer) => { if (!isOwner && !muted) player.push(buffer); });
}

// ── Estado da sala ───────────────────────────────────────────────────────────
function applyState(next) {
  state = next;
  isOwner = Boolean(me && state.ownerId === me.id);
  const owner = state.members.find((m) => m.isOwner);

  $('viewersPill').textContent = `👥 ${state.members.length}`;
  $('countLabel').textContent = String(state.members.length);
  $('livePill').classList.toggle('hidden', !state.live);

  // Palco
  $('screen').classList.toggle('hidden', !state.live);
  $('empty').classList.toggle('hidden', state.live);
  $('emptyTitle').textContent = isOwner ? 'Sua sala está pronta' : 'A tela do dono aparece aqui';
  $('emptyText').textContent = isOwner
    ? 'Clique em “Abrir estúdio” para compartilhar sua tela e seu microfone com a sala.'
    : 'Quando o dono começar a transmitir, todo mundo assiste por aqui. Só o dono pode falar e compartilhar.';

  // Dono
  const slot = $('hostAvatarSlot');
  slot.textContent = '';
  slot.appendChild(avatarEl(owner?.name, owner?.avatarUrl));
  $('hostName').textContent = owner ? owner.name : 'Sem dono';
  $('hostRole').textContent = isOwner ? '👑 Você é o dono da sala' : '👑 Dono da sala';

  // Controles
  $('studioBtn').classList.toggle('hidden', !isOwner);
  $('lockBtn').classList.toggle('hidden', !isOwner);
  $('clearBtn').classList.toggle('hidden', !isOwner);
  $('claimBtn').classList.toggle('hidden', isOwner || !me?.isAdmin);
  $('lockBtn').textContent = state.chatLocked ? '🔓 Liberar chat' : '🔒 Silenciar chat';
  $('soundBtn').classList.toggle('hidden', isOwner);
  $('vol').classList.toggle('hidden', isOwner);
  $('notice').textContent = isOwner
    ? '🎬 Para transmitir tela e microfone, abra o estúdio. Ele abre no navegador do computador (Chrome ou Edge).'
    : '🔇 O microfone é só do dono da sala. Você assiste e conversa pelo chat.';

  // Chat
  const blocked = state.chatLocked && !isOwner;
  $('lockBanner').classList.toggle('hidden', !state.chatLocked);
  $('msg').disabled = blocked;
  $('msg').placeholder = blocked ? 'Chat silenciado pelo dono' : 'Escreva uma mensagem…';

  renderMembers();
}

function renderMembers() {
  const list = $('members');
  list.textContent = '';
  for (const member of state.members) {
    const row = document.createElement('div');
    row.className = 'member';
    row.appendChild(avatarEl(member.name, member.avatarUrl, true));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = member.name + (member.id === me?.id ? ' (você)' : '');
    row.appendChild(name);
    if (member.isOwner) {
      const crown = document.createElement('span');
      crown.textContent = '👑';
      row.appendChild(crown);
    } else if (isOwner) {
      const pass = document.createElement('button');
      pass.className = 'pass';
      pass.textContent = 'Passar sala';
      pass.onclick = () => {
        if (!confirm(`Passar a sala para ${member.name}? Você deixa de ser o dono.`)) return;
        socket.emit('owner:transfer', { userId: member.id }, (res) => {
          if (!res?.ok) toast(res?.error || 'Não deu certo');
        });
      };
      row.appendChild(pass);
    }
    list.appendChild(row);
  }
}

// ── Vídeo: só o último quadro importa (se a rede atrasar, pulamos os antigos) ─
let latest = null;
let rendering = false;
const canvas = $('screen');
const ctx = canvas.getContext('2d');

function onFrame(buffer) {
  latest = buffer;
  if (!rendering) drawLatest();
}

async function drawLatest() {
  rendering = true;
  try {
    while (latest) {
      const buffer = latest;
      latest = null;
      const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/jpeg' }));
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      socket.emit('fa'); // avisa o servidor que já mostrou o quadro (controle de fluxo)
    }
  } catch {
    /* quadro corrompido: ignora */
  } finally {
    rendering = false;
  }
}

// ── Chat ─────────────────────────────────────────────────────────────────────
function addMessage(message) {
  const feed = $('feed');
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  const row = document.createElement('div');

  if (message.system) {
    row.className = 'sys';
    row.textContent = message.text;
  } else {
    row.className = 'msg';
    row.appendChild(avatarEl(message.name, message.avatarUrl, true));
    const body = document.createElement('div');
    body.className = 'body';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('b');
    name.textContent = message.name;
    meta.appendChild(name);
    if (message.isOwner) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'DONO';
      meta.appendChild(tag);
    }
    const time = document.createElement('span');
    time.textContent = clock(message.at);
    meta.appendChild(time);
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = message.text;
    body.append(meta, text);
    row.appendChild(body);
  }

  feed.appendChild(row);
  while (feed.childElementCount > 150) feed.firstElementChild.remove();
  if (nearBottom || message.userId === me?.id) feed.scrollTop = feed.scrollHeight;
}

$('form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('msg');
  const text = input.value.trim();
  if (!text || !socket) return;
  socket.emit('chat:send', { text });
  input.value = '';
});

// ── Botões ───────────────────────────────────────────────────────────────────
$('soundBtn').onclick = async () => {
  if (!player.enabled) {
    await player.enable();
    muted = false;
    $('soundBtn').textContent = '🔊 Som ligado';
    return;
  }
  muted = !muted;
  $('soundBtn').textContent = muted ? '🔇 Som desligado' : '🔊 Som ligado';
};
$('vol').oninput = (event) => player.setVolume(Number(event.target.value));
$('fsBtn').onclick = () => {
  const stage = $('stage');
  if (document.fullscreenElement) document.exitFullscreen?.();
  else stage.requestFullscreen?.().catch(() => toast('Tela cheia não está disponível aqui.'));
};

$('studioBtn').onclick = () => {
  socket.emit('studio:link', async (res) => {
    if (!res?.ok) return toast(res?.error || 'Não consegui abrir o estúdio');
    try {
      if (sdk) await sdk.commands.openExternalLink({ url: res.url }); // o Discord pede uma confirmação
      else window.open(res.url, '_blank', 'noopener');
    } catch {
      toast('Não consegui abrir o link do estúdio.');
    }
  });
};
$('lockBtn').onclick = () => socket.emit('chat:lock', !state.chatLocked);
$('clearBtn').onclick = () => {
  if (confirm('Limpar todo o chat?')) socket.emit('chat:clear');
};
$('claimBtn').onclick = () => {
  socket.emit('owner:claim', (res) => {
    if (!res?.ok) toast(res?.error || 'Não deu certo');
  });
};

start().catch((error) => {
  console.error(error);
  gate('Não consegui iniciar', error.message || 'Erro desconhecido. Feche e abra a Activity de novo.');
});
