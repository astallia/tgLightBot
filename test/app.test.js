import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createApp, findMatches } from '../src/app.js';
import { wallToEpoch } from '../src/schedule.js';
import { createStore } from '../src/store.js';

const TODAY = '1793916000';
const TOMORROW = '1794002400';
const CHAT = 111;
const at = (hour, minute = 0, day = 6) => wallToEpoch(2026, 11, day, hour, minute);
const allYes = (overrides = {}) => {
  const row = {};
  for (let hour = 1; hour <= 24; hour++) row[hour] = 'yes';
  return { ...row, ...overrides };
};
const house = (...groups) => ({ sub_type: '', start_date: '', end_date: '', type: '', sub_type_reason: groups, voluntarily: null });

const tempDir = mkdtempSync(join(tmpdir(), 'svet-bot-'));
after(() => rmSync(tempDir, { recursive: true, force: true }));
let fileCounter = 0;

function setup({ fact, houses } = {}) {
  const sent = [];
  const clock = { now: at(9) };
  let pending = null;
  const site = {
    fact: fact ?? { data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }), 'GPV3.1': allYes({ 15: 'no' }) } }, update: '06.11.2026 08:00' },
    failing: false,
    // Publishing on the fake site: both the update check and a full page reload must see it.
    set pendingUpdate(value) {
      pending = value;
      site.fact = value;
    },
    houses: houses ?? {
      12: house('GPV4.2'),
      '17А': house('GPV4.2'),
      20: house('GPV4.2', 'GPV3.1'),
      30: house(),
      40: house('GPV3.1'),
    },
    loadPage: async () => {
      if (site.failing) throw new Error('down');
      return {
        fact: site.fact,
        streets: { 'с. Білогородка': ['вул. Садова', 'пров. Садова', 'вул. Лисенка'], 'с. Гатне': ['вул. Шляхова'], 'с. Без Вулиць': [''] },
      };
    },
    checkUpdate: async () => {
      if (site.failing) throw new Error('down');
      const update = pending;
      pending = null;
      return update;
    },
    lookupHouses: async () => {
      if (site.failing) throw new Error('down');
      return site.houses;
    },
  };
  const telegram = {
    failing: false,
    answerFailing: false,
    sendMessage: async (chatId, text, extra) => {
      if (telegram.failing) throw new Error('telegram down');
      sent.push({ chatId, text, extra });
    },
    sendPhoto: async (chatId, photo, caption, extra) => {
      if (telegram.failing) throw new Error('telegram down');
      sent.push({ chatId, text: caption, extra, photo });
    },
    answerCallbackQuery: async () => {
      if (telegram.answerFailing) throw new Error('query is too old');
    },
  };
  const images = { failing: false, drawn: [] };
  const renderImage = (schedule) => {
    if (images.failing) throw new Error('no font');
    images.drawn.push(schedule);
    return Buffer.from('png');
  };
  const path = join(tempDir, `state-${fileCounter++}.json`);
  const store = createStore(path);
  const make = (activeStore) => createApp({
    telegram, site, store: activeStore, accessCode: 'secret', renderImage, now: () => clock.now, log: () => {},
  });
  const app = make(store);
  const say = (text, chatId = CHAT) => app.handleUpdate({ message: { chat: { id: chatId, type: 'private' }, text } });
  const tap = (data, chatId = CHAT) => app.handleUpdate({ callback_query: { id: 'q', data, message: { chat: { id: chatId } } } });
  const last = () => sent.at(-1);
  const addresses = (chatId = CHAT) => store.getUser(chatId).addresses;
  const addAddress = async (street, number, chatId = CHAT) => {
    await say('/add', chatId);
    await say('Гатне', chatId);
    await say(street, chatId);
    await say(number, chatId);
  };
  return { app, make, say, tap, last, addresses, addAddress, sent, site, telegram, clock, store, path, images };
}

async function registered(options) {
  const ctx = setup(options);
  await ctx.app.pollSite();
  await ctx.say('/start secret');
  await ctx.say('Білогородка');
  await ctx.say('вул. Садова');
  await ctx.say('12');
  ctx.sent.length = 0;
  return ctx;
}

// Two tracked addresses in different queues: 4.2 is dark 11-12, 3.1 is dark 14-15.
async function registeredWithTwo() {
  const ctx = await registered();
  await ctx.addAddress('Шляхова', '40');
  ctx.sent.length = 0;
  return ctx;
}

test('a stranger gets nothing: no schedule, no dialog', async () => {
  const { say, last, store, sent } = setup();
  await say('/start');
  assert.match(last().text, /за запрошенням/);
  await say('/start wrong');
  await say('/schedule');
  await say('/add');
  await say('Білогородка');
  assert.equal(store.users().length, 0);
  assert.ok(sent.every((message) => /за запрошенням/.test(message.text)));
});

test('a stranger cannot use buttons either', async () => {
  const { tap, sent } = setup();
  await tap('del:1');
  await tap('show:1');
  assert.equal(sent.length, 0);
});

