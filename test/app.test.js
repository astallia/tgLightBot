import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createApp } from '../src/app.js';
import { snapshot, wallToEpoch } from '../src/schedule.js';
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

const tempDir = mkdtempSync(join(tmpdir(), 'svet-bot-'));
after(() => rmSync(tempDir, { recursive: true, force: true }));
let fileCounter = 0;

function setup({ fact } = {}) {
  const sent = [];
  const clock = { now: at(9) };
  const source = {
    failing: false,
    fact: fact ?? { data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }), 'GPV3.1': allYes({ 15: 'no' }) } }, update: '06.11.2026 08:00' },
    updatedAt: at(8, 58),
    // A newer version of the file, read later than the one before.
    publish(next) {
      source.fact = next;
      source.updatedAt = Math.max(source.updatedAt + 1000, clock.now);
    },
    fetchSchedule: async () => {
      if (source.failing) throw new Error('down');
      return { fact: source.fact, updatedAt: source.updatedAt };
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
    telegram, source, store: activeStore, accessCode: 'secret', renderImage, now: () => clock.now, log: () => {},
  });
  const app = make(store);
  const say = (text, chatId = CHAT) => app.handleUpdate({ message: { chat: { id: chatId, type: 'private' }, text } });
  const tap = (data, chatId = CHAT) => app.handleUpdate({ callback_query: { id: 'q', data, message: { chat: { id: chatId } } } });
  const last = () => sent.at(-1);
  const addresses = (chatId = CHAT) => store.getUser(chatId).addresses;
  const addQueue = async (queue, chatId = CHAT) => {
    await say('/add', chatId);
    await tap(`queue:GPV${queue}`, chatId);
  };
  return { app, make, say, tap, last, addresses, addQueue, sent, source, telegram, clock, store, path, images };
}

// Queue 4.2 is dark 11-12, queue 3.1 is dark 14-15.
async function registered(options) {
  const ctx = setup(options);
  await ctx.app.pollSite();
  await ctx.say('/start secret');
  await ctx.tap('queue:GPV4.2');
  ctx.sent.length = 0;
  ctx.images.drawn.length = 0;
  return ctx;
}

async function registeredWithTwo(options) {
  const ctx = await registered(options);
  await ctx.addQueue('3.1');
  ctx.sent.length = 0;
  ctx.images.drawn.length = 0;
  return ctx;
}

// An entry saved back when addresses were looked up on the DTEK site, on a house with two lines.
function addOldStreetAddress(ctx, groups = ['GPV4.2', 'GPV3.1']) {
  const user = ctx.store.getUser(CHAT);
  const address = {
    id: user.nextAddressId++,
    city: 'с. Гатне',
    street: 'вул. Шляхова',
    house: '20',
    groups,
    allLines: groups.length > 1,
    lines: ['GPV4.2', 'GPV3.1'],
    seen: Object.fromEntries(groups.map((group) => [group, snapshot(ctx.store.fact, group)])),
    warned: {},
  };
  user.addresses.push(address);
  return address;
}

const moved = (source, row) => source.publish({ data: { [TODAY]: { 'GPV4.2': row } }, update: 'after' });
const planned = (row) => ({ data: { [TODAY]: { 'GPV4.2': row } }, update: 'before' });

test('a stranger gets nothing: no schedule, no choice of queue', async () => {
  const { say, tap, store, sent } = setup();
  await say('/start');
  await say('/start wrong');
  await say('/schedule');
  await say('/add');
  await say('2.2');
  await tap('queue:GPV2.2');
  await tap('del:1');
  assert.equal(store.users().length, 0);
  assert.ok(sent.every((message) => /за запрошенням/.test(message.text)));
});

