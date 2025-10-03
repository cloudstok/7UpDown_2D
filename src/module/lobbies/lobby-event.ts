import { Server } from 'socket.io';
import { insertLobbies } from './lobbies-db';
import { createLogger } from '../../utilities/logger';
import { LobbyData, setCurrentLobby } from '../bets/bets-session';
import { getResult } from '../../utilities/helper-function';
import { settleBet } from '../bets/bets-session';

const logger = createLogger('lobbies', 'jsonl');

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const lobbies = {
  "101": {},
  "102": {},
  "103": {}
};

export const initRounds = async (io: Server): Promise<void> => {
  const tasks = Object.keys(lobbies).map(async (id) => {
    const delay = 5000 * (Number(id) % 100);
    await sleep(delay);
    console.log(`Lobby ${id} starting after ${delay} sec`);
    await initLobby(io, id);
  });

  // run them in parallel
  await Promise.all(tasks);
};

const initLobby = async (io: Server, id: string): Promise<void> => {

  const lobby = Date.now();
  const lobbyId = `${lobby}-${id}`//Date.now();
  console.log("lobby created for id", lobbyId);
  const recurLobbyData: LobbyData = {
    lobbyId,
    status: 0,
  };

  setCurrentLobby(io, recurLobbyData, id);

  const start_delay = 15;
  const result = getResult();
  const end_delay = 3;

  for (let x = start_delay; x >= 0; x--) {
    io.to(id).emit('cards', `${lobbyId}:${x}:STARTING`);
    await sleep(1000);
  }

  recurLobbyData.status = 1;
  setCurrentLobby(io, recurLobbyData, id);

  io.to(id).emit('cards', `${lobbyId}:0:CALCULATING`);
  await sleep(3000);

  recurLobbyData.status = 2;
  setCurrentLobby(io, recurLobbyData, id);
  io.to(id).emit('cards', `${lobbyId}:${JSON.stringify(result)}:RESULT`);

  await sleep(8000);
  await settleBet(io, result, lobbyId);

  recurLobbyData.status = 3;
  setCurrentLobby(io, recurLobbyData, id);
  for (let z = 1; z <= end_delay; z++) {
    io.to(id).emit('cards', `${lobbyId}:${z + "_" + JSON.stringify(result)}:ENDED`);
    await sleep(1000);
  }

  const history = {
    time: new Date(),
    lobbyId,
    start_delay,
    end_delay,
    result,
    status: recurLobbyData.status
  };

  io.to(id).emit('history', JSON.stringify(history));
  logger.info(JSON.stringify(history));
  await insertLobbies({ lobby_no: Number(id), lobby_id: lobby, start_delay, end_delay, result: JSON.stringify(result) });

  return initLobby(io, id);
};


