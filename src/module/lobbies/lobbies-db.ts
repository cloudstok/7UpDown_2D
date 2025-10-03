import { write } from '../../utilities/db-connection';
import { LobbyData } from '../bets/bets-session';

const SQL_INSERT_LOBBIES = 'INSERT INTO lobbies (lobby_no, lobby_id, start_delay, end_delay, result) values(?,?,?,?,?)';

export const insertLobbies = async (data: { lobby_no: number, lobby_id: number, start_delay: number, end_delay: number, result: string }): Promise<void> => {
  try {
    await write(SQL_INSERT_LOBBIES, Object.values(data));
  } catch (err) {
    console.error(err);
  }
};
