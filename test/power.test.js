import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createApp } from '../src/app.js';
import { advancePower, createPowerMonitor, observePower } from '../src/power.js';
import { wallToEpoch } from '../src/schedule.js';
import { createStore } from '../src/store.js';
import { XiaomiAuthError } from '../src/xiaomi.js';

const MINUTE = 60000;
const LIMITS = { offAfterMs: 5 * MINUTE, onAfterMs: 2 * MINUTE };
const SENSOR = 'lumi.gateway.mgl03';
const ROUTERS = ['xiaomi.router.rb01', 'xiaomi.router.rb02'];
const TODAY = '1793916000';
const at = (hour, minute = 0, second = 0) => wallToEpoch(2026, 11, 6, hour, minute) + second * 1000;
const allYes = (overrides = {}) => {
  const row = {};
  for (let hour = 1; hour <= 24; hour++) row[hour] = 'yes';
  return { ...row, ...overrides };
};
const devices = (sensor, router1 = true, router2 = true) => [
  { id: 'a', model: 'yunmai.scales.ms104', online: false },
  { id: 'b', model: SENSOR, online: sensor },
  { id: 'c', model: ROUTERS[0], online: router1 },
  { id: 'd', model: ROUTERS[1], online: router2 },
];

test('what the devices say about power', () => {
  assert.equal(observePower(devices(true), SENSOR, ROUTERS), 'on');
  assert.equal(observePower(devices(false), SENSOR, ROUTERS), 'off');
  assert.equal(observePower(devices(false, false, true), SENSOR, ROUTERS), 'off', 'one router is enough to prove the internet works');
  assert.equal(observePower(devices(false, false, false), SENSOR, ROUTERS), 'unknown');
  assert.equal(observePower(devices(true, false, false), SENSOR, ROUTERS), 'on', 'the sensor answering proves power by itself');
  assert.throws(() => observePower(devices(true), 'other.model', ROUTERS), /нет устройства other\.model/);
});

// Feeds a list of [minutes, observed] into the filter and returns events with the minute they fired.
function run(steps) {
  let power;
  const fired = [];
  for (const [minute, observed] of steps) {
    const result = advancePower(power, observed, minute * MINUTE, LIMITS);
    power = result.power;
    for (const event of result.events) fired.push({ ...event, minute });
  }
  return { fired, power };
}

test('with no waiting time every change is reported on the first look', () => {
  const noWait = { offAfterMs: 0, onAfterMs: 0 };
  let { power, events } = advancePower(undefined, 'on', 0, noWait);
  assert.deepEqual(events, []);
  ({ power, events } = advancePower(power, 'off', MINUTE, noWait));
  assert.deepEqual(events, [{ type: 'off', since: MINUTE, litSince: null }]);
  ({ power, events } = advancePower(power, 'off', 2 * MINUTE, noWait));
  assert.deepEqual(events, [], 'no repeat while nothing changes');
  ({ power, events } = advancePower(power, 'on', 3 * MINUTE, noWait));
  assert.deepEqual(events, [{ type: 'on', since: 3 * MINUTE, darkSince: MINUTE }]);
  ({ power, events } = advancePower(power, 'off', 10 * MINUTE, noWait));
  assert.deepEqual(events, [{ type: 'off', since: 10 * MINUTE, litSince: 3 * MINUTE }], 'how long the light was on');
});

test('a lost connection in between does not reset how long the light has been on', () => {
  const noWait = { offAfterMs: 0, onAfterMs: 0 };
  let { power } = advancePower(undefined, 'off', 0, noWait);
  ({ power } = advancePower(power, 'on', MINUTE, noWait));
  let events;
  ({ power, events } = advancePower(power, 'unknown', 5 * MINUTE, noWait));
  assert.equal(events[0].type, 'unknown');
  ({ power, events } = advancePower(power, 'on', 6 * MINUTE, noWait));
  assert.equal(events[0].type, 'reconnected');
  ({ power, events } = advancePower(power, 'off', 11 * MINUTE, noWait));
  assert.deepEqual(events, [{ type: 'off', since: 11 * MINUTE, litSince: MINUTE }]);
});

