import { updateBalanceFromAccount } from '../../utilities/common-function';
import { addSettleBet, insertBets } from './bets-db';
import { appConfig } from '../../utilities/app-config';
import { setCache, getCache } from '../../utilities/redis-connection';
import { GameRoundResult, getBetResult, getUserIP, logEventAndEmitResponse } from '../../utilities/helper-function';
import { createLogger } from '../../utilities/logger';
import { Server, Socket } from 'socket.io';
import { lobbies } from '../lobbies/lobby-event';
import { getHistory } from '../../socket';
const logger = createLogger('Bets', 'jsonl');
const settlBetLogger = createLogger('Settlement', 'jsonl');

interface BetData {
    betAmount: number;
    chip: number;
}

type BetResult = {
    chip: number;
    betAmount: number;
    winAmount: number;
    mult: number;
    status: 'win' | 'loss';
};

interface BetObject {
    bet_id: string;
    token: string;
    socket_id: string;
    game_id: string;
    bet_amount?: number;
    userBets?: BetData[];
    lobby_id: string;
    txn_id?: string;
    ip?: string
}

export interface LobbyData {
    lobbyId: string;
    status: number;
}

let lobbyData: Record<string, LobbyData> = {};
let roundBets: Record<string, BetObject[]> = {};

export const setCurrentLobby = (io: Server, data: LobbyData, id: string) => {
    lobbyData[id] = data;
    // io.emit("lobbiesInfo", lobbyData)
    console.log(lobbyData);
    return;
};

export const getCurrentLobbiesInfo = () => lobbyData;

export const joinRoom = async (socket: Socket, rmId: string) => {
    if (!Object.keys(lobbies).includes(rmId)) return socket.emit("betError", "Cannot join room, invalid room id");
    [...socket.rooms].forEach(r => {
        if (r !== socket.id) socket.leave(r);
    });
    socket.join(rmId);
    socket.emit("joinRoom", "Room joined successfully");
    const playerDetails = await getCache(`PL:${socket.id}`);
    if (!playerDetails) {
        return socket.emit('betError', 'Invalid Player Details');
    }
    const parsedPlayerDetails = JSON.parse(playerDetails);
    const { userId, operatorId } = parsedPlayerDetails;
    await setCache(`PL:${socket.id}`, JSON.stringify({ ...parsedPlayerDetails, socketId: socket.id, roomId: rmId }));
    await getHistory(socket, userId, operatorId, rmId);
    return;
}

export const placeBet = async (socket: Socket, betData: [string, string]) => {
    const playerDetails = await getCache(`PL:${socket.id}`);
    if (!playerDetails) {
        return socket.emit('betError', 'Invalid Player Details');
    }

    const parsedPlayerDetails = JSON.parse(playerDetails);
    const { userId, operatorId, token, game_id, balance } = parsedPlayerDetails;
    const lobbyId = betData[0];
    const [_, lobbyNo] = lobbyId.split('-');
    const lData = lobbyData[lobbyNo];
    const userBets = betData[1].split(',');
    const bet_id = `BT:${lobbyId}:${userId}:${operatorId}`;
    const betObj: BetObject = { bet_id, token, socket_id: parsedPlayerDetails.socketId, game_id, lobby_id: lobbyId };

    let totalBetAmount = 0;
    let isBetInvalid = 0;
    const bets: BetData[] = [];
    const chips: number[] = []
    userBets.forEach((bet) => {
        const [chipStr, betAmountStr] = bet.split('-');
        const betAmount = Number(betAmountStr);
        const chip = Number(chipStr);
        const data: BetData = { betAmount, chip };

        if (betAmount <= 0 ||
            betAmount < appConfig.minBetAmount ||
            betAmount > appConfig.maxBetAmount ||
            lData.lobbyId !== lobbyId && lData.status !== 0) isBetInvalid = 1;

        if (![1, 2, 3].includes(chip)) isBetInvalid = 1;
        chips.push(chip);
        totalBetAmount += betAmount;
        bets.push(data);
    });

    if ((chips.includes(1) && chips.includes(3)) ||
        ([1, 2, 3].every(c => chips.includes(c)))) {
        console.log("Invalid Bet: Chips 1 and 3 cannot be placed together");
        isBetInvalid++;
    }

    if (isBetInvalid) {
        return logEventAndEmitResponse(socket, betObj, 'Invalid Bet type/Amount', 'bet');
    }

    if (totalBetAmount > Number(balance)) {
        return logEventAndEmitResponse(socket, betObj, 'Insufficient Balance', 'bet');
    }

    const ip = getUserIP(socket);

    Object.assign(betObj, {
        bet_amount: totalBetAmount,
        userBets: bets,
        ip
    });

    const webhookData = await updateBalanceFromAccount({
        id: lData.lobbyId,
        bet_amount: totalBetAmount,
        game_id,
        bet_id,
        ip,
        user_id: userId
    }, "DEBIT", { game_id, operatorId, token });

    if (!webhookData.status) return socket.emit("betError", "Bet Cancelled By Upstream Server");
    if (webhookData.txn_id) betObj.txn_id = webhookData.txn_id;

    if (!Array.isArray(roundBets[lobbyId])) roundBets[lobbyId] = [];
    roundBets[lobbyId].push(betObj);
    logger.info(JSON.stringify({ betObj }));

    await insertBets({
        totalBetAmount,
        bet_id,
        userBets: betObj.userBets!
    });

    parsedPlayerDetails.balance = Number(balance - totalBetAmount).toFixed(2);
    await setCache(`PL:${socket.id}`, JSON.stringify(parsedPlayerDetails));

    socket.emit("info", {
        user_id: userId,
        operator_id: operatorId,
        balance: parsedPlayerDetails.balance
    });
    return socket.emit("bet", { message: "BET PLACED SUCCESSFULLY" });
};