test('an invited user walks through city, street and house and gets the schedule', async () => {
  const { say, tap, last, addresses, app } = setup();
  await app.pollSite();
  await say('/start secret');
  assert.match(last().text, /населений пункт/);
  await say('Несуществующее');
  assert.match(last().text, /Нічого не знайдено/);
  await say('Білогородка');
  assert.match(last().text, /вулицю/);
  await say('Садова');
  assert.match(last().text, /Оберіть варіант/);
  assert.deepEqual(last().extra.reply_markup.inline_keyboard.map((row) => row[0].text), ['вул. Садова', 'пров. Садова']);
  await tap('street:0');
  assert.match(last().text, /номер будинку/);
  await say('99');
  assert.match(last().text, /Такого будинку/);
  await say('12');
  const message = last().text;
  assert.match(message, /Адресу додано/);
  assert.match(message, /за 15 хв/);
  assert.doesNotMatch(message, /Білогородка|черга/, 'one address needs no naming');
  assert.match(message, /11:00–12:00/);
  assert.match(message, /💡 23 год/);
  assert.match(message, /🌑 1 год:\n<b>11:00–12:00/);
  assert.doesNotMatch(message, /Завтра/, 'a day with no schedule is not mentioned');
  assert.doesNotMatch(message, /Оновлено/);
  assert.deepEqual(addresses()[0].groups, ['GPV4.2']);
});

// A house on two lines, on the real shape the site uses. 4.2 is dark 11-12, 3.1 is dark 14-15.
async function followingBothLines() {
  const ctx = await registered();
  await ctx.addAddress('Шляхова', '20');
  await ctx.tap('group:2');
  ctx.sent.length = 0;
  ctx.images.drawn.length = 0;
  return ctx;
}

test('a house on two lines offers each queue and an option for people who do not know', async () => {
  const { addAddress, last } = await registered();
  await addAddress('Шляхова', '20');
  assert.match(last().text, /різних ліній, і ДТЕК не вказує, від якої ваша квартира/);
  assert.deepEqual(last().extra.reply_markup.inline_keyboard.map((row) => row[0].text), [
    'Черга 4.2', 'Черга 3.1', 'Не знаю, стежити за всіма',
  ]);
});

test('following all lines keeps both queues and says so everywhere', async () => {
  const { addresses, say, sent, last, images, addAddress, tap } = await registered();
  await addAddress('Шляхова', '20');
  await tap('group:2');
  const address = addresses().at(-1);
  assert.deepEqual(address.groups, ['GPV4.2', 'GPV3.1']);
  assert.equal(address.allLines, true);
  assert.match(last().text, /Адресу додано/);
  assert.match(last().text, /черги 4\.2, 3\.1/);
  assert.match(last().text, /Черга 4\.2\n🌑 1 год:\n<b>11:00–12:00/);
  assert.match(last().text, /Черга 3\.1\n🌑 1 год:\n<b>14:00–15:00/);
  await say('📍 Мої адреси');
  assert.match(last().text, /вул\. Шляхова, 20, черги 4\.2, 3\.1/);
  sent.length = 0;
  images.drawn.length = 0;
  await say('/schedule');
  const drawn = images.drawn.at(-1);
  assert.equal(drawn.queues, 'черги 4.2, 3.1');
  assert.deepEqual(drawn.days[0].lines.map((line) => line.label), ['Черга 4.2', 'Черга 3.1']);
});

test('the same house can be followed by one line or by all, but not twice the same way', async () => {
  const { addresses, addAddress, tap, last } = await followingBothLines();
  await addAddress('Шляхова', '20');
  await tap('group:0');
  assert.equal(addresses().length, 3, 'one line is a different choice');
  await addAddress('Шляхова', '20');
  await tap('group:2');
  assert.match(last().text, /вже відстежується/);
  assert.equal(addresses().length, 3);
});

test('each line warns on its own time and says which one it is', async () => {
  const { app, clock, sent, last } = await followingBothLines();
  clock.now = at(10, 45);
  await app.checkWarnings();
  assert.equal(sent.filter((m) => /вул\. Шляхова, 20/.test(m.text)).length, 1);
  assert.match(sent.find((m) => /вул\. Шляхова, 20/.test(m.text)).text, /вул\. Шляхова, 20, черга 4\.2\nЧерез 15 хв відключення світла: з 11:00 до 12:00/);
  sent.length = 0;
  clock.now = at(13, 45);
  await app.checkWarnings();
  assert.match(last().text, /вул\. Шляхова, 20, черга 3\.1\nЧерез 15 хв відключення світла: з 14:00 до 15:00/);
  await app.checkWarnings();
  assert.equal(sent.length, 1, 'no repeats');
});

test('lines going dark together share one warning, and it is not repeated', async () => {
  const fact = { data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }), 'GPV3.1': allYes({ 12: 'no' }) } }, update: 'u' };
  const ctx = await registered({ fact });
  await ctx.addAddress('Шляхова', '20');
  await ctx.tap('group:2');
  ctx.sent.length = 0;
  ctx.clock.now = at(10, 45);
  await ctx.app.checkWarnings();
  const warnings = ctx.sent.filter((m) => /вул\. Шляхова, 20/.test(m.text));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].text, /вул\. Шляхова, 20, черги 4\.2, 3\.1\n/);
  ctx.clock.now = at(10, 50);
  await ctx.app.checkWarnings();
  assert.equal(ctx.sent.filter((m) => /вул\. Шляхова, 20/.test(m.text)).length, 1);
});

test('lines on the same schedule are shown as one', async () => {
  const fact = { data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }), 'GPV3.1': allYes({ 12: 'no' }) } }, update: 'u' };
  const ctx = await registered({ fact });
  await ctx.addAddress('Шляхова', '20');
  await ctx.tap('group:2');
  assert.match(ctx.last().text, /Черги 4\.2, 3\.1\n🌑 1 год:\n<b>11:00–12:00/);
  assert.deepEqual(ctx.images.drawn.at(-1).days[0].lines.map((line) => line.label), ['Черги 4.2, 3.1']);
});