test('the first look sets the state without an alert', () => {
  assert.deepEqual(run([[0, 'off']]).fired, []);
  assert.deepEqual(run([[0, 'on']]).fired, []);
  assert.equal(run([[0, 'off']]).power.dark, true);
});

test('short drops of the sensor are not reported, even several in a row', () => {
  const { fired, power } = run([
    [0, 'on'], [1, 'off'], [2, 'off'], [3, 'on'], [4, 'off'], [5, 'off'], [6, 'off'], [7, 'off'], [8, 'on'], [9, 'on'], [20, 'on'],
  ]);
  assert.deepEqual(fired, []);
  assert.equal(power.state, 'on');
});

test('a real outage is reported after the wait, with the time it began', () => {
  const { fired } = run([[0, 'on'], [10, 'off'], [12, 'off'], [14, 'off'], [15, 'off'], [16, 'off']]);
  assert.deepEqual(fired, [{ type: 'off', since: 10 * MINUTE, litSince: null, minute: 15 }]);
});

test('light coming back is reported after its own wait, with how long it was gone', () => {
  const { fired } = run([[0, 'on'], [10, 'off'], [15, 'off'], [100, 'on'], [101, 'on'], [102, 'on'], [103, 'on']]);
  assert.deepEqual(fired.at(-1), { type: 'on', since: 100 * MINUTE, darkSince: 10 * MINUTE, minute: 102 });
  assert.equal(fired.length, 2);
});

test('during an outage a brief return of the sensor changes nothing', () => {
  const { fired, power } = run([[0, 'on'], [10, 'off'], [15, 'off'], [50, 'on'], [51, 'off'], [60, 'off']]);
  assert.equal(fired.length, 1);
  assert.equal(power.darkSince, 10 * MINUTE, 'the outage still counts from its real start');
});

test('losing everything is reported as no connection, not as no light', () => {
  const { fired } = run([[0, 'on'], [10, 'unknown'], [15, 'unknown']]);
  assert.deepEqual(fired, [{ type: 'unknown', since: 10 * MINUTE, minute: 15 }]);
});

test('coming back from a lost connection is not called light returning', () => {
  const { fired } = run([[0, 'on'], [10, 'unknown'], [15, 'unknown'], [20, 'on'], [22, 'on']]);
  assert.equal(fired.at(-1).type, 'reconnected');
});

test('the UPS running out during an outage stays one outage', () => {
  const { fired } = run([
    [0, 'on'], [10, 'off'], [15, 'off'], [100, 'unknown'], [105, 'unknown'], [200, 'off'], [205, 'off'], [300, 'on'], [302, 'on'],
  ]);
  assert.deepEqual(fired.map((event) => event.type), ['off', 'on']);
  assert.equal(fired[1].darkSince, 10 * MINUTE);
});

test('power returning while the routers are still restarting is still light returning', () => {
  const { fired } = run([[0, 'on'], [10, 'off'], [15, 'off'], [100, 'unknown'], [105, 'unknown'], [200, 'on'], [202, 'on']]);
  assert.equal(fired.at(-1).type, 'on');
});

test('light returning after the bot started during an outage has no made-up duration', () => {
  const { fired } = run([[0, 'off'], [50, 'on'], [52, 'on']]);
  assert.deepEqual(fired, [{ type: 'on', since: 50 * MINUTE, darkSince: null, minute: 52 }]);
});

const tempDir = mkdtempSync(join(tmpdir(), 'svet-power-'));
after(() => rmSync(tempDir, { recursive: true, force: true }));
let fileCounter = 0;

