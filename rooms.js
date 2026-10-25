/**
 * Regras das salas (sem socket.io, para ser fácil de testar).
 * - O primeiro a entrar vira dono; só o dono transmite (tela + microfone).
 * - Se o dono sumir por mais de 60s, a sala passa para quem está há mais tempo nela.
 */
const MAX_CHAT = 100;
export const OWNER_GRACE_MS = 60_000;
export const EMPTY_TTL_MS = 120_000;

export class RoomManager {
  constructor({ adminIds = [], now = () => Date.now() } = {}) {
    this.admins = new Set(adminIds.map(String));
    this.now = now;
    this.rooms = new Map();
  }

  isAdmin(userId) {
    return this.admins.has(String(userId));
  }

  get(roomId) {
    return this.rooms.get(roomId) || null;
  }

  join(roomId, user, socketId) {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        id: roomId,
        ownerId: null,
        users: new Map(),
        chat: [],
        chatLocked: false,
        live: false,
        lastFrame: null,
        studioSocketId: null,
        ownerAbsentSince: null,
        emptySince: null,
        lastChatAt: new Map(),
      };
      this.rooms.set(roomId, room);
    }
    let entry = room.users.get(user.id);
    const isNewUser = !entry;
    if (!entry) {
      entry = { id: user.id, name: user.name, avatarUrl: user.avatarUrl || '', joinedAt: this.now(), sockets: new Set() };
      room.users.set(user.id, entry);
    }
    entry.sockets.add(socketId);
    room.emptySince = null;
    if (!room.ownerId) room.ownerId = user.id;
    if (room.ownerId === user.id) room.ownerAbsentSince = null;
    return { room, isNewUser };
  }

  leave(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (!room) return { room: null, user: null };
    let gone = null;
    for (const [userId, entry] of room.users) {
      if (entry.sockets.delete(socketId) && entry.sockets.size === 0) {
        room.users.delete(userId);
        gone = entry;
      }
    }
    if (gone && room.ownerId === gone.id) room.ownerAbsentSince = this.now();
    if (room.users.size === 0) room.emptySince = this.now();
    return { room, user: gone };
  }

  /** Rodar de tempos em tempos: passa a sala adiante e apaga salas vazias. */
  sweep() {
    const events = [];
    const t = this.now();
    for (const [id, room] of this.rooms) {
      if (room.users.size === 0) {
        if (room.emptySince !== null && t - room.emptySince > EMPTY_TTL_MS) {
          this.rooms.delete(id);
          events.push({ type: 'deleted', roomId: id });
        }
        continue;
      }
      if (room.ownerAbsentSince !== null && t - room.ownerAbsentSince > OWNER_GRACE_MS) {
        const next = [...room.users.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
        room.ownerId = next.id;
        room.ownerAbsentSince = null;
        events.push({ type: 'owner-changed', roomId: id, ownerId: next.id, ownerName: next.name });
      }
    }
    return events;
  }

  transfer(roomId, byUserId, toUserId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    if (room.ownerId !== byUserId && !this.isAdmin(byUserId)) return null;
    const target = room.users.get(toUserId);
    if (!target || room.ownerId === toUserId) return null;
    room.ownerId = toUserId;
    room.ownerAbsentSince = null;
    return { room, target };
  }

  /** Admin assume a sala. */
  claim(roomId, userId) {
    if (!this.isAdmin(userId)) return null;
    return this.transfer(roomId, userId, userId);
  }

  addChat(room, message) {
    room.chat.push(message);
    if (room.chat.length > MAX_CHAT) room.chat.splice(0, room.chat.length - MAX_CHAT);
  }

  checkChatRate(room, userId, minGapMs = 700) {
    const t = this.now();
    if (t - (room.lastChatAt.get(userId) ?? -Infinity) < minGapMs) return false;
    room.lastChatAt.set(userId, t);
    return true;
  }

  publicState(room) {
    return {
      roomId: room.id,
      ownerId: room.ownerId,
      chatLocked: room.chatLocked,
      live: room.live,
      members: [...room.users.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((u) => ({ id: u.id, name: u.name, avatarUrl: u.avatarUrl, isOwner: u.id === room.ownerId })),
    };
  }
}