test('a change on one of the lines is reported with the day that changed', async () => {
  const { app, site, sent, last } = await followingBothLines();
  site.pendingUpdate = { data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }), 'GPV3.1': allYes({ 15: 'no', 16: 'no' }) } }, update: '06.11.2026 10:00' };
  await app.pollSite();
  const notices = sent.filter((m) => /вул\. Шляхова, 20/.test(m.text));
  assert.equal(notices.length, 1);
  assert.match(last().text, /Графік змінився/);
  assert.match(notices[0].text, /14:00–16:00/);
});

test('a line missing from the published data is left out, the other still shows', async () => {
  const fact = { data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }) } }, update: 'u' };
  const ctx = await registered({ fact });
  await ctx.addAddress('Шляхова', '20');
  await ctx.tap('group:2');
  assert.deepEqual(ctx.images.drawn.at(-1).days[0].lines.map((line) => line.label), ['Черга 4.2']);
});

test('the site adding or dropping lines updates an address that follows all of them', async () => {
  const { addresses, say, site, sent } = await followingBothLines();
  site.houses = { ...site.houses, 20: house('GPV4.2') };
  await say('/schedule');
  const address = addresses().at(-1);
  assert.deepEqual(address.groups, ['GPV4.2']);
  assert.equal(address.allLines, false);
  assert.ok(sent.some((m) => /вул\. Шляхова, 20 змінилася: 4\.2, 3\.1 → 4\.2/.test(m.text)));
});

test('someone who chose a line keeps it while the site still lists it', async () => {
  const { addAddress, tap, addresses, say, site } = await registered();
  await addAddress('Шляхова', '20');
  await tap('group:1');
  site.houses = { ...site.houses, 20: house('GPV3.1', 'GPV5.1') };
  await say('/schedule');
  assert.deepEqual(addresses().at(-1).groups, ['GPV3.1']);
});

test('a chosen line the site no longer lists moves to all current lines', async () => {
  const { addAddress, tap, addresses, say, site, sent } = await registered();
  await addAddress('Шляхова', '20');
  await tap('group:1');
  site.houses = { ...site.houses, 20: house('GPV1.1', 'GPV5.1') };
  await say('/schedule');
  assert.deepEqual(addresses().at(-1).groups, ['GPV1.1', 'GPV5.1']);
  assert.equal(addresses().at(-1).allLines, true);
  assert.ok(sent.some((m) => /змінилася: 3\.1 → 1\.1, 5\.1/.test(m.text)));
});

test('an address newly on two lines says so and offers the choice', async () => {
  const { app, addresses, site, sent, tap, last, images } = await registered();
  site.houses = { ...site.houses, 12: house('GPV3.1', 'GPV5.1') };
  await app.refreshAddresses();
  const notice = sent[0];
  assert.match(notice.text, /с\. Білогородка, вул\. Садова, 12 змінилася: 4\.2 → 3\.1, 5\.1\. Будинок підключений до різних ліній/);
  assert.deepEqual(notice.extra.reply_markup.inline_keyboard.map((row) => row[0].text), [
    'Черга 3.1', 'Черга 5.1', 'Не знаю, стежити за всіма',
  ]);
  assert.deepEqual(addresses()[0].groups, ['GPV3.1', 'GPV5.1']);
  sent.length = 0;
  images.drawn.length = 0;
  const id = addresses()[0].id;
  await tap(`line:${id}:0`);
  assert.deepEqual(addresses()[0].groups, ['GPV3.1']);
  assert.equal(addresses()[0].allLines, false);
  assert.deepEqual(addresses()[0].lines, ['GPV3.1', 'GPV5.1']);
  assert.match(last().text, /Збережено: черга 3\.1/);
  assert.equal(images.drawn.at(-1).queues, 'черга 3.1');
  sent.length = 0;
  await app.refreshAddresses();
  assert.equal(sent.length, 0, 'the choice stays and nothing is announced again');
});

test('a house gaining a line keeps the chosen queue but mentions the new one', async () => {
  const { app, addresses, site, sent } = await registered();
  site.houses = { ...site.houses, 12: house('GPV4.2', 'GPV5.1') };
  await app.refreshAddresses();
  assert.deepEqual(addresses()[0].groups, ['GPV4.2']);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /тепер черги 4\.2, 5\.1\. Ви стежите за чергою 4\.2/);
  assert.equal(sent[0].extra.reply_markup.inline_keyboard.length, 3);
  await app.refreshAddresses();
  assert.equal(sent.length, 1);
});

test('losing the other line of a chosen queue passes quietly', async () => {
  const { app, addAddress, tap, addresses, site, sent } = await registered();
  await addAddress('Шляхова', '20');
  await tap('group:0');
  sent.length = 0;
  site.houses = { ...site.houses, 20: house('GPV4.2') };
  await app.refreshAddresses();
  assert.deepEqual(addresses().at(-1).lines, ['GPV4.2']);
  assert.equal(sent.length, 0);
});

test('the address list offers to change the line only for a house with several', async () => {
  const { addAddress, tap, say, last, addresses, sent } = await registered();
  await addAddress('Шляхова', '20');
  await tap('group:2');
  await say('📍 Мої адреси');
  const buttons = last().extra.reply_markup.inline_keyboard.flat().map((button) => button.text);
  assert.deepEqual(buttons, ['📅 Графік 1', '🗑 Видалити 1', '📅 Графік 2', '🗑 Видалити 2', '🔀 Змінити чергу 2']);
  const id = addresses()[1].id;
  await tap(`choose:${id}`);
  assert.match(last().text, /Оберіть чергу для адреси с\. Гатне, вул\. Шляхова, 20/);
  await tap(`line:${id}:1`);
  assert.deepEqual(addresses()[1].groups, ['GPV3.1']);
  await tap(`line:${id}:all`);
  assert.deepEqual(addresses()[1].groups, ['GPV4.2', 'GPV3.1']);
  assert.equal(addresses()[1].allLines, true);
  sent.length = 0;
  await tap(`line:${id}:9`);
  assert.match(last().text, /застарів/);
  assert.deepEqual(addresses()[1].groups, ['GPV4.2', 'GPV3.1']);
});

