/**
 * VibeRoom no Cloudflare Workers.
 * - Arquivos do site (pasta dist) são servidos pelo próprio Cloudflare.
 * - /api/token troca o código do Discord por um token (usa o Client Secret).
 * - /ws abre o WebSocket da sala (um Durable Object por sala).
 */
import { exchangeCode, getSecret, verifySession } from './auth.js';
import { Room } from './room.js';

export { Room };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const clean = (value, max = 64) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname === '/api/config') return json({ demo: env.ALLOW_DEMO === 'true' });

    if (url.pathname === '/api/token' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const code = clean(body.code, 200);
      if (!code) return json({ error: 'code ausente' }, 400);
      if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return json({ error: 'Faltam DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET no Worker' }, 500);
      try {
        const accessToken = await exchangeCode({ clientId: env.DISCORD_CLIENT_ID, clientSecret: env.DISCORD_CLIENT_SECRET, code });
        return json({ access_token: accessToken });
      } catch (error) {
        console.error('[OAuth] falha:', error.message);
        return json({ error: error.message }, 400);
      }
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Use WebSocket', { status: 426 });
      let roomId = clean(url.searchParams.get('room'));
      const sess = url.searchParams.get('sess');
      if (sess) {
        // O estúdio diz a sala pelo próprio link assinado.
        const body = await verifySession(sess, getSecret(env));
        if (!body) return new Response('Link do estúdio inválido ou expirado', { status: 401 });
        roomId = clean(body.room);
      }
      if (!roomId) return new Response('sala ausente', { status: 400 });
      const target = new URL(request.url);
      target.searchParams.set('r', roomId);
      target.searchParams.set('o', env.PUBLIC_URL || url.origin);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      return stub.fetch(new Request(target.toString(), request));
    }

    return env.ASSETS.fetch(request);
  },
};
