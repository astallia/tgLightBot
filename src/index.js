import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from './app.js';
import { createDtekClient } from './dtek.js';
import { createPowerMonitor } from './power.js';
import { createNeonStore, createStore } from './store.js';
import { createTelegram } from './telegram.js';
import { createXiaomiClient, loadSession } from './xiaomi.js';

const WARNING_CHECK_MS = 20000;
const ADDRESS_REFRESH_MS = 60 * 60000;
const MAX_BODY_BYTES = 1024 * 1024;

const {
  BOT_TOKEN, ACCESS_CODE, POLL_SECONDS = '120', WARN_MINUTES = '15', DATA_FILE = 'data/state.json', PORT = '10000',
  TELEGRAM_API_URL, DTEK_BASE_URL, DATABASE_URL, PUBLIC_URL, RENDER_EXTERNAL_HOSTNAME, WEBHOOK_SECRET, CRON_SECRET,
  POWER_SENSOR_MODEL, POWER_REFERENCE_MODELS = '', POWER_POLL_SECONDS = '30', POWER_OFF_MINUTES = '0', POWER_ON_MINUTES = '0',
} = process.env;

if (!BOT_TOKEN) throw new Error('Не задан BOT_TOKEN');
if (!/^[A-Za-z0-9_-]{1,64}$/.test(ACCESS_CODE ?? '')) {
  throw new Error('ACCESS_CODE должен быть задан: до 64 символов, латиница, цифры, _ и -');
}

const hosted = Boolean(DATABASE_URL || PUBLIC_URL || RENDER_EXTERNAL_HOSTNAME);
if (hosted && !DATABASE_URL) throw new Error('Для хостинга задайте DATABASE_URL от Neon');
if (hosted && !/^[A-Za-z0-9_-]{16,256}$/.test(WEBHOOK_SECRET ?? '')) {
  throw new Error('WEBHOOK_SECRET должен содержать 16–256 символов: латиница, цифры, _ и -');
}
if (hosted && !CRON_SECRET) throw new Error('Для хостинга задайте CRON_SECRET');

const publicUrl = (PUBLIC_URL || (RENDER_EXTERNAL_HOSTNAME && `https://${RENDER_EXTERNAL_HOSTNAME}`))?.replace(/\/$/, '');
if (hosted && !publicUrl) throw new Error('Не удалось определить публичный URL; задайте PUBLIC_URL');

const telegram = createTelegram({ token: BOT_TOKEN, baseUrl: TELEGRAM_API_URL });
const store = hosted ? await createNeonStore({ connectionString: DATABASE_URL }) : createStore(DATA_FILE);
const xiaomiSession = POWER_SENSOR_MODEL ? loadSession() : null;
if (POWER_SENSOR_MODEL && !xiaomiSession) console.error('Датчик света выключен: нет входа в Xiaomi');
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

let lastAddressRefresh = 0;
let tickPromise = null;
let operation = Promise.resolve();
let ready = false;

function serialize(task) {
  const result = operation.then(task, task);
  operation = result.catch(() => {});
  return result;
}

async function runTick() {
  if (tickPromise) return tickPromise;
  tickPromise = serialize(async () => {
    await app.pollSite();
    await app.checkWarnings();
    if (power) await power.poll();
    if (Date.now() - lastAddressRefresh >= ADDRESS_REFRESH_MS) {
      await app.refreshAddresses();
      lastAddressRefresh = Date.now();
    }
    await store.flush();
  }).finally(() => {
    tickPromise = null;
  });
  return tickPromise;
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Тело запроса слишком большое');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/healthz') {
    json(response, ready ? 200 : 503, { ok: ready });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/telegram') {
    if (request.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
      json(response, 401, { ok: false });
      return;
    }
    try {
      const update = await readJson(request);
      await serialize(async () => {
        await app.handleUpdate(update);
        await store.flush();
      });
      json(response, 200, { ok: true });
    } catch (error) {
      console.error(`Webhook: ${error.message}`);
      json(response, 500, { ok: false });
    }
    return;
  }
  if (request.method === 'POST' && url.pathname === '/tasks/tick') {
    if (request.headers.authorization !== `Bearer ${CRON_SECRET}`) {
      json(response, 401, { ok: false });
      return;
    }
    void runTick().catch((error) => console.error(`Плановая проверка: ${error.message}`));
    json(response, 202, { ok: true });
    return;
  }
  json(response, 404, { ok: false });
});

function repeat(name, intervalMs, task) {
  (async () => {
    for (;;) {
      try {
        await serialize(task);
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
    try {
      const updates = await telegram.getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        await serialize(() => app.handleUpdate(update));
      }
    } catch (error) {
      console.error(`Telegram: ${error.message}`);
      await sleep(5000);
    }
  }
}

server.listen(Number(PORT), '0.0.0.0', async () => {
  console.log(`HTTP-сервис слушает порт ${PORT}`);
  try {
    const me = await telegram.getMe();
    await telegram.setMyCommands([
      { command: 'schedule', description: 'Показати графіки за всіма адресами' },
      { command: 'add', description: 'Додати адресу' },
      { command: 'addresses', description: 'Мої адреси: графік і видалення' },
    ]);
    if (hosted) await telegram.setWebhook(`${publicUrl}/telegram`, WEBHOOK_SECRET);
    else await telegram.deleteWebhook();
    ready = true;
    console.log(`Бот @${me.username} запущен. Пригласительная ссылка: https://t.me/${me.username}?start=${ACCESS_CODE}`);
    if (hosted) {
      void runTick().catch((error) => console.error(`Первая проверка: ${error.message}`));
    } else {
      await serialize(app.pollSite);
      repeat('Проверка сайта', Number(POLL_SECONDS) * 1000, app.pollSite);
      repeat('Предупреждения', WARNING_CHECK_MS, app.checkWarnings);
      if (power) repeat('Датчик света', Number(POWER_POLL_SECONDS) * 1000, power.poll);
      repeat('Проверка адресов', ADDRESS_REFRESH_MS, app.refreshAddresses);
      void receiveUpdates();
    }
  } catch (error) {
    console.error(`Запуск: ${error.message}`);
  }
});