test('an invited user picks a queue with a button and gets its schedule', async () => {
  const { app, say, tap, last, addresses, sent } = setup();
  await app.pollSite();
  await say('/start secret');
  assert.match(sent[0].text, /для вашої черги/);
  const prompt = last();
  assert.match(prompt.text, /Оберіть свою чергу/);
  assert.match(prompt.text, /<a href="https:\/\/www\.dtek-krem\.com\.ua\/ua\/shutdowns">сайті ДТЕК<\/a>/);
  const buttons = prompt.extra.reply_markup.inline_keyboard;
  assert.equal(buttons.length, 6, 'two queues per row');
  assert.deepEqual(buttons.flat().map((button) => button.text), [
    'Черга 1.1', 'Черга 1.2', 'Черга 2.1', 'Черга 2.2', 'Черга 3.1', 'Черга 3.2',
    'Черга 4.1', 'Черга 4.2', 'Черга 5.1', 'Черга 5.2', 'Черга 6.1', 'Черга 6.2',
  ]);
  await tap(buttons[3][1].callback_data);
  assert.equal(last().photo.toString(), 'png');
  assert.match(last().text, /^✅ <b>Додано: черга 4\.2<\/b>\nПовідомлятиму про зміни графіка та попереджатиму за 15 хв до відключення\./);
  assert.match(last().text, /👉 <b>11:00–12:00<\/b> · 1 год/);
  assert.deepEqual(addresses()[0].groups, ['GPV4.2']);
});

test('a queue can be typed in the ways people write it', async () => {
  for (const typed of ['2.2', '2,2', 'Черга 2.2', ' 2 . 2 ']) {
    const { app, say, addresses } = setup();
    await app.pollSite();
    await say('/start secret');
    await say(typed);
    assert.deepEqual(addresses()[0]?.groups, ['GPV2.2'], typed);
  }
});

test('a queue that does not exist is not saved, and the bot says how to write one', async () => {
  const { app, say, last, addresses } = setup();
  await app.pollSite();
  await say('/start secret');
  for (const typed of ['7.1', '2.3', 'вул. Садова, 12']) {
    await say(typed);
    assert.match(last().text, /Такої черги немає/);
  }
  assert.equal(addresses().length, 0);
});

test('a message after the queue is chosen is not taken for another queue', async () => {
  const { say, last, addresses } = await registered();
  await say('3.1');
  assert.match(last().text, /Оберіть дію/);
  assert.equal(addresses().length, 1);
});

test('the same queue is not added twice', async () => {
  const { addQueue, last, addresses } = await registered();
  await addQueue('4.2');
  assert.match(last().text, /Черга 4\.2 вже відстежується/);
  assert.equal(addresses().length, 1);
});

test('entries are limited, and the limit says what to do', async () => {
  const { say, tap, last, addresses } = await registered();
  for (let i = 0; i < 9; i++) addresses().push({ ...addresses()[0], id: 100 + i, groups: [`GPV9.${i}`] });
  await say('/add');
  assert.match(last().text, /до 10 черг/);
  await tap('queue:GPV1.1');
  assert.match(last().text, /до 10 черг/, 'an old keyboard cannot get past the limit');
  assert.equal(addresses().length, 10);
});

test('users have separate lists', async () => {
  const { say, tap, addresses } = await registered();
  await say('/start secret', 222);
  await tap('queue:GPV3.1', 222);
  assert.deepEqual(addresses(222).map((address) => address.groups), [['GPV3.1']]);
  assert.deepEqual(addresses(CHAT).map((address) => address.groups), [['GPV4.2']]);
});

test('buttons from the old address search answer that the list is out of date', async () => {
  const { tap, last, addresses } = await registered();
  for (const data of ['city:0', 'street:1', 'house:0', 'group:2', 'queue:GPV7.7']) {
    await tap(data);
    assert.match(last().text, /Цей список застарів\. Щоб додати чергу/);
  }
  assert.equal(addresses().length, 1);
});

test('the old menu buttons still work', async () => {
  const { say, last } = await registered();
  await say('➕ Додати адресу');
  assert.match(last().text, /Оберіть свою чергу/);
  await say('📍 Мої адреси');
  assert.match(last().text, /Що відстежується/);
  assert.equal(last().extra.reply_markup.inline_keyboard.length, 1);
});

