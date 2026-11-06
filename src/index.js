import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from './app.js';
import { createDtekClient } from './dtek.js';
import { createPowerMonitor } from './power.js';
import { createStore } from './store.js';
import { createTelegram } from './telegram.js';
import { createXiaomiClient, loadSession } from './xiaomi.js';

const WARNING_CHECK_MS = 20000;
const ADDRESS_REFRESH_MS = 6 * 60 * 60000;

const {
  BOT_TOKEN, ACCESS_CODE, POLL_SECONDS = '120', WARN_MINUTES = '15', DATA_FILE = 'data/state.json',
  TELEGRAM_API_URL, DTEK_BASE_URL,
  POWER_SENSOR_MODEL, POWER_REFERENCE_MODELS = '', POWER_POLL_SECONDS = '30', POWER_OFF_MINUTES = '0', POWER_ON_MINUTES = '0',
} = process.env;

if (!BOT_TOKEN) {
  console.error('Не задан BOT_TOKEN: впишите токен от @BotFather в файл .env');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,64}$/.test(ACCESS_CODE ?? '')) {
  console.error('ACCESS_CODE должен быть задан: до 64 символов, латиница, цифры, _ и -');
  process.exit(1);
}

const telegram = createTelegram({ token: BOT_TOKEN, baseUrl: TELEGRAM_API_URL });
const store = createStore(DATA_FILE);
const xiaomiSession = POWER_SENSOR_MODEL ? loadSession() : null;
if (POWER_SENSOR_MODEL && !xiaomiSession) {
  console.error('Датчик света выключен: нет входа в Xiaomi, запустите node tools/xiaomi-watch.js');
}
const power = xiaomiSession && createPowerMonitor({
  xiaomi: createXiaomiClient(xiaomiSession),
  store,
  telegram,
  sensorModel: POWER_SENSOR_MODEL,
  referenceModels: POWER_REFERENCE_MODELS.split(',').map((model) => model.trim()).filter(Boolean),
  offAfterMs: Number(POWER_OFF_MINUTES) * 60000,
  onAfterMs: Number(POWER_ON_MINUTES) * 60000,
});
const app = createApp({
  telegram,
  site: createDtekClient({ baseUrl: DTEK_BASE_URL }),
  store,
  accessCode: ACCESS_CODE,
  power,
  warnMinutes: Number(WARN_MINUTES),
});

function repeat(name, intervalMs, task) {
  (async () => {
    for (;;) {
      try {
        await task();
      } catch (error) {
        console.error(`${name}: ${error.message}`);
      }
      await sleep(intervalMs);
    }
  })();
}

async function receiveUpdates() {
  let offset = 0;
  for (;;) {
    let updates;
    try {
      updates = await telegram.getUpdates(offset);
    } catch (error) {
      console.error(`Telegram: ${error.message}`);
      await sleep(5000);
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      try {
        await app.handleUpdate(update);
      } catch (error) {
        console.error(`Сообщение не обработано: ${error.message}`);
      }
    }
  }
}

let me;
try {
  me = await telegram.getMe();
} catch (error) {
  console.error(`Telegram не принял токен: ${error.message}`);
  process.exit(1);
}
await telegram.setMyCommands([
  { command: 'schedule', description: 'Показати графіки за всіма адресами' },
  { command: 'add', description: 'Додати адресу' },
  { command: 'addresses', description: 'Мої адреси: графік і видалення' },
]);

console.log(`Бот @${me.username} запущен. Пригласительная ссылка: https://t.me/${me.username}?start=${ACCESS_CODE}`);

await app.pollSite();
repeat('Проверка сайта', Number(POLL_SECONDS) * 1000, app.pollSite);
repeat('Предупреждения', WARNING_CHECK_MS, app.checkWarnings);
if (power) repeat('Датчик света', Number(POWER_POLL_SECONDS) * 1000, power.poll);
setTimeout(() => repeat('Проверка адресов', ADDRESS_REFRESH_MS, app.refreshAddresses), ADDRESS_REFRESH_MS);
receiveUpdates();
