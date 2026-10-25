/**
 * Assinatura do link do estúdio e conversa com a API do Discord.
 * Usa só WebCrypto + fetch, então roda no Cloudflare Workers (e no Node 20+ para testes).
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toB64u(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64u(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const hmacKey = (secret, usages) =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);

/** O segredo do link do estúdio: SESSION_SECRET (ou, na falta dele, derivado do Client Secret). */
export function getSecret(env) {
  const secret = env.SESSION_SECRET || (env.DISCORD_CLIENT_SECRET ? `vr:${env.DISCORD_CLIENT_SECRET}` : '');
  return String(secret).trim();
}

export async function signSession(payload, secret, ttlSec = 6 * 3600) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSec };
  const data = `${toB64u(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))}.${toB64u(encoder.encode(JSON.stringify(body)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), encoder.encode(data)));
  return `${data}.${toB64u(sig)}`;
}

export async function verifySession(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !secret) return null;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, ['verify']),
      fromB64u(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return null;
    const body = JSON.parse(decoder.decode(fromB64u(parts[1])));
    if (!body.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

/** Troca o "code" do Discord por um access_token (precisa do Client Secret, por isso é no servidor). */
export async function exchangeCode({ clientId, clientSecret, code }) {
  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Discord respondeu ${response.status}`);
  }
  return data.access_token;
}

export function avatarUrlFor(user) {
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
  let index = 0;
  try {
    index = Number((BigInt(user.id) >> 22n) % 6n);
  } catch {
    /* ignora */
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

const userCache = new Map();

/** Confirma quem é a pessoa direto com o Discord (não confia no que o navegador diz). */
export async function fetchDiscordUser(accessToken) {
  const cached = userCache.get(accessToken);
  if (cached && cached.exp > Date.now()) return cached.user;
  const response = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error('Token do Discord inválido');
  const raw = await response.json();
  const user = {
    id: String(raw.id),
    name: String(raw.global_name || raw.username || 'Convidado').slice(0, 32),
    avatarUrl: avatarUrlFor(raw),
  };
  userCache.set(accessToken, { user, exp: Date.now() + 10 * 60_000 });
  if (userCache.size > 300) userCache.delete(userCache.keys().next().value);
  return user;
}