test('choosing a line does not report that line as a schedule change', async () => {
  const { addAddress, tap, addresses, app, sent } = await registered();
  await addAddress('Шляхова', '20');
  await tap('group:0');
  await tap(`line:${addresses()[1].id}:1`);
  sent.length = 0;
  await app.pollSite();
  assert.equal(sent.length, 0);
});

test('a site update checks the addresses straight away', async () => {
  const { app, addresses, site, sent } = await registered();
  site.houses = { ...site.houses, 12: house('GPV3.1') };
  site.pendingUpdate = { data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }), 'GPV3.1': allYes({ 15: 'no' }) } }, update: '06.11.2026 10:00' };
  await app.pollSite();
  assert.deepEqual(addresses()[0].groups, ['GPV3.1']);
  assert.match(sent[0].text, /змінилася: 4\.2 → 3\.1/);
  assert.match(sent[1].text, /Графік змінився[\s\S]*14:00–15:00/);
});

test('a poll with no site update does not look addresses up', async () => {
  const { app, site } = await registered();
  let lookups = 0;
  const original = site.lookupHouses;
  site.lookupHouses = async () => { lookups++; return original(); };
  await app.pollSite();
  assert.equal(lookups, 0);
});

test('a second address is added next to the first, not instead of it', async () => {
  const { addAddress, addresses, last } = await registered();
  await addAddress('Шляхова', '40');
  assert.deepEqual(addresses().map((address) => [address.city, address.house, address.groups[0]]), [
    ['с. Білогородка', '12', 'GPV4.2'],
    ['с. Гатне', '40', 'GPV3.1'],
  ]);
  assert.match(last().text, /Адресу додано/);
  assert.match(last().text, /с\. Гатне, вул\. Шляхова, 40/);
});

test('the same address is not added twice, but another queue of the same house is', async () => {
  const { addAddress, addresses, last, tap } = await registered();
  await addAddress('Шляхова', '12');
  assert.equal(addresses().length, 2, 'same house number on another street is a new address');
  await addAddress('Шляхова', '12');
  assert.match(last().text, /вже відстежується/);
  assert.equal(addresses().length, 2);
  await addAddress('Шляхова', '20');
  await tap('group:0');
  await addAddress('Шляхова', '20');
  await tap('group:1');
  assert.deepEqual(addresses().filter((address) => address.house === '20').map((address) => address.groups), [['GPV4.2'], ['GPV3.1']]);
  await addAddress('Шляхова', '20');
  await tap('group:1');
  assert.match(last().text, /вже відстежується/);
});

test('addresses are limited, and the limit says what to do', async () => {
  const { say, last, addresses } = await registered();
  for (let i = 0; i < 9; i++) addresses().push({ ...addresses()[0], id: 100 + i });
  await say('/add');
  assert.match(last().text, /до 10 адрес/);
  await say('Гатне');
  assert.doesNotMatch(last().text, /вулицю/, 'no dialog was started');
});

test('users have separate address lists', async () => {
  const { say, addresses } = await registered();
  await say('/start secret', 222);
  await say('Гатне', 222);
  await say('Шляхова', 222);
  await say('40', 222);
  assert.deepEqual(addresses(222).map((address) => address.city), ['с. Гатне']);
  assert.deepEqual(addresses(CHAT).map((address) => address.city), ['с. Білогородка']);
});

test('the schedule button shows every address, each with its own queue', async () => {
  const { say, sent } = await registeredWithTwo();
  await say('📅 Графік');
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /вул\. Садова, 12[\s\S]*черга 4\.2[\s\S]*11:00–12:00/);
  assert.match(sent[1].text, /вул\. Шляхова, 40[\s\S]*черга 3\.1[\s\S]*14:00–15:00/);
});

test('the list shows addresses with buttons, and a button shows only that address', async () => {
  const { say, tap, last, sent, addresses } = await registeredWithTwo();
  await say('📍 Мої адреси');
  assert.match(last().text, /1\. с\. Білогородка, вул\. Садова, 12, черга 4\.2/);
  assert.match(last().text, /2\. с\. Гатне, вул\. Шляхова, 40, черга 3\.1/);
  const keyboard = last().extra.reply_markup.inline_keyboard;
  assert.equal(keyboard.length, 2);
  assert.equal(keyboard[1][0].callback_data, `show:${addresses()[1].id}`);
  assert.equal(keyboard[1][1].callback_data, `del:${addresses()[1].id}`);
  sent.length = 0;
  await tap(keyboard[1][0].callback_data);
  assert.equal(sent.length, 1);
  assert.match(last().text, /вул\. Шляхова, 40/);
});

