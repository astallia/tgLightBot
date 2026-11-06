// Pure schedule logic: site codes -> half-hour slots -> intervals, totals and upcoming outages.
// Everything is computed in Kyiv wall-clock time, whatever timezone the server runs in.

const TZ = 'Europe/Kyiv';
const HALF_HOUR_MIN = 30;

// Codes from DisconSchedule.preset.time_type. An unknown code counts as "maybe" so that
// a new code on the site cannot silently hide an outage.
const HALVES = {
  yes: ['on', 'on'],
  no: ['off', 'off'],
  first: ['off', 'on'],
  second: ['on', 'off'],
  maybe: ['maybe', 'maybe'],
  mfirst: ['maybe', 'on'],
  msecond: ['on', 'maybe'],
};

function kyivOffsetMs(epochMs) {
  const label = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(epochMs)
    .find((part) => part.type === 'timeZoneName').value;
  const match = label.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const ms = (Number(match[2]) * 60 + Number(match[3])) * 60000;
  return match[1] === '-' ? -ms : ms;
}

function kyivDateParts(epochMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(epochMs);
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

export function wallToEpoch(year, month, day, hour = 0, minute = 0) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const guess = wall - kyivOffsetMs(wall);
  return wall - kyivOffsetMs(guess);
}

// Site day keys are the Kyiv midnight as epoch seconds.
export function dayKey(epochMs, addDays = 0) {
  const { year, month, day } = kyivDateParts(epochMs);
  return String(wallToEpoch(year, month, day + addDays) / 1000);
}

export function formatClock(epochMs) {
  return new Intl.DateTimeFormat('uk-UA', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(epochMs);
}

export function formatDayLabel(key) {
  const date = Number(key) * 1000;
  const weekday = new Intl.DateTimeFormat('uk-UA', { timeZone: TZ, weekday: 'short' }).format(date);
  const dayMonth = new Intl.DateTimeFormat('uk-UA', { timeZone: TZ, day: '2-digit', month: '2-digit' }).format(date);
  return `${weekday} ${dayMonth}`;
}

export function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return `${hours} год ${rest} хв`;
  if (hours) return `${hours} год`;
  return `${rest} хв`;
}

export function rowStates(row) {
  const states = [];
  for (let hour = 1; hour <= 24; hour++) {
    states.push(...(HALVES[row[hour]] ?? HALVES.maybe));
  }
  return states;
}

function clockLabel(slotIndex) {
  const minutes = slotIndex * HALF_HOUR_MIN;
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

// One day of one group: intervals per state and how many minutes each state takes.
export function summarizeDay(row) {
  const states = rowStates(row);
  const totals = { on: 0, off: 0, maybe: 0 };
  const intervals = { on: [], off: [], maybe: [] };
  let start = 0;
  states.forEach((state, index) => {
    totals[state] += HALF_HOUR_MIN;
    if (states[index + 1] !== state) {
      intervals[state].push({ from: clockLabel(start), to: clockLabel(index + 1) });
      start = index + 1;
    }
  });
  return { totals, intervals };
}

function buildTimeline(fact, group) {
  const slots = [];
  for (const key of Object.keys(fact?.data ?? {}).sort((a, b) => Number(a) - Number(b))) {
    const row = fact.data[key]?.[group];
    if (!row) continue;
    const { year, month, day } = kyivDateParts(Number(key) * 1000);
    rowStates(row).forEach((state, index) => {
      const minutes = index * HALF_HOUR_MIN;
      slots.push({
        state,
        start: wallToEpoch(year, month, day, Math.floor(minutes / 60), minutes % 60),
        end: wallToEpoch(year, month, day, Math.floor((minutes + HALF_HOUR_MIN) / 60), (minutes + HALF_HOUR_MIN) % 60),
      });
    });
  }
  return slots;
}

// Moments when the light goes out, across days. "until" is the end of the whole dark stretch;
// openEnded means the stretch runs into a day the site has not published yet.
export function outageStarts(fact, group) {
  const slots = buildTimeline(fact, group);
  const starts = [];
  slots.forEach((slot, index) => {
    const previous = slots[index - 1]?.state ?? 'on';
    const begins = slot.state === 'off' ? previous !== 'off' : slot.state === 'maybe' && previous === 'on';
    if (!begins) return;
    let last = index;
    while (last + 1 < slots.length && slots[last + 1].state !== 'on') last++;
    starts.push({
      at: slot.start,
      until: slots[last].end,
      certain: slot.state === 'off',
      openEnded: last === slots.length - 1,
    });
  });
  return starts;
}

// What the schedule says for a moment in time, and until when that stays true.
export function scheduleAt(fact, group, at) {
  const slots = buildTimeline(fact, group);
  const index = slots.findIndex((slot) => slot.start <= at && at < slot.end);
  if (index < 0) return null;
  let last = index;
  while (last + 1 < slots.length && slots[last + 1].state === slots[index].state) last++;
  return { state: slots[index].state, until: slots[last].end, openEnded: last === slots.length - 1 };
}

// Per-day fingerprint of one group, kept per user to detect what that user has not been told yet.
export function snapshot(fact, group) {
  const result = {};
  for (const [key, groups] of Object.entries(fact?.data ?? {})) {
    if (groups?.[group]) result[key] = JSON.stringify(groups[group]);
  }
  return result;
}

// Days that have simply passed are not a change, otherwise every midnight would look like one.
export function diffSnapshots(seen, current, nowMs) {
  const today = Number(dayKey(nowMs));
  let changed = false;
  let added = false;
  const days = new Set();
  for (const [key, value] of Object.entries(current)) {
    if (Number(key) < today) continue;
    if (!(key in seen)) {
      added = true;
      days.add(key);
    } else if (seen[key] !== value) {
      changed = true;
      days.add(key);
    }
  }
  for (const key of Object.keys(seen)) {
    if (Number(key) >= today && !(key in current)) {
      changed = true;
      days.add(key);
    }
  }
  return { changed, added, days: [...days].sort((a, b) => Number(a) - Number(b)) };
}
