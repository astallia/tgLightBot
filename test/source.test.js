import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createScheduleSource, parseSource } from '../src/source.js';

const NOW = Date.parse('2026-11-06T17:20:00Z');
const file = (overrides = {}) => ({
  regionId: 'kyiv-region',
  lastUpdated: '2026-11-06T17:11:16.271Z',
  fact: { data: { 1793916000: { 'GPV2.2': { 1: 'no' } } }, update: '06.11.2026 19:07', today: 1793916000 },
  lastUpdateStatus: { status: 'parsed', ok: true, code: 200, message: null },
  ...overrides,
});

test('the schedule and the time the source read it are taken from the file', () => {
  const { fact, updatedAt } = parseSource(file(), NOW);
  assert.equal(fact.update, '06.11.2026 19:07');
  assert.equal(fact.data['1793916000']['GPV2.2']['1'], 'no');
  assert.equal(updatedAt, Date.parse('2026-11-06T17:11:16.271Z'));
});

test('an empty schedule is valid: no outages published', () => {
  assert.deepEqual(parseSource(file({ fact: { data: [], update: 'u' } }), NOW).fact.data, []);
});

test('a file without a schedule or without a time is an error, never "no outages"', () => {
  assert.throws(() => parseSource(file({ fact: undefined }), NOW), /немає графіка/);
  assert.throws(() => parseSource({ ...file(), fact: { data: null } }, NOW), /немає графіка/);
  assert.throws(() => parseSource(file({ lastUpdated: undefined }), NOW), /немає часу оновлення/);
});

test('a failed update at the source is an error', () => {
  assert.throws(() => parseSource(file({ lastUpdateStatus: { ok: false, code: 422, message: 'parse error' } }), NOW), /не змогло оновити дані: 422 parse error/);
});

test('data the source stopped updating is an error', () => {
  assert.throws(() => parseSource(file(), Date.parse('2026-11-06T17:42:00Z')), /не оновлювалось з 2026-11-06T17:11:16/);
  assert.doesNotThrow(() => parseSource(file(), Date.parse('2026-11-06T17:40:00Z')));
});

async function withServer(handler, run) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.headers['user-agent']);
    handler(req, res);
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    await run(createScheduleSource({ url: `http://127.0.0.1:${server.address().port}/kyiv-region.json` }), requests);
  } finally {
    server.close();
  }
}

test('the source is read over HTTP and the bot says who it is', async () => {
  await withServer((req, res) => res.end(JSON.stringify(file())), async (source, requests) => {
    const { fact } = await source.fetchSchedule(NOW);
    assert.equal(fact.update, '06.11.2026 19:07');
    assert.match(requests[0], /^DtekSvetTelegramBot/);
  });
});

test('an error answer from the source is reported', async () => {
  await withServer((req, res) => {
    res.statusCode = 503;
    res.end('busy');
  }, async (source) => {
    await assert.rejects(source.fetchSchedule(NOW), /Джерело відповіло 503/);
  });
});