test('the menu is the new one', async () => {
  const { say, last } = await registered();
  await say('щось');
  assert.deepEqual(last().extra.reply_markup.keyboard.flat().map((button) => button.text), ['📅 Графік', '➕ Додати чергу', '📍 Мої черги']);
});

test('the schedule button shows every entry, each named when there are several', async () => {
  const { say, sent, images } = await registeredWithTwo();
  await say('📅 Графік');
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /^📍 Черга 4\.2\n\n<b>Сьогодні, пт 06\.11<\/b>[\s\S]*11:00–12:00/);
  assert.match(sent[1].text, /^📍 Черга 3\.1\n\n[\s\S]*14:00–15:00/);
  assert.equal(images.drawn[0].address, undefined, 'a queue needs no address line');
  assert.equal(images.drawn[0].days[0].lines[0].label, 'Черга 4.2', 'the picture says which queue it is');
});

test('with one entry the message holds only the days', async () => {
  const { say, last, images } = await registered();
  await say('/schedule');
  assert.equal(last().text, '<b>Сьогодні, пт 06.11</b>\n🌑 Без світла 1 год:\n👉 <b>11:00–12:00</b> · 1 год\n💡 Світло 23 год');
  assert.equal(images.drawn.at(-1).days[0].lines[0].label, undefined);
});

test('the list shows each entry with buttons, and a button shows only that one', async () => {
  const { say, tap, last, sent, addresses } = await registeredWithTwo();
  await say('📍 Мої черги');
  assert.match(last().text, /<b>Що відстежується<\/b>\n1\. Черга 4\.2\n2\. Черга 3\.1/);
  const keyboard = last().extra.reply_markup.inline_keyboard;
  assert.deepEqual(keyboard.flat().map((button) => button.text), ['📅 Графік 1', '🗑 Видалити 1', '📅 Графік 2', '🗑 Видалити 2']);
  sent.length = 0;
  await tap(`show:${addresses()[1].id}`);
  assert.equal(sent.length, 1);
  assert.match(last().text, /Черга 3\.1/);
});

test('a deleted entry stops being followed, the other one continues', async () => {
  const { tap, app, clock, last, sent, source, addresses } = await registeredWithTwo();
  const [first, second] = addresses();
  await tap(`del:${first.id}`);
  assert.match(last().text, /Видалено: Черга 4\.2\.[\s\S]*1\. Черга 3\.1/);
  assert.deepEqual(addresses().map((address) => address.id), [second.id]);
  sent.length = 0;
  clock.now = at(10, 50);
  await app.checkWarnings();
  assert.equal(sent.length, 0);
  source.publish({ data: { [TODAY]: { 'GPV4.2': allYes({ 20: 'no' }), 'GPV3.1': allYes({ 15: 'no' }) } }, update: 'later' });
  await app.pollSite();
  assert.equal(sent.length, 0);
  clock.now = at(13, 50);
  await app.checkWarnings();
  assert.match(last().text, /^⚠️ Черга 3\.1\n/);
});

test('an old delete button does no harm and ids are not reused', async () => {
  const { tap, last, addresses, addQueue } = await registeredWithTwo();
  const deletedId = addresses()[1].id;
  await tap(`del:${deletedId}`);
  await addQueue('3.1');
  assert.notEqual(addresses()[1].id, deletedId);
  await tap(`del:${deletedId}`);
  assert.match(last().text, /вже немає в списку/);
  assert.equal(addresses().length, 2);
});

test('deleting the last entry leaves a way forward', async () => {
  const { tap, last, addresses, say } = await registered();
  await tap(`del:${addresses()[0].id}`);
  assert.match(last().text, /Поки нічого не відстежується/);
  await say('/schedule');
  assert.match(last().text, /Оберіть свою чергу/);
});

