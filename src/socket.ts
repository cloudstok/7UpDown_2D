import { Server, Socket } from 'socket.io';
import { getUserDataFromSource } from './module/players/player-event';
import { eventRouter } from './router/event-router';
import { messageRouter } from './router/message-router';
import { setCache, deleteCache } from './utilities/redis-connection';
import { read } from './utilities/db-connection';


export const initSocket = (io: Server): void => {
  eventRouter(io);

  io.on('connection', async (socket: Socket) => {

    const { token, game_id } = socket.handshake.query as { token?: string; game_id?: string };

    if (!token || !game_id) {
      socket.disconnect(true);
      console.log('Mandatory params missing', token);
      return;
    }

    const userData = await getUserDataFromSource(token, game_id);

    if (!userData) {
      console.log('Invalid token', token);
      socket.disconnect(true);
      return;
    }


    socket.emit('info',
      {
        user_id: userData.userId,
        operator_id: userData.operatorId,
        balance: userData.balance,
      },
    );

    await setCache(`PL:${socket.id}`, JSON.stringify({ ...userData, socketId: socket.id }), 3600);
    await getHistory(socket, userData.userId, userData.operatorId);

    messageRouter(io, socket);

    socket.on('disconnect', async () => {
      await deleteCache(`PL:${socket.id}`);
    });

    socket.on('error', (error: Error) => {
      console.error(`Socket error: ${socket.id}. Error: ${error.message}`);
    });
  });
};


export const getHistory = async (socket: Socket, userId: string, operator_id: string) => {
  try {
    const historyData = await read(`SELECT lobby_id, result, created_at FROM lobbies ORDER BY created_at DESC LIMIT 3`);
    const getLastWin = await read(`SELECT win_amount FROM settlement WHERE user_id = ? and operator_id = ? ORDER BY created_at DESC LIMIT 1`, [decodeURIComponent(userId), operator_id]);
    if (getLastWin && getLastWin.length > 0) socket.emit('lastWin', { myWinningAmount: getLastWin[0].win_amount });
    return socket.emit('historyData', historyData);
  } catch (err) {
    console.error(`Err while getting user history data is:::`, err);
    return;
  }
}