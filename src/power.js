// Tells whether the home has power from Xiaomi cloud statuses. The sensor is a device on mains
// power; the references are routers on a UPS, which prove the internet still works while the
// sensor is gone. If the sensor drops at random, a waiting time before believing a change filters
// that out; by default there is none, so every change is reported at once.

import { XiaomiAuthError } from './xiaomi.js';
import {
  dayKey, formatClock, formatDuration, outageStarts, scheduleAt,
} from './schedule.js';

const ALERT_AFTER_FAILURE_MS = 30 * 60000;

export function observePower(devices, sensorModel, referenceModels) {
  const sensor = devices.find((device) => device.model === sensorModel);
  if (!sensor) throw new Error(`В аккаунте Xiaomi нет устройства ${sensorModel}`);
  if (sensor.online) return 'on';
  const internetWorks = devices.some((device) => referenceModels.includes(device.model) && device.online);
  return internetWorks ? 'off' : 'unknown';
}

// One step of the filter. A change counts only after it has held for the whole waiting time,
// and `since` is when it was first seen, not when it was believed.
export function advancePower(previous, observed, now, { offAfterMs, onAfterMs }) {
  if (!previous) {
    return {
      power: { state: observed, candidate: observed, candidateSince: now, dark: observed === 'off', darkSince: null, litSince: null },
      events: [],
    };
  }
  const power = { ...previous };
  if (observed !== power.candidate) {
    power.candidate = observed;
    power.candidateSince = now;
  }
  const waitMs = observed === 'on' ? onAfterMs : offAfterMs;
  if (observed === power.state || now - power.candidateSince < waitMs) return { power, events: [] };

  const since = power.candidateSince;
  power.state = observed;
  const events = [];
  if (observed === 'on') {
    if (power.dark) {
      events.push({ type: 'on', since, darkSince: power.darkSince });
      power.litSince = since;
    } else {
      events.push({ type: 'reconnected' });
    }
    power.dark = false;
    power.darkSince = null;
  } else if (!power.dark && observed === 'off') {
    events.push({ type: 'off', since, litSince: power.litSince });
    power.dark = true;
    power.darkSince = since;
    power.litSince = null;
  } else if (!power.dark) {
    events.push({ type: 'unknown', since });
  }
  return { power, events };
}

const lasted = (from, to) => formatDuration(Math.round((to - from) / 60000));

export function createPowerMonitor({
  xiaomi, store, telegram, sensorModel, referenceModels, offAfterMs = 0, onAfterMs = 0, now = Date.now, log = console.error,
}) {
  let failingSince = null;
  let failureAlertSent = false;
  let authAlertSent = false;

  const subscribers = () => store.users().filter(([, user]) => user.powerAlerts);

  async function tell(chatId, text) {
    await telegram.sendMessage(chatId, text, {}).catch((error) => log(`Не отправлено ${chatId}: ${error.message}`));
  }

  async function tellAll(text) {
    for (const [chatId] of subscribers()) await tell(chatId, text);
  }

  function scheduleLine(user) {
    const group = user.addresses[0]?.group;
    const planned = group ? scheduleAt(store.fact, group, now()) : null;
    if (!planned) return '';
    if (planned.state === 'off') {
      return `\nЗа графіком зараз відключення, ${planned.openEnded ? 'щонайменше ' : ''}до ${formatClock(planned.until)}.`;
    }
    if (planned.state === 'maybe') return '\nЗа графіком зараз можливе відключення.';
    return '\nЗа графіком світло зараз має бути, тож це може бути аварійне відключення або збій шлюзу.';
  }

  function nextOutageLine(user) {
    const group = user.addresses[0]?.group;
    if (!group) return '';
    const next = outageStarts(store.fact, group).find((start) => start.at > now());
    if (!next) return '\nНаступних відключень у графіку поки немає.';
    const what = next.certain ? 'Наступне відключення' : 'Наступне можливе відключення';
    const day = dayKey(next.at) === dayKey(now()) ? '' : 'завтра ';
    const longer = next.openEnded ? ' або довше' : '';
    return `\n${what}: ${day}${formatClock(next.at)}–${formatClock(next.until)}${longer}.`;
  }

  // Light can come back earlier than planned, and then it may still go out again within that window.
  function earlyReturnLine(user) {
    const group = user.addresses[0]?.group;
    const planned = group ? scheduleAt(store.fact, group, now()) : null;
    if (planned?.state !== 'off') return '';
    return `\nЗа графіком відключення ще до ${formatClock(planned.until)}, тож світло може знову зникнути.`;
  }

  async function report(event) {
    for (const [chatId, user] of subscribers()) {
      if (event.type === 'off') {
        const wasOn = event.litSince ? ` Світло було ${lasted(event.litSince, event.since)}.` : '';
        await tell(chatId, `🌑 Схоже, світла немає з ${formatClock(event.since)}.${wasOn}${scheduleLine(user)}${nextOutageLine(user)}`);
      } else if (event.type === 'on') {
        const wasOff = event.darkSince ? ` Його не було ${lasted(event.darkSince, event.since)}.` : '';
        await tell(chatId, `💡 Світло є з ${formatClock(event.since)}.${wasOff}${earlyReturnLine(user)}${nextOutageLine(user)}`);
      } else if (event.type === 'unknown') {
        await tell(chatId, `🌐 З ${formatClock(event.since)} немає зв'язку з домом: не видно ні шлюзу, ні роутерів. Можливо, немає інтернету або розрядився ДБЖ, тому про світло сказати не можу.`);
      } else {
        await tell(chatId, "🌐 Зв'язок із домом відновився, світло є.");
      }
    }
  }

  async function failed(error) {
    log(`Датчик света: ${error.message}`);
    if (error instanceof XiaomiAuthError) {
      if (!authAlertSent) {
        authAlertSent = true;
        await tellAll('⚠️ Вхід у Xiaomi більше не діє, тому датчик світла не працює. Потрібно увійти знову.');
      }
      return;
    }
    failingSince ??= now();
    if (!failureAlertSent && now() - failingSince >= ALERT_AFTER_FAILURE_MS) {
      failureAlertSent = true;
      await tellAll('⚠️ Уже 30 хвилин не можу отримати дані датчика від Xiaomi, тому не знаю, чи є світло.');
    }
  }

  return {
    async poll() {
      let devices;
      let observed;
      try {
        devices = await xiaomi.listDevices();
        observed = observePower(devices, sensorModel, referenceModels);
      } catch (error) {
        await failed(error);
        return;
      }
      if (failureAlertSent) await tellAll('✅ Дані датчика від Xiaomi знову надходять.');
      failingSince = null;
      failureAlertSent = false;
      authAlertSent = false;

      const { power, events } = advancePower(store.power, observed, now(), { offAfterMs, onAfterMs });
      store.power = power;
      store.save();
      for (const event of events) await report(event);
    },

    toggle(user) {
      user.powerAlerts = !user.powerAlerts;
      store.save();
      if (!user.powerAlerts) return '🔌 Сповіщення датчика світла вимкнено.';
      const current = {
        on: `світло є.${earlyReturnLine(user)}`,
        off: `схоже, світла немає.${scheduleLine(user)}`,
        unknown: "немає зв'язку з домом.",
      }[store.power?.state] ?? 'ще немає даних.';
      return `🔌 Сповіщення датчика світла увімкнено.\nЗараз: ${current}${nextOutageLine(user)}`;
    },
  };
}
