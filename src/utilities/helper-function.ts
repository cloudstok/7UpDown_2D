import { appConfig } from './app-config';
import { createLogger } from './logger';
import { Socket } from 'socket.io';

const failedBetLogger = createLogger('failedBets', 'jsonl');

export const logEventAndEmitResponse = (
  socket: Socket,
  req: any,
  res: string,
  event: string
): void => {
  const logData = JSON.stringify({ req, res });
  if (event === 'bet') {
    failedBetLogger.error(logData);
  }
  socket.emit('betError', res);
};

export const getUserIP = (socket: any): string => {
  const forwardedFor = socket.handshake.headers?.["x-forwarded-for"];
  if (forwardedFor) {
    const ip = forwardedFor.split(",")[0].trim();
    if (ip) return ip;
  }
  return socket.handshake.address || "";
};


function getRandomNumber(): number {
  return Math.floor(Math.random() * 6) + 1;
}



export interface GameRoundResult {
  resultDiceComb: string;
  resultDiceSum: number;
  winner: 1 | 2 | 3; // 1 = Seven Down, 2 = Seven Up, 3 = Exact Seven
}

export const getResult = (): GameRoundResult => {
  const dice1 = getRandomNumber();
  const dice2 = getRandomNumber();

  const resultDiceComb = `${dice1}-${dice2}`
  const value = dice1 + dice2;

  let winner: 1 | 2 | 3;

  if (value < 7) {
    winner = 1; // Seven Down
  } else if (value > 7) {
    winner = 2; // Seven Up
  } else {
    winner = 3; // Exact Seven
  }

  return {
    resultDiceComb,
    resultDiceSum: value,
    winner,
  };
};

type BetResult = {
  chip: number;
  betAmount: number;
  winAmount: number;
  mult: number;
  status: 'win' | 'loss';
};


export const getBetResult = (betAmount: number, chip: number, result: number): BetResult => {
  const resultData: BetResult = {
    chip,
    betAmount,
    winAmount: 0,
    mult: 0.00,
    status: 'loss'
  };

  if (chip === result) {
    resultData.status = 'win';
    resultData.mult = (chip === 1 || chip === 3) ? 2 : 5;
    resultData.winAmount = Math.min(betAmount * resultData.mult, appConfig.maxCashoutAmount)
  }

  return resultData;
};