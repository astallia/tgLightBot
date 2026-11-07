import { renderScheduleImage } from './chart.js';
import {
  clockMinutes, dayKey, diffSnapshots, formatClock, formatDayLabel, formatDuration, outageStarts, scheduleAt, snapshot, summarizeDay,
} from './schedule.js';

const BUTTON_SCHEDULE = '📅 Графік';
const BUTTON_ADD = '➕ Додати чергу';
const BUTTON_LIST = '📍 Мої черги';
// Older chats still show the buttons from when addresses were entered; they keep working.
const OLD_BUTTON_ADD = '➕ Додати адресу';
const OLD_BUTTON_LIST = '📍 Мої адреси';
const MENU = {
  reply_markup: {
    keyboard: [[{ text: BUTTON_SCHEDULE }], [{ text: BUTTON_ADD }, { text: BUTTON_LIST }]],
    resize_keyboard: true,
  },
};
const QUEUES = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'].map((queue) => `GPV${queue}`);
const QUEUE_LOOKUP_URL = 'https://www.dtek-krem.com.ua/ua/shutdowns';
const MAX_ADDRESSES = 10;
const MAX_CAPTION_LENGTH = 1024;
const SOURCE_ALERT_AFTER_MS = 30 * 60000;
const DAY_MS = 24 * 60 * 60000;

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const groupLabel = (group) => group.replace('GPV', '');
const queueLabel = (groups) => `${groups.length > 1 ? 'черги' : 'черга'} ${groups.map(groupLabel).join(', ')}`;
const queueTitle = (groups) => `${groups.length > 1 ? 'Черги' : 'Черга'} ${groups.map(groupLabel).join(', ')}`;

// Entries added before queues were chosen directly still carry the street address they were found by.
const hasStreetAddress = (address) => Boolean(address.city);
const streetAddress = ({ city, street, house }) => [city, street, house === '-' ? '' : house].filter(Boolean).join(', ');
const placeOf = (address) => (hasStreetAddress(address) ? streetAddress(address) : queueTitle(address.groups));
const describe = (address) => (hasStreetAddress(address)
  ? `${streetAddress(address)} · ${queueLabel(address.groups)}`
  : queueTitle(address.groups));

function queueFromText(text) {
  const match = text.trim().match(/^(?:черга\s*)?([1-6])\s*[.,]\s*([12])$/i);
  return match ? `GPV${match[1]}.${match[2]}` : null;
}