export const settleBet = async (io: Server, result: GameRoundResult, lobbyId: string): Promise<void> => {
    try {
        const [_, lobbyNo] = lobbyId.split('-');
        if (Array.isArray(roundBets[lobbyId]) && roundBets[lobbyId]?.length > 0) {
            const bets = roundBets[lobbyId];
            const settlements = [];

            for (const betData of bets) {
                const { bet_id, socket_id, game_id, lobby_id, txn_id, userBets, ip, token } = betData;
                const [_, __, user_id, operator_id] = bet_id.split(':');
                let finalAmount = 0;
                let totalMultiplier = 0;
                let totalBetAmount = 0;
                const betResults: BetResult[] = [];
                userBets?.forEach(({ betAmount, chip }) => {
                    totalBetAmount += betAmount;
                    const roundResult = getBetResult(betAmount, chip, result.winner);
                    betResults.push(roundResult);
                    if (roundResult.mult > 0) {
                        totalMultiplier += roundResult.mult;
                        finalAmount += roundResult.winAmount;
                    }
                });

                settlements.push({
                    bet_id: betData.bet_id,
                    totalBetAmount: totalBetAmount,
                    userBets: betResults,
                    result,
                    totalMaxMult: totalMultiplier > 0 ? totalMultiplier : 0.00,
                    winAmount: finalAmount > 0 ? finalAmount : 0.00
                });

                settlBetLogger.info(JSON.stringify({ betData, finalAmount, result, totalMultiplier }));

                const cachedPlayerDetails = await getCache(`PL:${socket_id}`);
                const parsedPlayerDetails = cachedPlayerDetails ? JSON.parse(cachedPlayerDetails) : null;
                if (finalAmount > 0) {
                    const winAmount = finalAmount;
                    const webhookData = await updateBalanceFromAccount({ user_id, winning_amount: winAmount, id: lobbyId, game_id, txn_id: txn_id, ip }, 'CREDIT', { game_id, operatorId: operator_id, token });
                    if (!webhookData.status) console.error('Credit Txn Failed');

                    if (parsedPlayerDetails) {

                        parsedPlayerDetails.balance = Number(Number(parsedPlayerDetails.balance) + winAmount).toFixed(2);
                        await setCache(`PL:${socket_id}`, JSON.stringify(parsedPlayerDetails));
                        setTimeout(() => {
                            io.to(socket_id).emit("info",
                                {
                                    user_id,
                                    operator_id,
                                    balance: parsedPlayerDetails.balance
                                });
                        }, 200);
                    }
                    if (parsedPlayerDetails?.roomId == lobbyNo) io.to(socket_id).emit('settlement', { message: `WIN AMOUNT: ${Number(winAmount).toFixed(2)}`, mywinningAmount: winAmount, status: 'WIN', roundResult: result, betResults, lobby_id });
                } else {
                    if (parsedPlayerDetails?.roomId == lobbyNo) io.to(socket_id).emit('settlement', { message: `YOU LOSS ${totalBetAmount}`, lossAmount: totalBetAmount, status: 'LOSS', roundResult: result, betResults, lobby_id });
                }
            }

            await addSettleBet(settlements);
            roundBets[lobbyId].length = 0;
        }

    } catch (error) {
        console.error('Error settling bets:', error);
    }
};

export const leaveRoom = async (socket: Socket, rmId: string) => {
    if ([...socket.rooms].includes(rmId)) {
        socket.leave(rmId);
        return socket.emit("leaveRoom", "Room left successfully");
    }
    const playerDetails = await getCache(`PL:${socket.id}`);
    if (!playerDetails) {
        return socket.emit('betError', 'Invalid Player Details');
    }
    const parsedPlayerDetails = JSON.parse(playerDetails);
    console.log({ ...parsedPlayerDetails, socketId: socket.id, roomId: "" });
    await setCache(`PL:${socket.id}`, JSON.stringify({ ...parsedPlayerDetails, socketId: socket.id, roomId: "" }));

    return socket.emit("leaveRoom", "You left this room");
};