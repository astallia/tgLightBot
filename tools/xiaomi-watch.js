// Standalone check, separate from the bot: logs in to Xiaomi Home by QR code and records every
// device going offline and back. Shows whether the cloud status is usable and how long drops last.
//
//   node tools/xiaomi-watch.js
//
// The session and the log stay in data/, which git ignores.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createXiaomiClient, loadSession, SESSION_FILE, startQrLogin, XiaomiAuthError,
} from '../src/xiaomi.js';
import { formatClock, formatDuration } from '../src/schedule.js';

const LOG_FILE = 'data/xiaomi-status.log';
const POLL_MS = 30000;

mkdirSync('data', { recursive: true });

function say(text) {
  const line = `${new Date().toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' })} ${formatClock(Date.now())} ${text}`;
  console.log(line);
  appendFileSync(LOG_FILE, `${line}\n`);
}

async function login() {
  const { qrUrl, loginUrl, waitForConfirmation } = await startQrLogin();
  console.log('\nВойдите в аккаунт Xiaomi по этой ссылке, в браузере:');
  console.log(`\n  ${loginUrl}\n`);
  console.log('Или откройте QR-код и отсканируйте его камерой телефона:');
  console.log(`\n  ${qrUrl}\n`);
  console.log('Обе ссылки действуют 5 минут. Жду...\n');
  const session = await waitForConfirmation();
  writeFileSync(SESSION_FILE, JSON.stringify(session), { mode: 0o600 });
  console.log('Вход выполнен.\n');
  return session;
}

const session = loadSession() ?? await login().catch((error) => {
  console.error(`Вход не выполнен: ${error.message}`);
  process.exit(1);
});
const client = createXiaomiClient(session);
const seen = new Map();
let cloudDownSince = null;

for (;;) {
  try {
    const devices = await client.listDevices();
    if (cloudDownSince) {
      say(`Связь с облаком Xiaomi вернулась, её не было ${formatDuration(Math.round((Date.now() - cloudDownSince) / 60000))}`);
      cloudDownSince = null;
    }
    if (!seen.size) {
      console.log(`Устройств: ${devices.length}`);
      for (const device of devices) console.log(`  ${device.online ? 'на связи ' : 'нет связи'}  ${device.name} (${device.model})`);
      console.log('\nСлежу за изменениями, проверка раз в 30 секунд. Остановить: Ctrl+C\n');
    }
    for (const device of devices) {
      const previous = seen.get(device.id);
      if (previous && previous.online !== device.online) {
        const lasted = formatDuration(Math.round((Date.now() - previous.since) / 60000));
        if (device.online) say(`${device.name}: снова на связи, связи не было ${lasted}`);
        else say(`${device.name}: нет связи, до этого было на связи ${lasted}`);
      }
      if (!previous || previous.online !== device.online) seen.set(device.id, { online: device.online, since: Date.now() });
    }
  } catch (error) {
    if (error instanceof XiaomiAuthError) {
      say(`Сессия больше не действует: ${error.message}. Удалите ${SESSION_FILE} и запустите снова.`);
      process.exit(1);
    }
    if (!cloudDownSince) {
      cloudDownSince = Date.now();
      say(`Не могу получить статус: ${error.message}`);
    }
  }
  await sleep(POLL_MS);
}