function setup({ fact } = {}) {
  const clock = { now: at(10) };
  const sent = [];
  const logged = [];
  const xiaomi = { result: devices(true), error: null, listDevices: async () => {
    if (xiaomi.error) throw xiaomi.error;
    return xiaomi.result;
  } };
  const telegram = { sendMessage: async (chatId, text) => { sent.push({ chatId, text }); } };
  const path = join(tempDir, `state-${fileCounter++}.json`);
  const store = createStore(path);
  store.fact = fact ?? { data: { [TODAY]: { G: allYes({ 12: 'no', 13: 'no' }) } }, update: 'u' };
  const me = store.addUser(1);
  me.addresses.push({ id: 1, city: 'с. А', street: 'вул. Б', house: '1', groups: ['G'], seen: {}, warned: {} });
  const friend = store.addUser(2);
  const make = (activeStore) => createPowerMonitor({
    xiaomi, store: activeStore, telegram, sensorModel: SENSOR, referenceModels: ROUTERS, ...LIMITS, now: () => clock.now, log: (line) => logged.push(line),
  });
  return { monitor: make(store), make, store, me, friend, xiaomi, sent, clock, path, logged };
}

async function goDark(ctx, startMinute = 0) {
  await ctx.monitor.poll();
  ctx.xiaomi.result = devices(false);
  ctx.clock.now = at(10, startMinute);
  await ctx.monitor.poll();
  ctx.clock.now = at(10, startMinute + 5);
  await ctx.monitor.poll();
}

test('only people who turned the alerts on get them', async () => {
  const ctx = setup();
  ctx.me.powerAlerts = true;
  await goDark(ctx);
  assert.deepEqual(ctx.sent.map((message) => message.chatId), ['1']);
});

test('an outage the schedule does not expect is called out', async () => {
  const ctx = setup();
  ctx.me.powerAlerts = true;
  await goDark(ctx);
  assert.match(ctx.sent[0].text, /Схоже, світла немає з 10:00/);
  assert.match(ctx.sent[0].text, /За графіком світло зараз має бути, тож це може бути аварійне відключення або збій шлюзу/);
});

test('an outage the schedule expects shows when it should end', async () => {
  const ctx = setup({ fact: { data: { [TODAY]: { G: allYes({ 11: 'no', 12: 'no' }) } }, update: 'u' } });
  ctx.me.powerAlerts = true;
  await goDark(ctx);
  assert.match(ctx.sent[0].text, /За графіком зараз відключення, до 12:00/);
});

test('the check is by the time of the alert, so a drop just before the slot is not called unexpected', async () => {
  const ctx = setup({ fact: { data: { [TODAY]: { G: allYes({ 11: 'no' }) } }, update: 'u' } });
  ctx.me.powerAlerts = true;
  ctx.clock.now = at(9, 50);
  await ctx.monitor.poll();
  ctx.xiaomi.result = devices(false);
  ctx.clock.now = at(9, 58);
  await ctx.monitor.poll();
  ctx.clock.now = at(10, 3);
  await ctx.monitor.poll();
  assert.match(ctx.sent[0].text, /світла немає з 09:58/);
  assert.match(ctx.sent[0].text, /За графіком зараз відключення, до 11:00/);
});

test('light returning says how long it was gone, end to end', async () => {
  const ctx = setup();
  ctx.me.powerAlerts = true;
  await goDark(ctx);
  ctx.xiaomi.result = devices(true);
  ctx.clock.now = at(13, 30);
  await ctx.monitor.poll();
  assert.equal(ctx.sent.length, 1, 'not yet believed');
  ctx.clock.now = at(13, 32);
  await ctx.monitor.poll();
  assert.match(ctx.sent.at(-1).text, /^💡 Світло є з 13:30\. Його не було 3 год 30 хв\./);
});

test('the next outage says how long the light was on, end to end', async () => {
  const ctx = setup();
  ctx.me.powerAlerts = true;
  await goDark(ctx);
  ctx.xiaomi.result = devices(true);
  ctx.clock.now = at(13, 30);
  await ctx.monitor.poll();
  ctx.clock.now = at(13, 32);
  await ctx.monitor.poll();
  ctx.xiaomi.result = devices(false);
  ctx.clock.now = at(19, 48);
  await ctx.monitor.poll();
  ctx.clock.now = at(19, 53);
  await ctx.monitor.poll();
  assert.match(ctx.sent.at(-1).text, /^🌑 Схоже, світла немає з 19:48\. Світло було 6 год 18 хв\./);
});