test('a menu button while choosing cancels the choice', async () => {
  const { say, last, addresses } = await registered();
  await say('/add');
  await say('📍 Мої черги');
  await say('3.1');
  assert.match(last().text, /Оберіть дію/);
  assert.equal(addresses().length, 1);
});

test('a button still works when Telegram refuses to acknowledge it', async () => {
  const { tap, last, telegram, addresses } = await registered();
  telegram.answerFailing = true;
  await tap(`show:${addresses()[0].id}`);
  assert.match(last().text, /11:00–12:00/);
});

test('an address saved before keeps working, with its line choice', async () => {
  const ctx = await registered();
  const address = addOldStreetAddress(ctx);
  await ctx.say('📍 Мої черги');
  assert.match(ctx.last().text, /2\. с\. Гатне, вул\. Шляхова, 20 · черги 4\.2, 3\.1/);
  const buttons = ctx.last().extra.reply_markup.inline_keyboard.flat().map((button) => button.text);
  assert.ok(buttons.includes('🔀 Змінити чергу 2'));
  ctx.sent.length = 0;
  await ctx.say('/schedule');
  assert.match(ctx.sent[1].text, /^📍 с\. Гатне, вул\. Шляхова, 20 · черги 4\.2, 3\.1/);
  assert.match(ctx.sent[1].text, /Черга 4\.2\n🌑[\s\S]*Черга 3\.1\n🌑/);
  assert.equal(ctx.images.drawn.at(-1).address, 'с. Гатне, вул. Шляхова, 20');
  await ctx.tap(`choose:${address.id}`);
  assert.match(ctx.last().text, /Оберіть чергу для адреси с\. Гатне, вул\. Шляхова, 20/);
  await ctx.tap(`line:${address.id}:1`);
  assert.deepEqual(address.groups, ['GPV3.1']);
  assert.match(ctx.last().text, /Збережено: черга 3\.1/);
  await ctx.tap(`line:${address.id}:9`);
  assert.match(ctx.last().text, /застарів/);
  await ctx.tap(`line:${address.id}:all`);
  assert.deepEqual(address.groups, ['GPV4.2', 'GPV3.1']);
});

test('an old address on two lines warns per line and names both address and line', async () => {
  const ctx = await registered();
  ctx.addresses().splice(0, 1);
  addOldStreetAddress(ctx);
  ctx.clock.now = at(10, 45);
  await ctx.app.checkWarnings();
  assert.match(ctx.last().text, /^⚠️ с\. Гатне, вул\. Шляхова, 20, черга 4\.2\nЧерез 15 хв відключення світла: з 11:00 до 12:00\./);
  ctx.clock.now = at(13, 45);
  await ctx.app.checkWarnings();
  assert.match(ctx.last().text, /черга 3\.1\nЧерез 15 хв відключення світла: з 14:00 до 15:00/);
});

test('the warning comes 15 minutes before, exactly once, with the right times', async () => {
  const { app, clock, sent, last } = await registered();
  clock.now = at(10, 44);
  await app.checkWarnings();
  assert.equal(sent.length, 0, '16 minutes before is too early');
  clock.now = at(10, 45);
  await app.checkWarnings();
  assert.equal(last().text, '⚠️ Черга 4.2\nЧерез 15 хв відключення світла: з 11:00 до 12:00.');
  clock.now = at(10, 50);
  await app.checkWarnings();
  clock.now = at(11, 1);
  await app.checkWarnings();
  assert.equal(sent.length, 1);
});

test('each entry gets its own warning at its own time', async () => {
  const { app, clock, sent, last } = await registeredWithTwo();
  clock.now = at(10, 45);
  await app.checkWarnings();
  assert.match(last().text, /Черга 4\.2[\s\S]*з 11:00 до 12:00/);
  clock.now = at(13, 45);
  await app.checkWarnings();
  assert.equal(sent.length, 2);
  assert.match(last().text, /Черга 3\.1[\s\S]*з 14:00 до 15:00/);
});

