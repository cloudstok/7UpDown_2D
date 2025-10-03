
import { Server, Socket } from "socket.io";
import {
    joinRoom,
    leaveRoom,
    placeBet
} from "../module/bets/bets-session";
import { createLogger } from '../utilities/logger';

const logger = createLogger('Event');

export const messageRouter = async (io: Server, socket: Socket): Promise<void> => {
    socket.on('message', (data: string) => {
        logger.info(data);
        const event = data.split(':');
        if (event[0] == 'BT') return placeBet(socket, [event[1], event[2]]);
        if (event[0] == "JN") return joinRoom(socket, event[1]);
        if (event[0] == "LV") return leaveRoom(socket, event[1]);
    });
};