test('alerts carry the next outage from the schedule', async () => {
  const ctx = setup({ fact: { data: { [TODAY]: { G: allYes({ 12: 'no', 16: 'first', 22: 'no' }) } }, update: 'u' } });
  ctx.me.powerAlerts = true;
  await goDark(ctx);
  assert.match(ctx.sent[0].text, /\nНаступне відключення: 11:00–12:00\.$/);
  ctx.xiaomi.result = devices(true);
  ctx.clock.now = at(11, 30);
  await ctx.monitor.poll();
  ctx.clock.now = at(11, 32);
  await ctx.monitor.poll();
  const message = ctx.sent.at(-1).text;
  assert.match(message, /За графіком відключення ще до 12:00, тож світло може знову зникнути\./);
  assert.match(message, /Наступне відключення: 15:00–15:30\.$/);
});

test('the next outage can be tomorrow, can run past what is published, or not exist', async () => {
  const withTomorrow = setup({ fact: { data: { [TODAY]: { G: allYes() }, 1794002400: { G: allYes({ 7: 'no' }) } }, update: 'u' } });
  withTomorrow.me.powerAlerts = true;
  await goDark(withTomorrow);
  assert.match(withTomorrow.sent[0].text, /Наступне відключення: завтра 06:00–07:00\.$/);

  const openEnded = setup({ fact: { data: { [TODAY]: { G: allYes({ 24: 'no' }) } }, update: 'u' } });
  openEnded.me.powerAlerts = true;
  await goDark(openEnded);
  assert.match(openEnded.sent[0].text, /Наступне відключення: 23:00–00:00 або довше\.$/);

  const none = setup({ fact: { data: { [TODAY]: { G: allYes() } }, update: 'u' } });
  none.me.powerAlerts = true;
  await goDark(none);
  assert.match(none.sent[0].text, /Наступних відключень у графіку поки немає\.$/);
});

test('a possible next outage is called possible', async () => {
  const ctx = setup({ fact: { data: { [TODAY]: { G: allYes({ 20: 'maybe' }) } }, update: 'u' } });
  ctx.me.powerAlerts = true;
  await goDark(ctx);
  assert.match(ctx.sent[0].text, /Наступне можливе відключення: 19:00–20:00\.$/);
});

test('a home on several lines hears about each of them', async () => {
  const ctx = setup({ fact: { data: { [TODAY]: { G: allYes({ 11: 'no', 20: 'no' }), H: allYes({ 15: 'no' }) } }, update: 'u' } });
  ctx.me.addresses[0].groups = ['G', 'H'];
  ctx.me.powerAlerts = true;
  await goDark(ctx);
  const message = ctx.sent[0].text;
  assert.match(message, /Черга G: За графіком зараз відключення, до 11:00/);
  assert.match(message, /Черга H: За графіком світло зараз має бути/);
  assert.match(message, /Черга G: Наступне відключення: 19:00–20:00/);
  assert.match(message, /Черга H: Наступне відключення: 14:00–15:00/);
});

test('someone with no address gets the alert without schedule lines', async () => {
  const ctx = setup();
  ctx.friend.powerAlerts = true;
  await goDark(ctx);
  assert.match(ctx.sent[0].text, /^🌑 Схоже, світла немає з 10:00\.$/);
});

test('no made-up time when the bot has not seen the light come on', async () => {
  const ctx = setup();
  ctx.me.powerAlerts = true;
  await goDark(ctx);
  assert.doesNotMatch(ctx.sent[0].text, /Світло було/);
});