test('a restart does not repeat the warning', async () => {
  const ctx = await registered();
  ctx.clock.now = at(10, 50);
  await ctx.app.checkWarnings();
  assert.match(ctx.last().text, /Через 10 хв/);
  await ctx.make(createStore(ctx.path)).checkWarnings();
  assert.equal(ctx.sent.length, 1);
});

test('a failed warning is retried on the next check', async () => {
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

test('a schedule change reaches the user once, a change for another queue does not', async () => {
  const { app, source, sent, last } = await registered();
  source.publish({ data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }), 'GPV3.1': allYes({ 5: 'no' }) } }, update: '10:00' });
  await app.pollSite();
  assert.equal(sent.length, 0);
  source.publish({ data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no', 13: 'first' }) } }, update: '10:30' });
  await app.pollSite();
  assert.equal(sent.length, 1);
  assert.match(last().text, /^🔄 <b>Графік змінився<\/b>/);
  assert.match(last().text, /🌑 Без світла 1 год 30 хв:\n👉 <b>11:00–12:30<\/b>/);
  await app.pollSite();
  assert.equal(sent.length, 1);
});

test('an older copy of the source coming back after a newer one changes nothing', async () => {
  const { app, source, sent, store } = await registered();
  const older = { fact: source.fact, updatedAt: source.updatedAt };
  source.publish({ data: { [TODAY]: { 'GPV4.2': allYes({ 15: 'no' }) } }, update: 'new' });
  await app.pollSite();
  assert.equal(sent.length, 1);
  source.fact = older.fact;
  source.updatedAt = older.updatedAt;
  await app.pollSite();
  assert.equal(sent.length, 1, 'no change notice going back and forth');
  assert.equal(store.fact.update, 'new');
});

test('a change reports only the entries whose queue changed', async () => {
  const { app, source, sent } = await registeredWithTwo();
  source.publish({ data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }), 'GPV3.1': allYes({ 15: 'no', 16: 'no' }) } }, update: '10:00' });
  await app.pollSite();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Графік змінився<\/b>\n\n📍 Черга 3\.1[\s\S]*14:00–16:00/);
});

test('one undelivered change is retried without resending the delivered ones', async () => {
  const { app, source, telegram, sent } = await registeredWithTwo();
  source.publish({ data: { [TODAY]: { 'GPV4.2': allYes({ 14: 'no' }), 'GPV3.1': allYes({ 16: 'no' }) } }, update: '10:00' });
  const original = telegram.sendPhoto;
  telegram.sendPhoto = async (chatId, photo, text, extra) => {
    if (/Черга 3\.1/.test(text)) throw new Error('telegram hiccup');
    return original(chatId, photo, text, extra);
  };
  await app.pollSite();
  assert.equal(sent.length, 1);
  telegram.sendPhoto = original;
  await app.pollSite();
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /Графік змінився[\s\S]*Черга 3\.1/);
});

test('tomorrow being published is announced alone, and the next midnight is not a change', async () => {
  const { app, source, clock, sent, last, images } = await registered();
  source.publish({
    data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }) }, [TOMORROW]: { 'GPV4.2': allYes({ 2: 'second' }) } },
    update: '20:00',
  });
  await app.pollSite();
  assert.match(last().text, /^🆕 <b>Опубліковано новий графік<\/b>\n\n<b>Завтра, сб 07\.11<\/b>/);
  assert.doesNotMatch(last().text, /Сьогодні/);
  assert.deepEqual(images.drawn.at(-1).days.map((day) => day.title), ['Завтра, сб 07.11']);
  clock.now = at(0, 10, 7);
  source.publish({ data: { [TOMORROW]: { 'GPV4.2': allYes({ 2: 'second' }) } }, update: '00:05' });
  await app.pollSite();
  assert.equal(sent.length, 1);
});

