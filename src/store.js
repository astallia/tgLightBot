import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY_STATE = { fact: null, users: {} };

function storeApi(state, save, flush = async () => {}) {
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
    save,
    flush,
  };
}

// A JSON file is enough for local use. The write goes through a temp file so that
// a crash in the middle cannot leave a broken state behind.
export function createStore(path) {
  let state = { ...EMPTY_STATE };
  try {
    state = { ...state, ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const save = () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${path}.tmp`, path);
  };
  return storeApi(state, save);
}

// Hosted deployments keep the same compact JSON state in one Neon row. There is no
// history table: every save replaces the previous graph and user state.
export async function createNeonStore({ connectionString, id = 'main', sqlFactory }) {
  const factory = sqlFactory ?? (await import('@neondatabase/serverless')).neon;
  const sql = factory(connectionString);
  await sql`
    create table if not exists bot_state (
      id text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    )
  `;
  const rows = await sql`select data from bot_state where id = ${id}`;
  const state = { ...EMPTY_STATE, ...(rows[0]?.data ?? {}) };
  let persisted = JSON.stringify(state);
  let dirty = false;

  const save = () => {
    dirty = true;
  };
  const flush = async () => {
    while (dirty) {
      dirty = false;
      const data = JSON.stringify(structuredClone(state));
      if (data === persisted) continue;
      try {
        await sql`
          insert into bot_state (id, data, updated_at)
          values (${id}, ${data}::jsonb, now())
          on conflict (id) do update
          set data = excluded.data, updated_at = excluded.updated_at
        `;
        persisted = data;
      } catch (error) {
        dirty = true;
        throw error;
      }
    }
  };
  return storeApi(state, save, flush);
}
