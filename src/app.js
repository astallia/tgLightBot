import { renderScheduleImage } from './chart.js';
import {
  clockMinutes, dayKey, diffSnapshots, formatClock, formatDayLabel, formatDuration, outageStarts, scheduleAt, snapshot, summarizeDay,
} from './schedule.js';

const BUTTON_SCHEDULE = '📅 Графік';
const BUTTON_ADD = '➕ Додати адресу';
const BUTTON_LIST = '📍 Мої адреси';
const MENU = {
  reply_markup: {
    keyboard: [[{ text: BUTTON_SCHEDULE }], [{ text: BUTTON_ADD }, { text: BUTTON_LIST }]],
    resize_keyboard: true,
  },
};
const MAX_OPTIONS = 10;
const MAX_ADDRESSES = 10;
const MAX_CAPTION_LENGTH = 1024;
const ALL_LINES = '*';
const FULL_RELOAD_MS = 30 * 60000;
const SITE_ALERT_AFTER_MS = 30 * 60000;
const DAY_MS = 24 * 60 * 60000;
const EMERGENCY_PREFIX = 'Екстренні відключення';

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const groupLabel = (group) => group.replace('GPV', '');
const queueLabel = (groups) => `${groups.length > 1 ? 'черги' : 'черга'} ${groups.map(groupLabel).join(', ')}`;
const queueTitle = (groups) => `${groups.length > 1 ? 'Черги' : 'Черга'} ${groups.map(groupLabel).join(', ')}`;
const addressLabel = ({ city, street, house }) => [city, street, house === '-' ? '' : house].filter(Boolean).join(', ');