test('a bot restart in the middle of an outage keeps the outage', async () => {
  const ctx = setup();
  ctx.me.powerAlerts = true;
  await goDark(ctx);
  const restarted = ctx.make(createStore(ctx.path));
  ctx.clock.now = at(11);
  await restarted.poll();
  assert.equal(ctx.sent.length, 1, 'no second alert');
  ctx.xiaomi.result = devices(true);
  await restarted.poll();
  ctx.clock.now = at(11, 2);
  await restarted.poll();
  assert.match(ctx.sent.at(-1).text, /Його не було 1 год/);
});

test('short trouble reaching Xiaomi changes nothing and stays quiet', async () => {
  const ctx = setup();
  ctx.me.powerAlerts = true;
  await ctx.monitor.poll();
  ctx.xiaomi.error = new Error('Xiaomi ответил 500');
  ctx.clock.now = at(10, 29);
  await ctx.monitor.poll();
  assert.deepEqual(ctx.sent, []);
  assert.equal(ctx.store.power.state, 'on');
});

test('a long failure is reported once, and so is the recovery', async () => {
  const ctx = setup();
  ctx.me.powerAlerts = true;
  await ctx.monitor.poll();
  ctx.xiaomi.error = new Error('Xiaomi ответил 500');
  await ctx.monitor.poll();
  ctx.clock.now = at(10, 30);
  await ctx.monitor.poll();
  await ctx.monitor.poll();
  assert.equal(ctx.sent.length, 1);
  assert.match(ctx.sent[0].text, /Уже 30 хвилин/);
  ctx.xiaomi.error = null;
  await ctx.monitor.poll();
  assert.equal(ctx.sent.length, 2);
  assert.match(ctx.sent[1].text, /знову надходять/);
});

test('an expired Xiaomi login is reported once, right away', async () => {
  const ctx = setup();
  ctx.me.powerAlerts = true;
  ctx.xiaomi.error = new XiaomiAuthError('Xiaomi отклонил сессию (401)');
  await ctx.monitor.poll();
  await ctx.monitor.poll();
  assert.equal(ctx.sent.length, 1);
  assert.match(ctx.sent[0].text, /Вхід у Xiaomi більше не діє/);
});

test('a missing sensor is a failure, not a power change', async () => {
  const ctx = setup();
  await ctx.monitor.poll();
  ctx.xiaomi.result = devices(true).filter((device) => device.model !== SENSOR);
  ctx.clock.now = at(11);
  await ctx.monitor.poll();
  assert.equal(ctx.store.power.state, 'on');
  assert.match(ctx.logged[0], /нет устройства/);
});

function appFor(ctx, power) {
  const say = (app, text, chatId = 1) => app.handleUpdate({ message: { chat: { id: chatId, type: 'private' }, text } });
  return {
    app: createApp({
      telegram: ctx.telegramForApp, site: {}, store: ctx.store, accessCode: 'secret', power, now: () => ctx.clock.now, log: () => {},
    }),
    say,
  };
}

test('/power turns alerts on with the current state, then off', async () => {
  const ctx = setup({ fact: { data: { [TODAY]: { G: allYes({ 11: 'no', 12: 'no' }) } }, update: 'u' } });
  const replies = [];
  ctx.telegramForApp = { sendMessage: async (chatId, text) => { replies.push(text); } };
  const { app, say } = appFor(ctx, ctx.monitor);
  await say(app, '/power');
  assert.match(replies[0], /увімкнено\.\nЗараз: ще немає даних/);
  await say(app, '/power');
  assert.match(replies[1], /вимкнено/);
  assert.equal(ctx.me.powerAlerts, false);
  await goDark(ctx);
  await say(app, '/power');
  assert.match(replies[2], /Зараз: схоже, світла немає\.\nЗа графіком зараз відключення, до 12:00/);
});

test('/power explains itself when no sensor is set up, and strangers get nothing', async () => {
  const ctx = setup();
  const replies = [];
  ctx.telegramForApp = { sendMessage: async (chatId, text) => { replies.push(text); } };
  const { app, say } = appFor(ctx, null);
  await say(app, '/power');
  assert.match(replies[0], /не налаштований/);
  await say(app, '/power', 999);
  assert.match(replies[1], /за запрошенням/);
});
