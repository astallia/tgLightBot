import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clockMinutes, dayKey, diffSnapshots, formatDuration, outageStarts, snapshot, summarizeDay, wallToEpoch,
} from '../src/schedule.js';

// Real row of queue 4.2 from the site on 06.11.2026.
const REAL_CODES = 'second no no no first yes yes yes yes yes first no no no no no no no first yes no no no no'.split(' ');
const toRow = (codes) => Object.fromEntries(codes.map((code, index) => [index + 1, code]));
const allYes = (overrides = {}) => ({ ...toRow(Array(24).fill('yes')), ...overrides });

const TODAY = '1793916000'; // Key the site used for 06.11.2026.
const TOMORROW = '1794002400';
const at = (hour, minute = 0, day = 6) => wallToEpoch(2026, 11, day, hour, minute);

test('day keys match the keys the site uses', () => {
  assert.equal(dayKey(at(13, 37)), TODAY);
  assert.equal(dayKey(at(13, 37), 1), TOMORROW);
  assert.equal(dayKey(at(0, 0)), TODAY);
  assert.equal(dayKey(at(23, 59)), TODAY);
});

test('Kyiv time does not depend on the season or the server timezone', () => {
  assert.equal(new Date(wallToEpoch(2026, 11, 6, 12)).toISOString(), '2026-11-06T10:00:00.000Z');
  assert.equal(new Date(wallToEpoch(2026, 7, 1, 12)).toISOString(), '2026-07-01T09:00:00.000Z');
});

test('half-hour codes become the right intervals', () => {
  const { intervals, totals } = summarizeDay(toRow(REAL_CODES));
  assert.deepEqual(intervals.off, [
    { from: '00:30', to: '04:30' },
    { from: '10:00', to: '10:30' },
    { from: '11:00', to: '18:30' },
    { from: '20:00', to: '24:00' },
  ]);
  assert.equal(totals.off, 16 * 60);
  assert.equal(totals.on, 8 * 60);
  assert.equal(totals.maybe, 0);
});

test('possible outages are counted apart from certain ones', () => {
  const { intervals, totals } = summarizeDay(allYes({ 3: 'maybe', 4: 'mfirst', 8: 'msecond', 12: 'no' }));
  assert.deepEqual(intervals.maybe, [{ from: '02:00', to: '03:30' }, { from: '07:30', to: '08:00' }]);
  assert.deepEqual(intervals.off, [{ from: '11:00', to: '12:00' }]);
  assert.deepEqual(totals, { on: 21 * 60, off: 60, maybe: 120 });
});

test('an unknown code from the site is not treated as light being on', () => {
  const { totals } = summarizeDay(allYes({ 5: 'something-new' }));
  assert.equal(totals.maybe, 60);
});

test('a day with no outages has no off intervals', () => {
  const { intervals, totals } = summarizeDay(allYes());
  assert.deepEqual(intervals.off, []);
  assert.equal(totals.on, 24 * 60);
});

test('a clock time converts to minutes, including the end of the day', () => {
  assert.equal(clockMinutes('00:00'), 0);
  assert.equal(clockMinutes('07:30'), 450);
  assert.equal(clockMinutes('24:00'), 1440);
});

test('durations read naturally', () => {
  assert.equal(formatDuration(30), '30 хв');
  assert.equal(formatDuration(60), '1 год');
  assert.equal(formatDuration(810), '13 год 30 хв');
  assert.equal(formatDuration(0), '0 хв');
});

test('outage starts carry the real start and end of each dark stretch', () => {
  const fact = { data: { [TODAY]: { G: toRow(REAL_CODES) } } };
  const starts = outageStarts(fact, 'G');
  assert.deepEqual(starts.map((start) => start.at), [at(0, 30), at(10), at(11), at(20)]);
  assert.equal(starts[1].until, at(10, 30));
  assert.equal(starts[3].until, at(0, 0, 7));
  assert.equal(starts[3].openEnded, true, 'tomorrow is unknown, so the end is only a lower bound');
  assert.equal(starts[1].openEnded, false);
});

test('an outage running through midnight is one outage', () => {
  const fact = {
    data: {
      [TODAY]: { G: allYes({ 24: 'no' }) },
      [TOMORROW]: { G: allYes({ 1: 'no', 2: 'first' }) },
    },
  };
  const starts = outageStarts(fact, 'G');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].at, at(23));
  assert.equal(starts[0].until, at(1, 30, 7));
  assert.equal(starts[0].openEnded, false);
});

test('an outage right at midnight is found through the day boundary', () => {
  const fact = { data: { [TODAY]: { G: allYes() }, [TOMORROW]: { G: allYes({ 1: 'no' }) } } };
  assert.deepEqual(outageStarts(fact, 'G').map((start) => start.at), [at(0, 0, 7)]);
});

test('a maybe that turns into a certain outage warns again, a certain one fading to maybe does not', () => {
  const up = outageStarts({ data: { [TODAY]: { G: allYes({ 10: 'maybe', 11: 'no' }) } } }, 'G');
  assert.deepEqual(up.map((start) => [start.at, start.certain]), [[at(9), false], [at(10), true]]);
  const down = outageStarts({ data: { [TODAY]: { G: allYes({ 10: 'no', 11: 'maybe' }) } } }, 'G');
  assert.deepEqual(down.map((start) => start.at), [at(9)]);
  assert.equal(down[0].until, at(11));
});

test('missing data gives no outages instead of an error', () => {
  assert.deepEqual(outageStarts(null, 'G'), []);
  assert.deepEqual(outageStarts({ data: [] }, 'G'), []);
  assert.deepEqual(outageStarts({ data: { [TODAY]: { OTHER: allYes() } } }, 'G'), []);
});

test('only changes in the group that matter count', () => {
  const noon = at(12);
  const base = { data: { [TODAY]: { G: allYes(), H: allYes() } } };
  const seen = snapshot(base, 'G');
  const otherGroup = { data: { [TODAY]: { G: allYes(), H: allYes({ 5: 'no' }) } } };
  assert.deepEqual(diffSnapshots(seen, snapshot(otherGroup, 'G'), noon), { changed: false, added: false, days: [] });
  const ownGroup = { data: { [TODAY]: { G: allYes({ 5: 'no' }) } } };
  assert.deepEqual(diffSnapshots(seen, snapshot(ownGroup, 'G'), noon), { changed: true, added: false, days: [TODAY] });
  const withTomorrow = { data: { [TODAY]: { G: allYes() }, [TOMORROW]: { G: allYes() } } };
  assert.deepEqual(diffSnapshots(seen, snapshot(withTomorrow, 'G'), noon), { changed: false, added: true, days: [TOMORROW] });
});

test('midnight rollover is not a change, a withdrawn current schedule is', () => {
  const seen = snapshot({ data: { [TODAY]: { G: allYes() } } }, 'G');
  const nextDay = { data: { [TOMORROW]: { G: allYes() } } };
  assert.deepEqual(diffSnapshots({ ...seen, [TOMORROW]: JSON.stringify(allYes()) }, snapshot(nextDay, 'G'), at(0, 5, 7)), { changed: false, added: false, days: [] });
  assert.deepEqual(diffSnapshots(seen, {}, at(12)), { changed: true, added: false, days: [TODAY] });
});