test('a deleted address stops being tracked, the other one continues', async () => {
  const { tap, app, clock, last, sent, site, addresses } = await registeredWithTwo();
  const [first, second] = addresses();
  await tap(`del:${first.id}`);
  assert.match(last().text, /Адресу видалено: с\. Білогородка, вул\. Садова, 12/);
  assert.match(last().text, /1\. с\. Гатне/);
  assert.deepEqual(addresses().map((address) => address.id), [second.id]);
  sent.length = 0;
  clock.now = at(10, 50);
  await app.checkWarnings();
  assert.equal(sent.length, 0, 'no warning for the deleted address');
  site.pendingUpdate = { data: { [TODAY]: { 'GPV4.2': allYes({ 20: 'no' }), 'GPV3.1': allYes({ 15: 'no' }) } }, update: '06.11.2026 10:51' };
  await app.pollSite();
  assert.equal(sent.length, 0, 'no change notice for the deleted address');
  clock.now = at(13, 50);
  await app.checkWarnings();
  assert.match(last().text, /вул\. Шляхова, 40/);
});

test('an old delete button does no harm and ids are not reused', async () => {
  const { tap, last, addresses, addAddress } = await registeredWithTwo();
  const deletedId = addresses()[1].id;
  await tap(`del:${deletedId}`);
  await addAddress('Шляхова', '40');
  assert.notEqual(addresses()[1].id, deletedId);
  await tap(`del:${deletedId}`);
  assert.match(last().text, /вже немає в списку/);
  assert.equal(addresses().length, 2);
  await tap(`show:${deletedId}`);
  assert.match(last().text, /вже немає в списку/);
});

test('deleting the last address leaves a way forward', async () => {
  const { tap, last, addresses, say } = await registered();
  await tap(`del:${addresses()[0].id}`);
  assert.match(last().text, /Адрес поки немає/);
  await say('/schedule');
  assert.match(last().text, /населений пункт/);
});

test('a menu button during the dialog cancels it', async () => {
  const { say, last, addresses } = await registered();
  await say('/add');
  await say('Гатне');
  await say('📍 Мої адреси');
  assert.match(last().text, /Адреси, що відстежуються/);
  await say('Шляхова');
  assert.match(last().text, /Оберіть дію/);
  assert.equal(addresses().length, 1);
});

test('a house in two queues asks which one, a house with no queue is refused', async () => {
  const { say, tap, last, addresses, app } = setup();
  await app.pollSite();
  await say('/start secret');
  await say('Гатне');
  await say('Шляхова');
  await say('30');
  assert.match(last().text, /немає графіка/);
  assert.equal(addresses().length, 0);
  await say('/add');
  await say('Гатне');
  await say('Шляхова');
  await say('20');
  assert.match(last().text, /різних ліній/);
  await say('текст замість кнопки');
  assert.match(last().text, /кнопкою/);
  await tap('group:1');
  assert.deepEqual(addresses()[0].groups, ['GPV3.1']);
});

test('an old dialog button does not change anything', async () => {
  const { tap, last, addresses } = await registered();
  await tap('group:1');
  assert.match(last().text, /застарів/);
  assert.deepEqual(addresses()[0].groups, ['GPV4.2']);
});

test('a button still works when Telegram refuses to acknowledge it', async () => {
  const { tap, last, telegram, addresses } = await registered();
  telegram.answerFailing = true;
  await tap(`show:${addresses()[0].id}`);
  assert.match(last().text, /🌑 1 год/);
});

test('a city without streets skips straight to the result', async () => {
  const { say, last, addresses, app, site } = setup();
  site.houses = { '-': house('GPV3.1') };
  await app.pollSite();
  await say('/start secret');
  await say('Без Вулиць');
  assert.match(last().text, /Адресу додано/);
  assert.deepEqual(addresses()[0].groups, ['GPV3.1']);
});

test('the warning comes 15 minutes before, exactly once, with the right times', async () => {
  const { app, clock, sent, last } = await registered();
  clock.now = at(10, 44);
  await app.checkWarnings();
  assert.equal(sent.length, 0, '16 minutes before is too early');
  clock.now = at(10, 45);
  await app.checkWarnings();
  assert.equal(sent.length, 1);
  assert.match(last().text, /с\. Білогородка, вул\. Садова, 12\nЧерез 15 хв відключення світла: з 11:00 до 12:00/);
  await app.checkWarnings();
  clock.now = at(10, 50);
  await app.checkWarnings();
  assert.equal(sent.length, 1, 'no repeats');
  clock.now = at(11, 1);
  await app.checkWarnings();
  assert.equal(sent.length, 1, 'nothing after it has started');
});

test('each address gets its own warning at its own time', async () => {
  const { app, clock, sent, last } = await registeredWithTwo();
  clock.now = at(10, 45);
  await app.checkWarnings();
  assert.equal(sent.length, 1);
  assert.match(last().text, /вул\. Садова, 12[\s\S]*з 11:00 до 12:00/);
  clock.now = at(13, 45);
  await app.checkWarnings();
  assert.equal(sent.length, 2);
  assert.match(last().text, /вул\. Шляхова, 40[\s\S]*з 14:00 до 15:00/);
});

test('two addresses in the same queue are both warned, each named', async () => {
  const { app, clock, sent, addAddress } = await registered();
  await addAddress('Шляхова', '12');
  sent.length = 0;
  clock.now = at(10, 45);
  await app.checkWarnings();
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /вул\. Садова, 12/);
  assert.match(sent[1].text, /вул\. Шляхова, 12/);
});

test('a restart does not repeat the warning', async () => {
  const ctx = await registered();
  ctx.clock.now = at(10, 50);
  await ctx.app.checkWarnings();
  assert.match(ctx.last().text, /Через 10 хв/);
  const restarted = ctx.make(createStore(ctx.path));
  await restarted.checkWarnings();
  assert.equal(ctx.sent.length, 1);
});

