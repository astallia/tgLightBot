import { renderScheduleImage } from './chart.js';
import {
  dayKey, diffSnapshots, formatClock, formatDayLabel, formatDuration, outageStarts, snapshot, summarizeDay,
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
const FULL_RELOAD_MS = 30 * 60000;
const SITE_ALERT_AFTER_MS = 30 * 60000;
const DAY_MS = 24 * 60 * 60000;
const EMERGENCY_PREFIX = 'Екстренні відключення';

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const groupLabel = (group) => group.replace('GPV', '');
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

  async function broadcast(text) {
    for (const [chatId] of store.users()) {
      await send(chatId, text).catch((error) => log(`Не отправлено ${chatId}: ${error.message}`));
    }
  }

  function renderDay(title, row) {
    if (!row) return `<b>${title}:</b> графіка ще немає`;
    const { totals, intervals } = summarizeDay(row);
    const list = (items) => items.map((item) => `${item.from}–${item.to}`).join(', ');
    const lines = [`<b>${title}</b>`];
    if (intervals.off.length) lines.push(`🌑 ${formatDuration(totals.off)}: ${list(intervals.off)}`);
    if (intervals.maybe.length) lines.push(`❔ ${formatDuration(totals.maybe)}: ${list(intervals.maybe)}`);
    lines.push(`💡 ${formatDuration(totals.on)}`);
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

  function renderSchedule(address, info, heading, days = [dayKey(now()), dayKey(now(), 1)]) {
    const parts = [
      heading,
      `📍 ${escapeHtml(addressLabel(address))} · черга ${groupLabel(address.group)}`,
      renderCurrentOutage(info),
      ...days.map((key) => renderDay(dayTitle(key), store.fact?.data?.[key]?.[address.group])),
      `Оновлено на сайті: ${escapeHtml(store.fact?.update || 'немає даних')}`,
      siteDownSince ? '⚠️ Сайт зараз не відповідає, це останній отриманий графік.' : null,
    ];
    return parts.filter(Boolean).join('\n\n');
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
    const groups = info?.sub_type_reason ?? [];
    if (groups.length === 1 && groups[0] !== address.group) {
      await send(chatId, `Черга за адресою ${escapeHtml(addressLabel(address))} змінилася: ${groupLabel(address.group)} → ${groupLabel(groups[0])}.`);
      address.group = groups[0];
      store.save();
    }
    return info ?? null;
  }

  // A drawing problem must not cost anyone their schedule, so the plain text is the fallback.
  function drawSchedule(address, days) {
    const today = dayKey(now());
    const [hours, minutes] = formatClock(now()).split(':').map(Number);
    try {
      return renderImage({
        address: addressLabel(address),
        group: groupLabel(address.group),
        update: store.fact?.update,
        days: days.map((key) => ({
          title: dayTitle(key),
          row: store.fact?.data?.[key]?.[address.group],
          nowMinutes: key === today ? hours * 60 + minutes : undefined,
        })),
      });
    } catch (error) {
      log(`Картинка не нарисована: ${error.message}`);
      return null;
    }
  }

  async function deliverSchedule(chatId, address, info, heading, days = [dayKey(now()), dayKey(now(), 1)]) {
    const text = renderSchedule(address, info, heading, days);
    const image = drawSchedule(address, days);
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

  async function offerOptions(chatId, dialog, step, options, question) {
    dialog.step = step;
    dialog.options = options.slice(0, MAX_OPTIONS);
    const keyboard = dialog.options.map((option, index) => [{
      text: option, callback_data: `${step}:${index}`,
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

  async function saveAddress(chatId, dialog, group) {
    const user = store.getUser(chatId);
    dialogs.delete(chatId);
    const { city, street, house } = dialog;
    const duplicate = user.addresses.some((address) => address.city === city && address.street === street
      && address.house === house && address.group === group);
    if (duplicate) {
      await send(chatId, `Ця адреса вже відстежується: ${escapeHtml(addressLabel({ city, street, house }))}.`);
      return;
    }
    const address = {
      id: user.nextAddressId++, city, street, house, group, seen: snapshot(store.fact, group), warned: {},
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
      await saveAddress(chatId, dialog, groups[0]);
      return;
    }
    await offerOptions(
      chatId,
      dialog,
      'group',
      groups,
      'Цей будинок підключений до різних ліній, і квартири можуть вимикатися за різними чергами. Оберіть свою:',
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
    else await saveAddress(chatId, dialog, value);
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
      `${index + 1}. ${escapeHtml(addressLabel(address))}, черга ${groupLabel(address.group)}`
    ));
    const keyboard = user.addresses.map((address, index) => [
      { text: `📅 Графік ${index + 1}`, callback_data: `show:${address.id}` },
      { text: `🗑 Видалити ${index + 1}`, callback_data: `del:${address.id}` },
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

  async function handleAddressButton(chatId, action, id) {
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
    user.addresses = user.addresses.filter((item) => item !== address);
    store.save();
    await showAddresses(chatId, user, `🗑 Адресу видалено: ${escapeHtml(addressLabel(address))}.\n\n`);
  }

  async function handleCallback(query) {
    // Telegram refuses to acknowledge old buttons, and that must not cancel the action itself.
    await telegram.answerCallbackQuery(query.id).catch((error) => log(error.message));
    const chatId = query.message?.chat?.id;
    if (!chatId || !store.getUser(chatId)) return;
    const [action, value] = String(query.data).split(':');
    if (action === 'show' || action === 'del') {
      await handleAddressButton(chatId, action, value);
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

  async function notifyChanges() {
    for (const [chatId, user] of store.users()) {
      for (const address of user.addresses) {
        const current = snapshot(store.fact, address.group);
        const { changed, added, days } = diffSnapshots(address.seen, current, now());
        if (changed || added) {
          const heading = changed ? '🔄 <b>Графік змінився</b>' : '🆕 <b>Опубліковано новий графік</b>';
          try {
            await sendSchedule(chatId, address, heading, days);
          } catch (error) {
            log(`Не отправлено ${chatId}: ${error.message}`);
            continue;
          }
        }
        // Re-read: sendSchedule may have just moved the address to another queue.
        address.seen = snapshot(store.fact, address.group);
      }
    }
    store.save();
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

  async function warnAddress(chatId, address) {
    let dirty = false;
    for (const start of outageStarts(store.fact, address.group)) {
      const left = start.at - now();
      if (left <= 0 || left > warnMinutes * 60000 || address.warned[start.at]) continue;
      const what = start.certain ? 'відключення світла' : 'можливе відключення світла';
      const until = start.openEnded
        ? `щонайменше до ${formatClock(start.until)}`
        : `до ${formatClock(start.until)}`;
      const text = `⚠️ ${escapeHtml(addressLabel(address))}\nЧерез ${Math.ceil(left / 60000)} хв ${what}: з ${formatClock(start.at)} ${until}.`;
      try {
        await send(chatId, text);
        address.warned[start.at] = true;
        dirty = true;
      } catch (error) {
        log(`Не отправлено ${chatId}: ${error.message}`);
      }
    }
    for (const at of Object.keys(address.warned)) {
      if (Number(at) < now() - DAY_MS) {
        delete address.warned[at];
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
      for (const [chatId, user] of store.users()) {
        for (const address of user.addresses) {
          await syncAddress(chatId, address).catch((error) => log(`Не отправлено ${chatId}: ${error.message}`));
        }
      }
      await notifyChanges();
    },
  };
}