test('entries and a change while the bot was off survive a restart', async () => {
  const ctx = await registeredWithTwo();
  ctx.source.publish({ data: { [TODAY]: { 'GPV4.2': allYes({ 15: 'no' }), 'GPV3.1': allYes({ 15: 'no' }) } }, update: '11:00' });
  const reloaded = createStore(ctx.path);
  assert.equal(reloaded.getUser(CHAT).addresses.length, 2);
  await ctx.make(reloaded).pollSite();
  assert.equal(ctx.sent.length, 1);
  assert.match(ctx.last().text, /Графік змінився<\/b>\n\n📍 Черга 4\.2[\s\S]*14:00–15:00/);
});

test('a withdrawn schedule says so, one withdrawn day shows what is left', async () => {
  const fact = { data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }) }, [TOMORROW]: { 'GPV4.2': allYes({ 5: 'no' }) } }, update: 'u' };
  const { app, source, last } = await registered({ fact });
  source.publish({ data: { [TODAY]: { 'GPV4.2': allYes({ 12: 'no' }) } }, update: 'u2' });
  await app.pollSite();
  assert.match(last().text, /Графік змінився<\/b>\n\n<b>Сьогодні, пт 06\.11<\/b>[\s\S]*11:00–12:00/);
  source.publish({ data: {}, update: 'u3' });
  await app.pollSite();
  assert.match(last().text, /Графік змінився<\/b>\n\nГрафіка поки немає\./);
  assert.equal(last().photo, undefined);
});

test('the schedule goes out as a picture with the text as its caption', async () => {
  const { say, last, images } = await registered();
  await say('/schedule');
  assert.equal(last().photo.toString(), 'png');
  assert.ok(last().extra.reply_markup.keyboard, 'the menu stays');
  const [schedule] = images.drawn;
  assert.equal(schedule.queues, 'черга 4.2');
  assert.deepEqual(schedule.days.map((day) => day.title), ['Сьогодні, пт 06.11']);
  assert.equal(schedule.days[0].lines[0].row[12], 'no');
  assert.equal(schedule.days[0].nowMinutes, 9 * 60);
});

test('if the picture cannot be drawn, the schedule still arrives as text', async () => {
  const { say, last, images } = await registered();
  images.failing = true;
  await say('/schedule');
  assert.equal(last().photo, undefined);
  assert.match(last().text, /11:00–12:00/);
});

test('text too long for a caption follows the picture as its own message', async () => {
  const busy = {};
  for (let hour = 1; hour <= 24; hour++) busy[hour] = hour % 2 ? 'first' : 'second';
  const fact = { data: { [TODAY]: { 'GPV4.2': busy, 'GPV3.1': { ...busy, 1: 'no' } }, [TOMORROW]: { 'GPV4.2': busy, 'GPV3.1': { ...busy, 2: 'no' } } }, update: 'u' };
  const ctx = await registered({ fact });
  ctx.addresses().splice(0, 1);
  addOldStreetAddress(ctx);
  await ctx.say('/schedule');
  assert.equal(ctx.sent.length, 2);
  assert.equal(ctx.sent[0].photo.toString(), 'png');
  assert.equal(ctx.sent[0].text, '');
  assert.ok(ctx.sent[1].text.length > 1024);
});

test('passed intervals are struck through, the current one and the next one are marked', async () => {
  const fact = { data: { [TODAY]: { 'GPV4.2': allYes({ 1: 'no', 12: 'no', 16: 'no', 20: 'no' }) } }, update: 'u' };
  const { say, last, clock } = await registered({ fact });
  clock.now = at(11, 20);
  await say('/schedule');
  assert.equal(last().text, [
    '<b>Сьогодні, пт 06.11</b>',
    '🌑 Без світла 4 год:',
    '<s>00:00–01:00 · 1 год</s>',
    '🔴 <b>11:00–12:00</b> · 1 год · зараз',
    '👉 <b>15:00–16:00</b> · 1 год',
    '<b>19:00–20:00</b> · 1 год',
    '💡 Світло 20 год',
  ].join('\n'));
});

