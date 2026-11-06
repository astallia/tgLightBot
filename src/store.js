import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// A JSON file is enough for a handful of users. The write goes through a temp file
// so that a crash in the middle cannot leave a broken state behind.
export function createStore(path) {
  let state = { fact: null, users: {} };
  try {
    state = { ...state, ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return {
    get fact() {
      return state.fact;
    },
    set fact(value) {
      state.fact = value;
    },
    get power() {
      return state.power;
    },
    set power(value) {
      state.power = value;
    },
    users: () => Object.entries(state.users),
    getUser: (chatId) => state.users[chatId],
    addUser: (chatId) => {
      state.users[chatId] ??= { addresses: [], nextAddressId: 1 };
      return state.users[chatId];
    },
    save: () => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2));
      renameSync(`${path}.tmp`, path);
    },
  };
}
