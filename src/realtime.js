import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
let io;
export function initIO(server, origins) {
  io = new Server(server, { cors: { origin: origins } });
  io.use((s, next) => {
    try { s.user = jwt.verify(s.handshake.auth?.token, process.env.JWT_SECRET); next(); }
    catch { next(new Error('unauthorized')); }
  });
  return io;
}
export const emit = (event, payload) => io?.emit(event, payload);