test('with today done, the pointer goes to tomorrow', async () => {
  const fact = { data: { [TODAY]: { 'GPV4.2': allYes({ 1: 'no' }) }, [TOMORROW]: { 'GPV4.2': allYes({ 1: 'no', 3: 'no' }) } }, update: 'u' };
  const { say, last } = await registered({ fact });
  await say('/schedule');
  assert.match(last().text, /<s>00:00–01:00 · 1 год<\/s>[\s\S]*Завтра[\s\S]*👉 <b>00:00–01:00<\/b> · 1 год\n<b>02:00–03:00<\/b> · 1 год/);
});

test('moved from 18:00 to 17:30 and it is 17:20: a warning with the time left', async () => {
  const { app, clock, source, sent } = await registered({ fact: planned(allYes({ 19: 'no' })) });
  clock.now = at(17, 20);
  moved(source, allYes({ 18: 'second', 19: 'no' }));
  await app.pollSite();
  assert.equal(sent[0].text, '⚠️ Черга 4.2\nГрафік змінили! Через 10 хв відключення світла: з 17:30 до 19:00.');
  assert.match(sent[1].text, /Графік змінився/);
  clock.now = at(17, 21);
  await app.checkWarnings();
  assert.equal(sent.length, 2);
});

test('moved from 18:00 to 17:30 and it is already 17:33: it says the outage is on, once', async () => {
  const { app, clock, source, sent } = await registered({ fact: planned(allYes({ 19: 'no' })) });
  clock.now = at(17, 33);
  moved(source, allYes({ 18: 'second', 19: 'no' }));
  await app.pollSite();
  assert.equal(sent[0].text, '🔴 Черга 4.2\nГрафік змінили: відключення вже йде, з 17:30 до 19:00.');
  await app.pollSite();
  await app.checkWarnings();
  assert.equal(sent.length, 2);
});

test('changes that are not sudden give no alarm', async () => {
  const cases = [
    ['nothing soon', at(10), allYes({ 18: 'second', 19: 'no' })],
    ['pushed later', at(17, 50), allYes({ 20: 'no' })],
    ['made longer while it runs', at(18, 30), allYes({ 19: 'no', 20: 'no' })],
  ];
  for (const [name, time, row] of cases) {
    const { app, clock, source, sent } = await registered({ fact: planned(allYes({ 19: 'no' })) });
    clock.now = time;
    moved(source, row);
    await app.pollSite();
    assert.equal(sent.length, 1, name);
    assert.match(sent[0].text, /Графік змінився/, name);
  }
});

test('if only the picture fails, the sudden alert is not repeated when it is retried', async () => {
  const { app, clock, source, sent, telegram } = await registered({ fact: planned(allYes({ 19: 'no' })) });
  clock.now = at(17, 30);
  moved(source, allYes({ 18: 'second', 19: 'no' }));
  const original = telegram.sendPhoto;
  telegram.sendPhoto = async () => { throw new Error('telegram hiccup'); };
  await app.pollSite();
  telegram.sendPhoto = original;
  await app.pollSite();
  assert.equal(sent.filter((message) => /вже йде/.test(message.text)).length, 1);
  assert.equal(sent.filter((message) => /Графік змінився/.test(message.text)).length, 1);
});

test('a long source failure is reported once, and so is the recovery', async () => {
  const { app, source, clock, sent, last, say } = await registered();
  source.failing = true;
  await app.pollSite();
  clock.now += 29 * 60000;
  await app.pollSite();
  assert.equal(sent.length, 0, 'a short failure stays quiet');
  clock.now += 60000;
  await app.pollSite();
  await app.pollSite();
  assert.equal(sent.length, 1);
  assert.match(last().text, /Уже 30 хвилин не можу отримати свіжий графік/);
  await say('/schedule');
  assert.match(last().text, /Графіки зараз не оновлюються, це останній отриманий графік/);
  source.failing = false;
  await app.pollSite();
  assert.match(last().text, /Графіки знову оновлюються/);
});

test('warnings keep working from the last known schedule while the source is down', async () => {
  const { app, source, clock, last } = await registered();
  source.failing = true;
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
