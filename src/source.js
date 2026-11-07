// Schedules come from outage-data-ua (github.com/Baskerville42/outage-data-ua), an open repository
// that republishes the DTEK site's per-queue schedules every few minutes, in the same shape the site
// uses. Its licence is MIT, without any guarantee. It has no addresses, so people pick their queue.

const DEFAULT_URL = 'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv-region.json';
const USER_AGENT = 'DtekSvetTelegramBot/1.0 (personal, non-commercial)';
const REQUEST_TIMEOUT_MS = 30000;
// The repository updates about every 5 minutes, so data older than this means its collector stopped.
const STALE_AFTER_MS = 30 * 60000;

// Turns the file into what the bot keeps: the schedule and when the source last read it.
export function parseSource(file, nowMs) {
  const fact = file?.fact;
  if (!fact || typeof fact.data !== 'object' || fact.data === null) throw new Error('У джерелі немає графіка');
  const updatedAt = Date.parse(file.lastUpdated);
  if (Number.isNaN(updatedAt)) throw new Error('У джерелі немає часу оновлення');
  if (file.lastUpdateStatus && file.lastUpdateStatus.ok === false) {
    throw new Error(`Джерело не змогло оновити дані: ${file.lastUpdateStatus.code ?? ''} ${file.lastUpdateStatus.message ?? ''}`.trim());
  }
  if (nowMs - updatedAt > STALE_AFTER_MS) {
    throw new Error(`Джерело не оновлювалось з ${new Date(updatedAt).toISOString()}`);
  }
  return { fact: { data: fact.data, update: fact.update ?? '' }, updatedAt };
}

export function createScheduleSource({ url = DEFAULT_URL } = {}) {
  return {
    async fetchSchedule(nowMs = Date.now()) {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Джерело відповіло ${response.status}`);
      return parseSource(await response.json(), nowMs);
    },
  };
}
