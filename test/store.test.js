import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNeonStore } from '../src/store.js';

function fakeSql(initial = []) {
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    return /select data/.test(text) ? initial : [];
  };
  return { calls, factory: () => sql };
}

test('Neon store loads state and replaces the single JSON row', async () => {
  const db = fakeSql([{ data: { fact: { update: 'old' }, users: {} } }]);
  const store = await createNeonStore({ connectionString: 'postgres://example', sqlFactory: db.factory });
  assert.equal(store.fact.update, 'old');

  store.addUser(123);
  store.fact = { update: 'new' };
  store.save();
  await store.flush();

  assert.equal(db.calls.length, 3);
  const upsert = db.calls[2];
  assert.match(upsert.text, /on conflict \(id\) do update/);
  const saved = JSON.parse(upsert.values[1]);
  assert.equal(saved.fact.update, 'new');
  assert.deepEqual(saved.users['123'], { addresses: [], nextAddressId: 1 });
});

test('Neon store skips a database write when state did not actually change', async () => {
  const db = fakeSql([{ data: { fact: null, users: {} } }]);
  const store = await createNeonStore({ connectionString: 'postgres://example', sqlFactory: db.factory });
  store.save();
  await store.flush();
  assert.equal(db.calls.length, 2);
});

test('Neon store retries a failed write', async () => {
  let writes = 0;
  const sql = async (strings) => {
    const text = strings.join('?');
    if (/select data/.test(text)) return [];
    if (/insert into/.test(text) && writes++ === 0) throw new Error('database unavailable');
    return [];
  };
  const store = await createNeonStore({ connectionString: 'postgres://example', sqlFactory: () => sql });
  store.addUser(123);
  store.save();
  await assert.rejects(store.flush(), /database unavailable/);
  await store.flush();
  assert.equal(writes, 2);
});

test('separate stores never share their users', async () => {
  const { createStore } = await import('../src/store.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'svet-store-'));
  try {
    const first = createStore(join(dir, 'a.json'));
    const second = createStore(join(dir, 'b.json'));
    first.addUser(1);
    assert.equal(second.getUser(1), undefined);
    const neon = await createNeonStore({ connectionString: 'postgres://example', sqlFactory: fakeSql().factory });
    assert.equal(neon.getUser(1), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the time the schedule source was read is kept with the state', async () => {
  const db = fakeSql([{ data: { fact: null, users: {}, sourceUpdatedAt: 5 } }]);
  const store = await createNeonStore({ connectionString: 'postgres://example', sqlFactory: db.factory });
  assert.equal(store.sourceUpdatedAt, 5);
  store.sourceUpdatedAt = 9;
  store.save();
  await store.flush();
  assert.match(JSON.stringify(db.calls.at(-1).values), /sourceUpdatedAt\\":9/);
});