test('a failed send is retried on the next check', async () => {
  const { app, clock, sent, telegram } = await registered();
  clock.now = at(10, 45);
  telegram.failing = true;
  await app.checkWarnings();
  telegram.failing = false;
  clock.now = at(10, 46);
  await app.checkWarnings();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Через 14 хв/);
});

test('a new outage that appears inside the window warns right away', async () => {
  const { app, clock, site, last } = await registered();
  clock.now = at(14, 50);
  site.pendingUpdate = { data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no', 16: 'no' }) } }, update: '06.11.2026 14:49' };
  await app.pollSite();
  assert.match(last().text, /Графік змінився/);
  await app.checkWarnings();
  assert.match(last().text, /Через 10 хв відключення світла: з 15:00 до 16:00/);
});

test('schedule change reaches the user once, an unrelated update does not', async () => {
  const { app, site, sent, last } = await registered();
  site.pendingUpdate = { data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }), 'GPV3.1': allYes({ 5: 'no' }) } }, update: '06.11.2026 10:00' };
  await app.pollSite();
  assert.equal(sent.length, 0, 'another queue changed');
  site.pendingUpdate = { data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no', 13: 'first' }) } }, update: '06.11.2026 10:30' };
  await app.pollSite();
  assert.equal(sent.length, 1);
  assert.match(last().text, /Графік змінився/);
  assert.match(last().text, /11:00–12:30/);
  assert.match(last().text, /🌑 1 год 30 хв:\n<b>11:00–12:30/);
  await app.pollSite();
  assert.equal(sent.length, 1);
});

test('a change reports only the addresses whose queue changed', async () => {
  const { app, site, sent, last } = await registeredWithTwo();
  site.pendingUpdate = { data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }), 'GPV3.1': allYes({ 15: 'no', 16: 'no' }) } }, update: '06.11.2026 10:00' };
  await app.pollSite();
  assert.equal(sent.length, 1);
  assert.match(last().text, /Графік змінився/);
  assert.match(last().text, /вул\. Шляхова, 40/);
  assert.match(last().text, /14:00–16:00/);
});

test('one undelivered change is retried without resending the delivered ones', async () => {
  const { app, site, telegram, sent } = await registeredWithTwo();
  site.pendingUpdate = { data: { [TODAY]: { 'GPV4.2': allYes({ 14: 'no' }), 'GPV3.1': allYes({ 16: 'no' }) } }, update: '06.11.2026 10:00' };
  const original = telegram.sendPhoto;
  telegram.sendPhoto = async (chatId, photo, text, extra) => {
    if (/вул\. Шляхова/.test(text)) throw new Error('telegram hiccup');
    return original(chatId, photo, text, extra);
  };
  await app.pollSite();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /вул\. Садова/);
  telegram.sendPhoto = original;
  await app.pollSite();
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /Графік змінився[\s\S]*вул\. Шляхова/);
});

test('tomorrow being published is announced, the next midnight is not a change', async () => {
  const { app, site, clock, sent, last } = await registered();
  site.pendingUpdate = {
    data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }) }, [TOMORROW]: { 'GPV4.2': allYes({ 2: 'second' }) } },
    update: '06.11.2026 20:00',
  };
  await app.pollSite();
  assert.match(last().text, /Опубліковано новий графік/);
  assert.match(last().text, /Завтра[\s\S]*01:30–02:00/);
  assert.equal(sent.length, 1);
  clock.now = at(0, 10, 7);
  site.pendingUpdate = { data: { [TOMORROW]: { 'GPV4.2': allYes({ 2: 'second' }) } }, update: '07.11.2026 00:05' };
  await app.pollSite();
  assert.equal(sent.length, 1);
});

test('a change sends only the day that changed, the button shows both', async () => {
  const { app, site, say, sent, last } = await registered();
  site.pendingUpdate = {
    data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }) }, [TOMORROW]: { 'GPV4.2': allYes({ 2: 'second' }) } },
    update: '06.11.2026 20:00',
  };
  await app.pollSite();
  assert.match(last().text, /Завтра, сб 07\.11/);
  assert.doesNotMatch(last().text, /Сьогодні/, 'today did not change');
  site.pendingUpdate = {
    data: { [TODAY]: { 'GPV4.2': allYes({ 14: 'no' }) }, [TOMORROW]: { 'GPV4.2': allYes({ 2: 'second' }) } },
    update: '06.11.2026 21:00',
  };
  await app.pollSite();
  assert.match(last().text, /Графік змінився[\s\S]*Сьогодні, пт 06\.11/);
  assert.doesNotMatch(last().text, /Завтра/, 'tomorrow did not change');
  sent.length = 0;
  await say('/schedule');
  assert.match(last().text, /Сьогодні[\s\S]*Завтра/);
});

test('a withdrawn schedule says so instead of showing nothing', async () => {
  const { app, site, last } = await registered();
  site.pendingUpdate = { data: {}, update: '06.11.2026 10:00' };
  await app.pollSite();
  assert.match(last().text, /Графік змінився[\s\S]*Графіка поки немає\./);
  assert.equal(last().photo, undefined, 'nothing to draw');
});

test('one withdrawn day shows what is still published, not that there is nothing', async () => {
  const fact = { data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }) }, [TOMORROW]: { 'GPV4.2': allYes({ 5: 'no' }) } }, update: 'u' };
  const { app, site, last } = await registered({ fact });
  site.pendingUpdate = { data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }) } }, update: 'u2' };
  await app.pollSite();
  assert.match(last().text, /Графік змінився[\s\S]*Сьогодні, пт 06\.11[\s\S]*11:00–12:00/);
  assert.doesNotMatch(last().text, /Графіка поки немає/);
});