export function createApp({
  telegram, source, store, accessCode, power, renderImage = renderScheduleImage, warnMinutes = 15, now = Date.now, log = console.error,
}) {
  const choosing = new Set();
  let sourceDownSince = null;
  let sourceAlertSent = false;

  const send = (chatId, text, extra = MENU) => telegram.sendMessage(chatId, text, extra);
  const snapshotsOf = (groups) => Object.fromEntries(groups.map((group) => [group, snapshot(store.fact, group)]));

  async function broadcast(text) {
    for (const [chatId] of store.users()) {
      await send(chatId, text).catch((error) => log(`Не отправлено ${chatId}: ${error.message}`));
    }
  }

  // The published rows of a day, one per line of the house. Lines on the same schedule share a row.
  function linesOfDay(address, key) {
    const lines = [];
    for (const group of address.groups) {
      const row = store.fact?.data?.[key]?.[group];
      if (!row) continue;
      const fingerprint = JSON.stringify(row);
      const same = lines.find((line) => line.fingerprint === fingerprint);
      if (same) same.groups.push(group);
      else lines.push({ groups: [group], row, fingerprint });
    }
    return lines;
  }

  // Telegram has no text colours, so state is shown by marks: what has passed is struck through,
  // what is still to come is bold, and what is happening now or comes next gets a mark in front.
  function renderInterval(item, key, nextStart) {
    const range = `${item.from}–${item.to}`;
    const duration = formatDuration(clockMinutes(item.to) - clockMinutes(item.from));
    if (key === dayKey(now())) {
      const current = clockMinutes(formatClock(now()));
      if (clockMinutes(item.to) <= current) return `<s>${range} · ${duration}</s>`;
      if (clockMinutes(item.from) <= current) return `🔴 <b>${range}</b> · ${duration} · зараз`;
    }
    const isNext = nextStart !== undefined && dayKey(nextStart) === key && formatClock(nextStart) === item.from;
    return `${isNext ? '👉 ' : ''}<b>${range}</b> · ${duration}`;
  }

  function renderDay(title, address, key) {
    const lines = [`<b>${title}</b>`];
    for (const { groups, row } of linesOfDay(address, key)) {
      const { totals, intervals } = summarizeDay(row);
      const nextStart = outageStarts(store.fact, groups[0]).find((start) => start.at > now())?.at;
      const list = (items) => items.map((item) => renderInterval(item, key, nextStart)).join('\n');
      if (address.groups.length > 1) lines.push(queueTitle(groups));
      if (intervals.off.length) lines.push(`🌑 Без світла ${formatDuration(totals.off)}:\n${list(intervals.off)}`);
      if (intervals.maybe.length) lines.push(`❔ Можливо без світла ${formatDuration(totals.maybe)}:\n${list(intervals.maybe)}`);
      lines.push(`💡 Світло ${formatDuration(totals.on)}`);
    }
    return lines.join('\n');
  }

  function dayTitle(key) {
    const label = formatDayLabel(key);
    if (key === dayKey(now())) return `Сьогодні, ${label}`;
    if (key === dayKey(now(), 1)) return `Завтра, ${label}`;
    return label;
  }

  function renderSchedule(address, heading, days, showPlace) {
    const parts = [
      heading,
      showPlace ? `📍 ${escapeHtml(describe(address))}` : null,
      ...(days.length ? days.map((key) => renderDay(dayTitle(key), address, key)) : ['Графіка поки немає.']),
      sourceDownSince ? '⚠️ Графіки зараз не оновлюються, це останній отриманий графік.' : null,
    ];
    return parts.filter(Boolean).join('\n\n');
  }

  function lineButtons(addressId, lines) {
    const choices = lines.map((group, index) => [{ text: `Черга ${groupLabel(group)}`, callback_data: `line:${addressId}:${index}` }]);
    choices.push([{ text: 'Не знаю, стежити за всіма', callback_data: `line:${addressId}:all` }]);
    return { reply_markup: { inline_keyboard: choices } };
  }

  // A drawing problem must not cost anyone their schedule, so the plain text is the fallback.
  function drawSchedule(address, days, showPlace) {
    const today = dayKey(now());
    const [hours, minutes] = formatClock(now()).split(':').map(Number);
    try {
      return renderImage({
        address: showPlace && hasStreetAddress(address) ? streetAddress(address) : undefined,
        queues: queueLabel(address.groups),
        days: days.map((key) => ({
          title: dayTitle(key),
          lines: linesOfDay(address, key).map(({ groups, row }) => ({
            label: address.groups.length > 1 || (showPlace && !hasStreetAddress(address)) ? queueTitle(groups) : undefined,
            row,
          })),
          nowMinutes: key === today ? hours * 60 + minutes : undefined,
        })),
      });
    } catch (error) {
      log(`Картинка не нарисована: ${error.message}`);
      return null;
    }
  }

  // Days with nothing published are left out. If that empties a change notice (one day was
  // withdrawn), the days still published are shown. With no days at all there is nothing to draw.
  async function sendSchedule(chatId, address, heading, requestedDays) {
    const published = (keys) => keys.filter((key) => linesOfDay(address, key).length);
    const defaultDays = [dayKey(now()), dayKey(now(), 1)];
    const requested = published(requestedDays ?? defaultDays);
    const days = requested.length ? requested : published(defaultDays);
    // With one entry everyone knows which one it is, so the message stays down to the schedule.
    const showPlace = store.getUser(chatId).addresses.length > 1;
    const text = renderSchedule(address, heading, days, showPlace);
    const image = days.length ? drawSchedule(address, days, showPlace) : null;
    if (!image) {
      await send(chatId, text);
    } else if (text.length <= MAX_CAPTION_LENGTH) {
      await telegram.sendPhoto(chatId, image, text, MENU);
    } else {
      await telegram.sendPhoto(chatId, image, '', MENU);
      await send(chatId, text);
    }
  }

  function queueButtons() {
    const rows = [];
    for (let index = 0; index < QUEUES.length; index += 2) {
      rows.push(QUEUES.slice(index, index + 2).map((group) => ({ text: `Черга ${groupLabel(group)}`, callback_data: `queue:${group}` })));
    }
    return { reply_markup: { inline_keyboard: rows } };
  }

  async function startChoosing(chatId) {
    if (store.getUser(chatId).addresses.length >= MAX_ADDRESSES) {
      await send(chatId, `Можна відстежувати до ${MAX_ADDRESSES} черг. Щоб додати нову, видаліть зайву в розділі «${BUTTON_LIST}».`);
      return;
    }
    choosing.add(chatId);
    await send(
      chatId,
      `Оберіть свою чергу. Її можна дізнатися на <a href="${QUEUE_LOOKUP_URL}">сайті ДТЕК</a>: введіть адресу, і під нею з'явиться, наприклад, «Черга 2.2».\nМожна також написати номер черги, наприклад <b>2.2</b>.`,
      queueButtons(),
    );
  }

  async function saveQueue(chatId, group) {
    const user = store.getUser(chatId);
    choosing.delete(chatId);
    if (user.addresses.some((address) => address.groups.join() === group)) {
      await send(chatId, `${queueTitle([group])} вже відстежується.`);
      return;
    }
    if (user.addresses.length >= MAX_ADDRESSES) {
      await send(chatId, `Можна відстежувати до ${MAX_ADDRESSES} черг. Щоб додати нову, видаліть зайву в розділі «${BUTTON_LIST}».`);
      return;
    }
    const address = {
      id: user.nextAddressId++,
      groups: [group],
      allLines: false,
      lines: [group],
      seen: snapshotsOf([group]),
      warned: {},
    };
    user.addresses.push(address);
    store.save();
    const heading = `✅ <b>Додано: ${queueLabel([group])}</b>\nПовідомлятиму про зміни графіка та попереджатиму за ${warnMinutes} хв до відключення.`;
    await sendSchedule(chatId, address, heading);
  }

  async function showAddresses(chatId, user, prefix = '') {
    if (!user.addresses.length) {
      await send(chatId, `${prefix}Поки нічого не відстежується. Щоб почати, натисніть «${BUTTON_ADD}».`);
      return;
    }
    const lines = user.addresses.map((address, index) => `${index + 1}. ${escapeHtml(describe(address))}`);
    const keyboard = user.addresses.flatMap((address, index) => [
      [
        { text: `📅 Графік ${index + 1}`, callback_data: `show:${address.id}` },
        { text: `🗑 Видалити ${index + 1}`, callback_data: `del:${address.id}` },
      ],
      ...(address.lines.length > 1 ? [[{ text: `🔀 Змінити чергу ${index + 1}`, callback_data: `choose:${address.id}` }]] : []),
    ]);
    const text = `${prefix}<b>Що відстежується</b>\n${lines.join('\n')}\n\nЗа кожним приходять зміни графіка та попередження за ${warnMinutes} хв до відключення.`;
    await send(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }

  async function handleMessage(message) {
    if (message.chat.type !== 'private' || !message.text) return;
    const chatId = message.chat.id;
    const text = message.text.trim();
    const [command, argument] = text.split(/\s+/);

    if (!store.getUser(chatId)) {
      if (command !== '/start' || argument !== accessCode) {
        await telegram.sendMessage(chatId, 'Це особистий бот, доступ лише за запрошенням.');
        return;
      }
      store.addUser(chatId);
      store.save();
      await send(chatId, 'Я надсилаю графік відключень світла ДТЕК для вашої черги, рахую години зі світлом і без нього, повідомляю про зміни та попереджаю перед відключенням. Черг може бути кілька.');
      await startChoosing(chatId);
      return;
    }

    const user = store.getUser(chatId);
    if (command === '/add' || text === BUTTON_ADD || text === OLD_BUTTON_ADD) {
      await startChoosing(chatId);
      return;
    }
    if (command === '/addresses' || text === BUTTON_LIST || text === OLD_BUTTON_LIST) {
      choosing.delete(chatId);
      await showAddresses(chatId, user);
      return;
    }
    if (command === '/power') {
      choosing.delete(chatId);
      await send(chatId, power ? power.toggle(user) : 'Датчик світла не налаштований.');
      return;
    }
    if (command === '/schedule' || command === '/start' || text === BUTTON_SCHEDULE) {
      choosing.delete(chatId);
      if (!user.addresses.length) {
        await startChoosing(chatId);
        return;
      }
      for (const address of user.addresses) await sendSchedule(chatId, address);
      return;
    }
    if (choosing.has(chatId)) {
      const group = queueFromText(text);
      if (group) await saveQueue(chatId, group);
      else await send(chatId, 'Такої черги немає. Оберіть кнопкою вище або напишіть номер, наприклад <b>2.2</b>.');
      return;
    }
    await send(chatId, `Оберіть дію кнопкою внизу: «${BUTTON_SCHEDULE}», «${BUTTON_ADD}» або «${BUTTON_LIST}».`);
  }

  async function chooseLine(chatId, address, choice) {
    const groups = choice === 'all' ? address.lines : [address.lines[Number(choice)]];
    if (groups[0] === undefined) {
      await send(chatId, `Цей список застарів. Щоб змінити чергу, відкрийте «${BUTTON_LIST}».`);
      return;
    }
    address.groups = groups;
    address.allLines = groups.length > 1;
    address.seen = snapshotsOf(groups);
    store.save();
    await sendSchedule(chatId, address, `✅ <b>Збережено: ${queueLabel(groups)}</b>`);
  }

  async function handleAddressButton(chatId, action, id, choice) {
    const user = store.getUser(chatId);
    const address = user.addresses.find((item) => item.id === Number(id));
    if (!address) {
      await send(chatId, 'Цього вже немає в списку.');
      return;
    }
    if (action === 'show') {
      await sendSchedule(chatId, address);
      return;
    }
    if (action === 'choose') {
      await send(chatId, `Оберіть чергу для адреси ${escapeHtml(placeOf(address))}:`, lineButtons(address.id, address.lines));
      return;
    }
    if (action === 'line') {
      await chooseLine(chatId, address, choice);
      return;
    }
    user.addresses = user.addresses.filter((item) => item !== address);
    store.save();
    await showAddresses(chatId, user, `🗑 Видалено: ${escapeHtml(placeOf(address))}.\n\n`);
  }

  async function handleCallback(query) {
    // Telegram refuses to acknowledge old buttons, and that must not cancel the action itself.
    await telegram.answerCallbackQuery(query.id).catch((error) => log(error.message));
    const chatId = query.message?.chat?.id;
    if (!chatId || !store.getUser(chatId)) return;
    const [action, value, choice] = String(query.data).split(':');
    if (['show', 'del', 'choose', 'line'].includes(action)) {
      await handleAddressButton(chatId, action, value, choice);
      return;
    }
    if (action === 'queue' && QUEUES.includes(value)) {
      await saveQueue(chatId, value);
      return;
    }
    // Buttons from the old address search, or anything else that no longer means something.
    await send(chatId, `Цей список застарів. Щоб додати чергу, натисніть «${BUTTON_ADD}».`);
  }

  // A line the address did not follow before counts as a change, not as a newly published day.
  function diffAddress(address) {
    const result = { changed: false, added: false, days: new Set() };
    for (const group of address.groups) {
      const seen = address.seen[group];
      const diff = diffSnapshots(seen ?? {}, snapshot(store.fact, group), now());
      if (diff.changed || (!seen && diff.added)) result.changed = true;
      else if (diff.added) result.added = true;
      for (const day of diff.days) result.days.add(day);
    }
    return { ...result, days: [...result.days].sort((a, b) => Number(a) - Number(b)) };
  }

  const outageRange = (start) => (start.openEnded
    ? `з ${formatClock(start.at)} щонайменше до ${formatClock(start.until)}`
    : `з ${formatClock(start.at)} до ${formatClock(start.until)}`);

  // Where a warning is about: the entry, plus the line when an address follows several.
  const warningPlace = (address, groups) => `${escapeHtml(placeOf(address))}${address.groups.length > 1 ? `, ${queueLabel(groups)}` : ''}`;

  // What the address knew about one line before this change, in the shape the schedule helpers read.
  function factBeforeChange(address, group) {
    const days = Object.entries(address.seen[group] ?? {})
      .map(([key, row]) => [key, { [group]: JSON.parse(row) }]);
    return { data: Object.fromEntries(days) };
  }

  // A change can leave no time for the usual warning: an outage may now be minutes away or already
  // running. That gets said right away, and only about what the schedule did not hold before.
  async function warnAboutSuddenOutages(chatId, address) {
    for (const group of address.groups) {
      const before = factBeforeChange(address, group);
      const knownStarts = new Set(outageStarts(before, group).map((start) => start.at));
      const wasOff = scheduleAt(before, group, now())?.state === 'off';
      const place = warningPlace(address, [group]);

      const starts = outageStarts(store.fact, group);
      const running = scheduleAt(store.fact, group, now())?.state === 'off'
        ? starts.filter((start) => start.at <= now()).at(-1)
        : undefined;
      if (running && !wasOff && !address.warned[`${group}:${running.at}`]) {
        await send(chatId, `🔴 ${place}\nГрафік змінили: відключення вже йде, ${outageRange(running)}.`);
        address.warned[`${group}:${running.at}`] = true;
      }

      for (const start of starts) {
        const left = start.at - now();
        const key = `${group}:${start.at}`;
        if (left <= 0 || left > warnMinutes * 60000 || knownStarts.has(start.at) || address.warned[key]) continue;
        const what = start.certain ? 'відключення світла' : 'можливе відключення світла';
        await send(chatId, `⚠️ ${place}\nГрафік змінили! Через ${Math.ceil(left / 60000)} хв ${what}: ${outageRange(start)}.`);
        address.warned[key] = true;
      }
    }
  }

  async function notifyChanges() {
    for (const [chatId, user] of store.users()) {
      for (const address of user.addresses) {
        const { changed, added, days } = diffAddress(address);
        if (changed || added) {
          const heading = changed ? '🔄 <b>Графік змінився</b>' : '🆕 <b>Опубліковано новий графік</b>';
          try {
            await warnAboutSuddenOutages(chatId, address);
            await sendSchedule(chatId, address, heading, days);
          } catch (error) {
            log(`Не отправлено ${chatId}: ${error.message}`);
            continue;
          }
        }
        address.seen = snapshotsOf(address.groups);
      }
    }
    store.save();
  }

  async function markSourceDown(error) {
    log(`Графики недоступны: ${error.message}`);
    sourceDownSince ??= now();
    if (!sourceAlertSent && now() - sourceDownSince >= SOURCE_ALERT_AFTER_MS) {
      sourceAlertSent = true;
      await broadcast('⚠️ Уже 30 хвилин не можу отримати свіжий графік. Зміни можуть надходити із запізненням, а попередження йдуть за останнім отриманим графіком.');
    }
  }

  async function markSourceUp() {
    if (sourceAlertSent) await broadcast('✅ Графіки знову оновлюються.');
    sourceDownSince = null;
    sourceAlertSent = false;
  }

  // Lines whose outage is the very same one share a single warning.
  function dueWarnings(address) {
    const due = new Map();
    for (const group of address.groups) {
      for (const start of outageStarts(store.fact, group)) {
        const left = start.at - now();
        const key = `${group}:${start.at}`;
        if (left <= 0 || left > warnMinutes * 60000 || address.warned[key]) continue;
        const same = `${start.at}:${start.until}:${start.certain}:${start.openEnded}`;
        if (!due.has(same)) due.set(same, { start, left, groups: [], keys: [] });
        due.get(same).groups.push(group);
        due.get(same).keys.push(key);
      }
    }
    return [...due.values()];
  }

  async function warnAddress(chatId, address) {
    let dirty = false;
    for (const { start, left, groups, keys } of dueWarnings(address)) {
      const what = start.certain ? 'відключення світла' : 'можливе відключення світла';
      const until = start.openEnded
        ? `щонайменше до ${formatClock(start.until)}`
        : `до ${formatClock(start.until)}`;
      const text = `⚠️ ${warningPlace(address, groups)}\nЧерез ${Math.ceil(left / 60000)} хв ${what}: з ${formatClock(start.at)} ${until}.`;
      try {
        await send(chatId, text);
        for (const key of keys) address.warned[key] = true;
        dirty = true;
      } catch (error) {
        log(`Не отправлено ${chatId}: ${error.message}`);
      }
    }
    for (const key of Object.keys(address.warned)) {
      if (Number(key.split(':').pop()) < now() - DAY_MS) {
        delete address.warned[key];
        dirty = true;
      }
    }
    return dirty;
  }

  return {
    handleUpdate: async (update) => {
      if (update.callback_query) await handleCallback(update.callback_query);
      else if (update.message) await handleMessage(update.message);
    },

    // Reads the source and takes its schedule only if it is newer than the one already held:
    // the source is read through a cache, and an older copy can come back after a newer one.
    pollSite: async () => {
      try {
        const latest = await source.fetchSchedule(now());
        if (!store.fact || !store.sourceUpdatedAt || latest.updatedAt > store.sourceUpdatedAt) {
          store.fact = latest.fact;
          store.sourceUpdatedAt = latest.updatedAt;
        }
      } catch (error) {
        await markSourceDown(error);
        return;
      }
      store.save();
      await markSourceUp();
      await notifyChanges();
    },

    checkWarnings: async () => {
      let dirty = false;
      for (const [chatId, user] of store.users()) {
        for (const address of user.addresses) {
          if (await warnAddress(chatId, address)) dirty = true;
        }
      }
      if (dirty) store.save();
    },
  };
}
