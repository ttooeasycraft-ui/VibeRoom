# VibeRoom — Activity do Discord (Cloudflare Workers)

Sala ao vivo: **só o dono** compartilha a tela e fala no microfone; **todos os outros assistem** (mudos) e conversam no **chat**.

## Como funciona
- A Discord **não deixa usar WebRTC** em Activities. Então o dono transmite pela página **Estúdio** (abre no navegador do PC, Chrome/Edge) e o Cloudflare repassa vídeo e áudio por WebSocket para a Activity.
- Na Activity, o dono clica em **🎬 Abrir estúdio**, escolhe a tela, liga o microfone e pronto.
- O primeiro a entrar vira dono; ele pode **passar a sala**, **silenciar** e **limpar** o chat.
- Imagem em JPEG (menos fluida que o Go Live) e áudio mono. Bom para ~10–15 espectadores.
- Cada sala é um *Durable Object* do Cloudflare (plano grátis funciona).

## Por que dava "página da web não autorizada"
A Activity roda num iframe fechado: não pode carregar fonte do Google, scripts de CDN nem abrir sites sozinha. Aqui tudo vem do próprio Worker e o estúdio abre pelo jeito oficial (`openExternalLink`, com confirmação do Discord).

## Colocar no ar (pelo painel do Cloudflare, sem computador)
1. Suba **todos os arquivos desta pasta** (todos ficam soltos, sem subpastas) em um repositório do **GitHub**.
2. Cloudflare → **Workers & Pages → Create → Import a repository** → escolha o repositório.
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
3. Quando terminar, anote o endereço: `https://viberoom.SEU-USUARIO.workers.dev`.
4. No Worker → **Settings → Variables and Secrets**, crie:
   - `DISCORD_CLIENT_ID` (texto) — ID do aplicativo
   - `DISCORD_CLIENT_SECRET` (**Secret**) — Client Secret do aplicativo
   - `SESSION_SECRET` (**Secret**) — qualquer texto grande e aleatório
   - `PUBLIC_URL` (texto) — o endereço do passo 3, com `https://`
   - opcional `ADMIN_IDS` — IDs que podem assumir a sala
5. **Discord Developer Portal → seu app → Activities**:
   - ative as Activities;
   - **URL Mappings → Root Mapping**: `/` → `viberoom.SEU-USUARIO.workers.dev` (sem `https://`);
   - se pedir, em OAuth2 cadastre um redirect qualquer (ex.: `https://127.0.0.1`).
6. No Discord: entre numa call → **Atividades** → VibeRoom.

## Teste rápido no navegador
Crie a variável `ALLOW_DEMO` = `true` e abra `https://SEU-ENDERECO/?demo=SeuNome&room=teste` (só para testes; apague depois).

## Segurança
- Client Secret e SESSION_SECRET ficam só no Cloudflare (nunca no código).
- O link do estúdio é assinado, vale 6 horas e só funciona para o dono atual da sala.
- Só o estúdio do dono consegue enviar vídeo/áudio; quem assiste não tem como transmitir.

## Testes
`npm test` roda 23 testes das regras de sala, do estúdio e da assinatura.