test('tomorrow appears once it is published, without a marker for the current time', async () => {
  const fact = { data: { [TODAY]: { 'GPV4.2': allYes() }, [TOMORROW]: { 'GPV4.2': allYes({ 5: 'no' }) } }, update: 'u' };
  const { say, last, images } = await registered({ fact });
  images.drawn.length = 0;
  await say('/schedule');
  assert.match(last().text, /Завтра, сб 07\.11/);
  const { days } = images.drawn.at(-1);
  assert.deepEqual(days.map((day) => day.title), ['Сьогодні, пт 06.11', 'Завтра, сб 07.11']);
  assert.equal(days[0].nowMinutes, 9 * 60);
  assert.equal(days[1].nowMinutes, undefined);
});

test('only tomorrow published shows only tomorrow', async () => {
  const fact = { data: { [TOMORROW]: { 'GPV4.2': allYes({ 5: 'no' }) } }, update: 'u' };
  const { say, last, images } = await registered({ fact });
  images.drawn.length = 0;
  await say('/schedule');
  assert.doesNotMatch(last().text, /Сьогодні/);
  assert.deepEqual(images.drawn.at(-1).days.map((day) => day.title), ['Завтра, сб 07.11']);
});

test('no schedule at all gets a short answer in text, not an empty picture', async () => {
  const { say, last, images } = await registered({ fact: { data: {}, update: 'u' } });
  images.drawn.length = 0;
  await say('/schedule');
  assert.match(last().text, /Графіка поки немає\./);
  assert.equal(last().photo, undefined);
  assert.equal(images.drawn.length, 0);
});

test('every interval sits on its own line', async () => {
  const fact = { data: { [TODAY]: { 'GPV4.2': allYes({ 1: 'second', 2: 'no', 8: 'no', 12: 'first', 20: 'maybe' }) } }, update: 'u' };
  const { say, last } = await registered({ fact });
  await say('/schedule');
  assert.ok(last().text.includes('🌑 3 год:\n<b>00:30–02:00</b>,\n<b>07:00–08:00</b>,\n<b>11:00–11:30</b>\n'));
  assert.ok(last().text.includes('❔ 1 год:\n<b>19:00–20:00</b>\n'));
});

test('with several addresses each message and picture names its address', async () => {
  const { say, sent, images } = await registeredWithTwo();
  images.drawn.length = 0;
  await say('/schedule');
  assert.match(sent[0].text, /^📍 с\. Білогородка, вул\. Садова, 12 · черга 4\.2\n\n/);
  assert.match(sent[1].text, /^📍 с\. Гатне, вул\. Шляхова, 40 · черга 3\.1\n\n/);
  assert.equal(images.drawn[0].address, 'с. Білогородка, вул. Садова, 12');
  assert.equal(images.drawn[1].address, 'с. Гатне, вул. Шляхова, 40');
});

test('an outage in progress and a change notice stay in the message', async () => {
  const { say, app, last, site } = await registered();
  site.houses = {
    12: {
      sub_type: 'Аварійні ремонтні роботи', start_date: 'a', end_date: 'b', type: '2', sub_type_reason: ['GPV4.2'],
    },
  };
  await say('/schedule');
  assert.match(last().text, /^⚠️ <b>Зараз за адресою немає світла<\/b>/);
  site.pendingUpdate = { data: { [TODAY]: { 'GPV4.2': allYes({ 15: 'no' }) } }, update: 'u2' };
  await app.pollSite();
  assert.match(last().text, /^🔄 <b>Графік змінився<\/b>/);
});

test('the schedule goes out as a picture with the text as its caption', async () => {
  const { say, last, images } = await registered();
  images.drawn.length = 0;
  await say('/schedule');
  assert.equal(last().photo.toString(), 'png');
  assert.equal(last().text, '<b>Сьогодні, пт 06.11</b>\n🌑 1 год:\n<b>11:00–12:00</b>\n💡 23 год');
  assert.ok(last().extra.reply_markup.keyboard, 'the menu stays');
  const [schedule] = images.drawn;
  assert.equal(schedule.address, undefined, 'one address needs no naming');
  assert.equal(schedule.queues, 'черга 4.2');
  assert.deepEqual(schedule.days.map((day) => day.title), ['Сьогодні, пт 06.11'], 'tomorrow has no schedule yet');
  assert.equal(schedule.days[0].lines[0].row[12], 'no');
  assert.equal(schedule.days[0].lines[0].label, undefined);
  assert.equal(schedule.days[0].nowMinutes, 9 * 60, 'the marker is on today');
});

test('a new address and a schedule change come as pictures too', async () => {
  const { app, addAddress, site, last, images } = await registered();
  await addAddress('Шляхова', '40');
  assert.equal(last().photo.toString(), 'png');
  assert.match(last().text, /Адресу додано/);
  images.drawn.length = 0;
  site.pendingUpdate = { data: { [TODAY]: { 'GPV4.2': allYes({ 14: 'no' }), 'GPV3.1': allYes({ 15: 'no' }) } }, update: '06.11.2026 10:00' };
  await app.pollSite();
  assert.equal(last().photo.toString(), 'png');
  assert.deepEqual(images.drawn[0].days.map((day) => day.title), ['Сьогодні, пт 06.11'], 'only the changed day');
});

test('if the picture cannot be drawn, the schedule still arrives as text', async () => {
  const { say, last, images } = await registered();
  images.failing = true;
  await say('/schedule');
  assert.equal(last().photo, undefined);
  assert.match(last().text, /🌑 1 год:\n<b>11:00–12:00/);
  assert.ok(last().extra.reply_markup.keyboard);
});

