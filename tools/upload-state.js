import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

const { DATABASE_URL, DATA_FILE = 'data/state.json' } = process.env;
if (!DATABASE_URL) throw new Error('Не задан DATABASE_URL');

const state = JSON.parse(await readFile(DATA_FILE, 'utf8'));
const sql = neon(DATABASE_URL);
await sql`
  create table if not exists bot_state (
    id text primary key,
    data jsonb not null,
    updated_at timestamptz not null default now()
  )
`;
await sql`
  insert into bot_state (id, data, updated_at)
  values ('main', ${JSON.stringify(state)}::jsonb, now())
  on conflict (id) do update
  set data = excluded.data, updated_at = excluded.updated_at
`;
console.log(`Состояние из ${DATA_FILE} загружено в Neon.`);