// People type from Russian and Ukrainian keyboards, so letters that differ between them are folded together.
function fold(text) {
  return text.toLowerCase()
    .replace(/[іїиый]/g, 'и')
    .replace(/[еєэё]/g, 'е')
    .replace(/ґ/g, 'г')
    .replace(/['’ʼ`".,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findMatches(names, query) {
  const wanted = fold(query);
  if (!wanted) return [];
  const folded = names.map((name) => [name, fold(name)]);
  const pick = (test) => folded.filter(([, value]) => test(value)).map(([name]) => name);
  const exact = pick((value) => value === wanted);
  if (exact.length) return exact;
  const withoutPrefix = pick((value) => value.endsWith(` ${wanted}`));
  if (withoutPrefix.length) return withoutPrefix;
  return pick((value) => value.includes(wanted));
}

const houseKey = (text) => fold(text).replace(/\s/g, '');

export function createApp({
  telegram, site, store, accessCode, power, renderImage = renderScheduleImage, warnMinutes = 15, now = Date.now, log = console.error,
}) {
  const dialogs = new Map();
  let streets = null;
  let lastFullLoad = 0;
  let siteDownSince = null;
  let siteAlertSent = false;

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

  // Same conditions as the site: it only shows this block for types 1 and 2.
  function renderCurrentOutage(info) {
    if (!info || !['1', '2'].includes(info.type)) return null;
    const reason = info.type === '1' ? 'планові ремонтні роботи' : info.sub_type;
    const lines = [
      '⚠️ <b>Зараз за адресою немає світла</b>',
      `Причина: ${escapeHtml(reason)}`,
      `Початок: ${escapeHtml(info.start_date)}`,
      `Орієнтовно до: ${escapeHtml(info.end_date)}`,
    ];
    if (info.sub_type?.startsWith(EMERGENCY_PREFIX)) {
      lines.push('Графіки зараз не діють: час увімкнення може змінюватися за командою Укренерго.');
    }
    return lines.join('\n');
  }

  function renderSchedule(address, info, heading, days, showAddress) {
    const parts = [
      heading,
      showAddress ? `📍 ${escapeHtml(addressLabel(address))} · ${queueLabel(address.groups)}` : null,
      renderCurrentOutage(info),
      ...(days.length ? days.map((key) => renderDay(dayTitle(key), address, key)) : ['Графіка поки немає.']),
      siteDownSince ? '⚠️ Сайт зараз не відповідає, це останній отриманий графік.' : null,
    ];
    return parts.filter(Boolean).join('\n\n');
  }

  function lineButtons(addressId, lines) {
    const choices = lines.map((group, index) => [{ text: `Черга ${groupLabel(group)}`, callback_data: `line:${addressId}:${index}` }]);
    choices.push([{ text: 'Не знаю, стежити за всіма', callback_data: `line:${addressId}:all` }]);
    return { reply_markup: { inline_keyboard: choices } };
  }

  // Refreshes the address on the site: its queue can be reassigned. A failed lookup keeps the stored queue.
  async function syncAddress(chatId, address) {
    let info;
    try {
      const houses = await site.lookupHouses(address.city, address.street);
      info = houses[address.house];
    } catch (error) {
      log(`Адрес не проверен: ${error.message}`);
      return null;
    }
    const onSite = info?.sub_type_reason ?? [];
    if (!onSite.length || onSite.join() === address.lines.join()) return info ?? null;

    // Someone who chose their line keeps it for as long as the site still lists it for the house.
    const keepsChoice = !address.allLines && onSite.includes(address.groups[0]);
    const label = escapeHtml(addressLabel(address));
    const buttons = onSite.length > 1 ? lineButtons(address.id, onSite) : MENU;
    if (!keepsChoice) {
      const was = address.groups.map(groupLabel).join(', ');
      const hint = onSite.length > 1 ? ' Будинок підключений до різних ліній. Якщо знаєте свою, оберіть її:' : '';
      await send(chatId, `Черга за адресою ${label} змінилася: ${was} → ${onSite.map(groupLabel).join(', ')}.${hint}`, buttons);
      address.groups = onSite;
      address.allLines = onSite.length > 1;
    } else if (onSite.length > 1) {
      await send(chatId, `За адресою ${label} тепер ${queueLabel(onSite)}. Ви стежите за чергою ${groupLabel(address.groups[0])}, за потреби оберіть іншу:`, buttons);
    }
    address.lines = onSite;
    store.save();
    return info ?? null;
  }

  // A drawing problem must not cost anyone their schedule, so the plain text is the fallback.
  function drawSchedule(address, days, showAddress) {
    const today = dayKey(now());
    const [hours, minutes] = formatClock(now()).split(':').map(Number);
    try {
      return renderImage({
        address: showAddress ? addressLabel(address) : undefined,
        queues: queueLabel(address.groups),
        days: days.map((key) => ({
          title: dayTitle(key),
          lines: linesOfDay(address, key).map(({ groups, row }) => ({
            label: address.groups.length > 1 ? queueTitle(groups) : undefined,
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
  async function deliverSchedule(chatId, address, info, heading, requestedDays) {
    const published = (keys) => keys.filter((key) => linesOfDay(address, key).length);
    const defaultDays = [dayKey(now()), dayKey(now(), 1)];
    const requested = published(requestedDays ?? defaultDays);
    const days = requested.length ? requested : published(defaultDays);
    // With one address everyone knows which one it is, so the message stays down to the schedule.
    const showAddress = store.getUser(chatId).addresses.length > 1;
    const text = renderSchedule(address, info, heading, days, showAddress);
    const image = days.length ? drawSchedule(address, days, showAddress) : null;
    if (!image) {
      await send(chatId, text);
    } else if (text.length <= MAX_CAPTION_LENGTH) {
      await telegram.sendPhoto(chatId, image, text, MENU);
    } else {
      await telegram.sendPhoto(chatId, image, '', MENU);
      await send(chatId, text);
    }
  }

  async function sendSchedule(chatId, address, heading, days) {
    const info = await syncAddress(chatId, address);
    await deliverSchedule(chatId, address, info, heading, days);
  }

  async function ensureStreets() {
    if (!streets) {
      const page = await site.loadPage();
      streets = page.streets;
      lastFullLoad = now();
      store.fact ??= page.fact;
    }
    return streets;
  }

  async function offerOptions(chatId, dialog, step, options, question, labelOf = (option) => option) {
    dialog.step = step;
    dialog.options = options.slice(0, MAX_OPTIONS);
    const keyboard = dialog.options.map((option, index) => [{
      text: labelOf(option), callback_data: `${step}:${index}`,
    }]);
    const more = options.length > MAX_OPTIONS
      ? `\nЗнайдено варіантів: ${options.length}, показую перші ${MAX_OPTIONS}. Якщо потрібного немає, напишіть точніше.`
      : '';
    await send(chatId, `${question}${more}`, { reply_markup: { inline_keyboard: keyboard } });
  }

  async function startAddress(chatId) {
    if (store.getUser(chatId).addresses.length >= MAX_ADDRESSES) {
      await send(chatId, `Можна відстежувати до ${MAX_ADDRESSES} адрес. Щоб додати нову, видаліть зайву в розділі «${BUTTON_LIST}».`);
      return;
    }
    try {
      await ensureStreets();
    } catch (error) {
      log(`Список адресов недоступен: ${error.message}`);
      await send(chatId, 'Сайт ДТЕК зараз не відповідає, тому перевірити адресу не вийде. Спробуйте трохи пізніше.');
      return;
    }
    dialogs.set(chatId, { step: 'city' });
    await send(chatId, 'Напишіть населений пункт, як на сайті ДТЕК, наприклад: <b>Білогородка</b>');
  }

  async function saveAddress(chatId, dialog, groups) {
    const user = store.getUser(chatId);
    dialogs.delete(chatId);
    const { city, street, house } = dialog;
    const duplicate = user.addresses.some((address) => address.city === city && address.street === street
      && address.house === house && address.groups.join() === groups.join());
    if (duplicate) {
      await send(chatId, `Ця адреса вже відстежується: ${escapeHtml(addressLabel({ city, street, house }))}.`);
      return;
    }
    const address = {
      id: user.nextAddressId++,
      city,
      street,
      house,
      groups,
      allLines: groups.length > 1,
      lines: dialog.houses[house].sub_type_reason,
      seen: snapshotsOf(groups),
      warned: {},
    };
    user.addresses.push(address);
    store.save();
    const heading = `✅ <b>Адресу додано</b>\nПовідомлятиму про зміни графіка та попереджатиму за ${warnMinutes} хв до відключення.`;
    await deliverSchedule(chatId, address, dialog.houses[house], heading);
  }

  async function chooseHouse(chatId, dialog, house) {
    dialog.house = house;
    const info = dialog.houses[house];
    const groups = info.sub_type_reason ?? [];
    if (info.voluntarily || !groups.length) {
      const reason = info.voluntarily
        ? 'Сайт ДТЕК не публікує графік для цього будинку та радить звернутися до ОСББ, ЖЕК або керуючої компанії.'
        : 'Для цієї адреси на сайті ДТЕК немає графіка.';
      dialogs.delete(chatId);
      await send(chatId, `${reason}\nАдресу не додано.`);
      return;
    }
    if (groups.length === 1) {
      await saveAddress(chatId, dialog, groups);
      return;
    }
    await offerOptions(
      chatId,
      dialog,
      'group',
      [...groups, ALL_LINES],
      'Цей будинок підключений до різних ліній, і ДТЕК не вказує, від якої ваша квартира. Оберіть свою чергу або стежте за всіма:',
      (option) => (option === ALL_LINES ? 'Не знаю, стежити за всіма' : `Черга ${groupLabel(option)}`),
    );
  }

  async function chooseStreet(chatId, dialog, street) {
    dialog.street = street;
    dialog.houses = await site.lookupHouses(dialog.city, street);
    const houses = Object.keys(dialog.houses);
    if (!houses.length) {
      dialogs.delete(chatId);
      await send(chatId, 'Для цієї адреси на сайті ДТЕК немає будинків. Адресу не додано.');
      return;
    }
    if (houses.length === 1 && houses[0] === '-') {
      await chooseHouse(chatId, dialog, '-');
      return;
    }
    dialog.step = 'house';
    dialog.options = null;
    await send(chatId, 'Напишіть номер будинку, наприклад: <b>12</b> або <b>17А</b>');
  }

  async function chooseCity(chatId, dialog, city) {
    dialog.city = city;
    const list = streets[city] ?? [];
    if (list.length === 0 || (list.length === 1 && list[0] === '')) {
      await chooseStreet(chatId, dialog, '');
      return;
    }
    dialog.step = 'street';
    dialog.options = null;
    await send(chatId, 'Напишіть вулицю, наприклад: <b>Садова</b>');
  }

  async function pick(chatId, dialog, step, value) {
    if (step === 'city') await chooseCity(chatId, dialog, value);
    else if (step === 'street') await chooseStreet(chatId, dialog, value);
    else if (step === 'house') await chooseHouse(chatId, dialog, value);
    else await saveAddress(chatId, dialog, value === ALL_LINES ? dialog.houses[dialog.house].sub_type_reason : [value]);
  }

  async function answerDialog(chatId, dialog, text) {
    if (dialog.step === 'group') {
      await send(chatId, 'Оберіть чергу кнопкою вище.');
      return;
    }
    if (dialog.step === 'house') {
      const wanted = houseKey(text);
      const houses = Object.keys(dialog.houses);
      const exact = houses.find((house) => houseKey(house) === wanted);
      if (exact) {
        await chooseHouse(chatId, dialog, exact);
        return;
      }
      const similar = houses.filter((house) => houseKey(house).startsWith(wanted));
      if (similar.length) await offerOptions(chatId, dialog, 'house', similar, 'Точного збігу немає. Оберіть будинок:');
      else await send(chatId, 'Такого будинку на цій вулиці на сайті немає. Перевірте номер і напишіть ще раз.');
      return;
    }
    const names = dialog.step === 'city' ? Object.keys(streets) : streets[dialog.city];
    const matches = findMatches(names, text);
    if (matches.length === 1) {
      await pick(chatId, dialog, dialog.step, matches[0]);
    } else if (matches.length > 1) {
      await offerOptions(chatId, dialog, dialog.step, matches, 'Оберіть варіант:');
    } else {
      await send(chatId, 'Нічого не знайдено. Напишіть українською, як на сайті ДТЕК, або лише частину назви.');
    }
  }

  async function showAddresses(chatId, user, prefix = '') {
    if (!user.addresses.length) {
      await send(chatId, `${prefix}Адрес поки немає. Щоб почати відстеження, натисніть «${BUTTON_ADD}».`);
      return;
    }
    const lines = user.addresses.map((address, index) => (
      `${index + 1}. ${escapeHtml(addressLabel(address))}, ${queueLabel(address.groups)}`
    ));
    const keyboard = user.addresses.flatMap((address, index) => [
      [
        { text: `📅 Графік ${index + 1}`, callback_data: `show:${address.id}` },
        { text: `🗑 Видалити ${index + 1}`, callback_data: `del:${address.id}` },
      ],
      ...(address.lines.length > 1 ? [[{ text: `🔀 Змінити чергу ${index + 1}`, callback_data: `choose:${address.id}` }]] : []),
    ]);
    const text = `${prefix}<b>Адреси, що відстежуються</b>\n${lines.join('\n')}\n\nЗа кожною приходять зміни графіка та попередження за ${warnMinutes} хв до відключення.`;
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
      await send(chatId, 'Я надсилаю графік відключень світла ДТЕК за вашими адресами, рахую години зі світлом і без нього, повідомляю про зміни та попереджаю перед відключенням. Адрес може бути кілька.');
      await startAddress(chatId);
      return;
    }

    const user = store.getUser(chatId);
    if (command === '/add' || text === BUTTON_ADD) {
      await startAddress(chatId);
      return;
    }
    if (command === '/addresses' || text === BUTTON_LIST) {
      dialogs.delete(chatId);
      await showAddresses(chatId, user);
      return;
    }
    if (command === '/power') {
      dialogs.delete(chatId);
      await send(chatId, power ? power.toggle(user) : 'Датчик світла не налаштований.');
      return;
    }
    if (command === '/schedule' || command === '/start' || text === BUTTON_SCHEDULE) {
      dialogs.delete(chatId);
      if (!user.addresses.length) {
        await startAddress(chatId);
        return;
      }
      for (const address of user.addresses) await sendSchedule(chatId, address);
      return;
    }
    const dialog = dialogs.get(chatId);
    if (dialog) {
      await answerDialog(chatId, dialog, text);
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
      await send(chatId, 'Цієї адреси вже немає в списку.');
      return;
    }
    if (action === 'show') {
      await sendSchedule(chatId, address);
      return;
    }
    if (action === 'choose') {
      await send(chatId, `Оберіть чергу для адреси ${escapeHtml(addressLabel(address))}:`, lineButtons(address.id, address.lines));
      return;
    }
    if (action === 'line') {
      await chooseLine(chatId, address, choice);
      return;
    }
    user.addresses = user.addresses.filter((item) => item !== address);
    store.save();
    await showAddresses(chatId, user, `🗑 Адресу видалено: ${escapeHtml(addressLabel(address))}.\n\n`);
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
    const dialog = dialogs.get(chatId);
    const option = dialog?.step === action ? dialog.options?.[Number(value)] : undefined;
    if (option === undefined) {
      await send(chatId, `Цей список застарів. Щоб додати адресу, натисніть «${BUTTON_ADD}».`);
      return;
    }
    await pick(chatId, dialog, action, option);
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
      const lines = address.groups.length > 1 ? `, ${queueLabel([group])}` : '';
      const place = `${escapeHtml(addressLabel(address))}${lines}`;

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
        // Re-read: sendSchedule may have just moved the address to another queue.
        address.seen = snapshotsOf(address.groups);
      }
    }
    store.save();
  }

  async function syncAllAddresses() {
    for (const [chatId, user] of store.users()) {
      for (const address of user.addresses) {
        await syncAddress(chatId, address).catch((error) => log(`Не отправлено ${chatId}: ${error.message}`));
      }
    }
  }

  async function markSiteDown(error) {
    log(`Сайт недоступен: ${error.message}`);
    siteDownSince ??= now();
    if (!siteAlertSent && now() - siteDownSince >= SITE_ALERT_AFTER_MS) {
      siteAlertSent = true;
      await broadcast('⚠️ Уже 30 хвилин не можу отримати графік із сайту ДТЕК. Зміни можуть надходити із запізненням, а попередження йдуть за останнім отриманим графіком.');
    }
  }

  async function markSiteUp() {
    if (siteAlertSent) await broadcast('✅ Сайт ДТЕК знову відповідає, графік оновлюється.');
    siteDownSince = null;
    siteAlertSent = false;
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
      const lines = address.groups.length > 1 ? `, ${queueLabel(groups)}` : '';
      const text = `⚠️ ${escapeHtml(addressLabel(address))}${lines}\nЧерез ${Math.ceil(left / 60000)} хв ${what}: з ${formatClock(start.at)} ${until}.`;
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

    // One cheap check per run. Every 30 minutes the whole page is reloaded as well, so a silent
    // change in how the update check behaves cannot leave the bot on an old schedule forever.
    pollSite: async () => {
      const previousUpdate = store.fact?.update;
      try {
        if (!store.fact || !streets || now() - lastFullLoad >= FULL_RELOAD_MS) {
          const page = await site.loadPage();
          streets = page.streets;
          lastFullLoad = now();
          store.fact = page.fact;
        } else {
          const fresh = await site.checkUpdate(store.fact.update);
          if (fresh) store.fact = fresh;
        }
      } catch (error) {
        await markSiteDown(error);
        return;
      }
      store.save();
      await markSiteUp();
      // The site reassigns queues along with its updates, so check the addresses before the schedule.
      if (previousUpdate !== undefined && store.fact.update !== previousUpdate) await syncAllAddresses();
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

    refreshAddresses: async () => {
      await syncAllAddresses();
      await notifyChanges();
    },
  };
}