test('text too long for a caption follows the picture as its own message', async () => {
  const { say, sent, site } = await registered();
  site.houses = {
    12: {
      sub_type: 'д'.repeat(1100), start_date: 'a', end_date: 'b', type: '2', sub_type_reason: ['GPV4.2'],
    },
  };
  sent.length = 0;
  await say('/schedule');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].photo.toString(), 'png');
  assert.equal(sent[0].text, '');
  assert.match(sent[1].text, /Зараз за адресою немає світла/);
});

test('addresses and a change while the bot was off survive a restart', async () => {
  const ctx = await registeredWithTwo();
  ctx.site.fact = { data: { [TODAY]: { 'GPV4.2': allYes({ 15: 'no' }), 'GPV3.1': allYes({ 15: 'no' }) } }, update: '06.11.2026 11:00' };
  const reloaded = createStore(ctx.path);
  assert.equal(reloaded.getUser(CHAT).addresses.length, 2);
  await ctx.make(reloaded).pollSite();
  assert.equal(ctx.sent.length, 1);
  assert.match(ctx.last().text, /Графік змінився/);
  assert.match(ctx.last().text, /вул\. Садова, 12[\s\S]*14:00–15:00/);
});

test('a change is retried until it is really delivered', async () => {
  const { app, site, telegram, sent } = await registered();
  site.pendingUpdate = { data: { [TODAY]: { 'GPV4.2': allYes({ 15: 'no' }) } }, update: '06.11.2026 11:00' };
  telegram.failing = true;
  await app.pollSite();
  telegram.failing = false;
  await app.pollSite();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Графік змінився/);
});

test('the schedule shows an outage in progress and when the queue schedule does not apply', async () => {
  const { say, last, site } = await registered();
  site.houses = {
    12: {
      sub_type: 'Аварійні ремонтні роботи', start_date: '12:25 05.11.2026', end_date: '15:00 06.11.2026', type: '2', sub_type_reason: ['GPV4.2'],
    },
  };
  await say('/schedule');
  assert.match(last().text, /Зараз за адресою немає світла/);
  assert.match(last().text, /Аварійні ремонтні роботи/);
  assert.match(last().text, /до: 15:00 06\.11\.2026/);
  assert.doesNotMatch(last().text, /не діють/);
  site.houses[12].sub_type = 'Екстренні відключення (Аварійне без застосування графіку погодинних відключень)';
  await say('/schedule');
  assert.match(last().text, /Графіки зараз не діють/);
});

test('a reassigned queue follows the address and names it', async () => {
  const { say, sent, site, addresses } = await registered();
  site.houses = { 12: house('GPV3.1') };
  await say('/schedule');
  assert.deepEqual(addresses()[0].groups, ['GPV3.1']);
  assert.match(sent[0].text, /с\. Білогородка, вул\. Садова, 12 змінилася: 4\.2 → 3\.1/);
  assert.match(sent[1].text, /14:00–15:00/);
});

test('the periodic address check also catches a reassigned queue', async () => {
  const { app, sent, site, addresses } = await registered();
  site.houses = { 12: house('GPV3.1') };
  await app.refreshAddresses();
  assert.deepEqual(addresses()[0].groups, ['GPV3.1']);
  assert.match(sent[0].text, /змінилася: 4\.2 → 3\.1/);
  assert.match(sent[1].text, /Графік змінився[\s\S]*14:00–15:00/);
});

test('the schedule still works from memory when the address lookup fails, and says the site is down', async () => {
  const { app, say, last, site } = await registered();
  site.failing = true;
  await app.pollSite();
  await say('/schedule');
  assert.match(last().text, /11:00–12:00/);
  assert.match(last().text, /Сайт зараз не відповідає/);
});

test('a long site failure is reported once, and so is the recovery', async () => {
  const { app, site, clock, sent, last } = await registered();
  site.failing = true;
  await app.pollSite();
  clock.now += 29 * 60000;
  await app.pollSite();
  assert.equal(sent.length, 0, 'a short failure stays quiet');
  clock.now += 60000;
  await app.pollSite();
  await app.pollSite();
  assert.equal(sent.length, 1);
  assert.match(last().text, /Уже 30 хвилин/);
  site.failing = false;
  await app.pollSite();
  assert.equal(sent.length, 2);
  assert.match(last().text, /знову відповідає/);
});

test('warnings keep working from the last known schedule while the site is down', async () => {
  const { app, site, clock, last } = await registered();
  site.failing = true;
  await app.pollSite();
  clock.now = at(10, 45);
  await app.checkWarnings();
  assert.match(last().text, /Через 15 хв/);
});

test('group chats are ignored', async () => {
  const { app, sent } = setup();
  await app.handleUpdate({ message: { chat: { id: -5, type: 'group' }, text: '/start secret' } });
  assert.equal(sent.length, 0);
});

test('search copes with a Russian keyboard and missing prefixes', () => {
  const names = ['с. Білогородка', 'м. Яготин', "с. П'ятигори", 'с. Гатне', 'с. Нове Гатне'];
  assert.deepEqual(findMatches(names, 'билогородка'), ['с. Білогородка']);
  assert.deepEqual(findMatches(names, 'пятигори'), ["с. П'ятигори"]);
  assert.deepEqual(findMatches(names, 'с гатне'), ['с. Гатне']);
  assert.deepEqual(findMatches(names, 'Гатне'), ['с. Гатне', 'с. Нове Гатне']);
  assert.deepEqual(findMatches(names, 'яго'), ['м. Яготин']);
  assert.deepEqual(findMatches(names, '   '), []);
});
