import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildScheduleSvg, renderScheduleImage } from '../src/chart.js';

const allYes = (overrides = {}) => {
  const row = {};
  for (let hour = 1; hour <= 24; hour++) row[hour] = 'yes';
  return { ...row, ...overrides };
};
const ON = '#F2A900';
const OFF = '#2A2E45';
const MAYBE = '#9AA0B8';

const card = ({ row, nowMinutes }, extra = {}) => ({
  address: 'с. Гатне, вул. Шляхова, 4',
  queues: 'черга 3.2',
  days: [{ title: 'Сьогодні', lines: row ? [{ row }] : [], nowMinutes }],
  ...extra,
});

// The stretches drawn on the picture: [first half hour, half hour after the last, colour].
function stretches(svg) {
  return [...svg.matchAll(/width="([\d.]+)"[^>]*fill="([^"]+)" data-from="(\d+)" data-to="(\d+)"/g)]
    .map((match) => [Number(match[3]), Number(match[4]), match[2]]);
}

test('it produces a real PNG, Ukrainian letters and all', () => {
  const png = renderScheduleImage(card({ row: allYes({ 12: 'no', 5: 'first', 7: 'maybe' }), nowMinutes: 600 }));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(png.length > 5000, 'a card with text is not an empty picture');
});

test('stretches of one state are one bar, down to the half hour', () => {
  const svg = buildScheduleSvg(card({ row: allYes({ 1: 'no', 2: 'first', 4: 'second', 6: 'maybe', 7: 'mfirst', 9: 'msecond' }) }));
  assert.deepEqual(stretches(svg), [
    [0, 3, OFF], // 00:00-01:30: a whole hour, then the first half of the next
    [3, 7, ON],
    [7, 8, OFF], // 03:30-04:00: the second half
    [8, 10, ON],
    [10, 13, MAYBE], // 05:00-06:30: a possible hour, then a possible first half
    [13, 17, ON],
    [17, 18, MAYBE], // 08:30-09:00: a possible second half
    [18, 24, ON],
    [24, 48, ON],
  ]);
});

test('an outage over noon is cut at the end of the row and continues on the next', () => {
  const svg = buildScheduleSvg(card({ row: allYes({ 12: 'no', 13: 'no' }) }));
  assert.deepEqual(stretches(svg), [[0, 22, ON], [22, 24, OFF], [24, 26, OFF], [26, 48, ON]]);
});

test('bars fill each row exactly, so a position on the row is a true time', () => {
  const svg = buildScheduleSvg(card({ row: allYes() }));
  const [first, second] = [...svg.matchAll(/<rect x="([\d.]+)"[^>]*width="([\d.]+)"[^>]*data-from/g)]
    .map((match) => [Number(match[1]), Number(match[2])]);
  assert.deepEqual(first, [48, 984]);
  assert.deepEqual(second, [48, 984]);
});

const clockLabels = (svg) => [...svg.matchAll(/>(\d\d:\d\d)<\/text>/g)].map((match) => match[1]);

test('with no changes only the ends of the rows are labelled', () => {
  assert.deepEqual(clockLabels(buildScheduleSvg(card({ row: allYes() }))), ['00:00', '12:00', '12:00', '24:00']);
});

test('every bar is labelled where it starts and where it ends', () => {
  // Real queue 2.2: dark 00:00-01:00, 07:30-15:00, 18:00-24:00.
  const row = allYes({ 1: 'no', 8: 'second', 9: 'no', 10: 'no', 11: 'no', 12: 'no', 13: 'no', 14: 'no', 15: 'no', 19: 'no', 20: 'no', 21: 'no', 22: 'no', 23: 'no', 24: 'no' });
  assert.deepEqual(clockLabels(buildScheduleSvg(card({ row }))), [
    '00:00', '01:00', '07:30', '12:00',
    '12:00', '15:00', '18:00', '24:00',
  ]);
});

test('half hours are labelled too', () => {
  const labels = clockLabels(buildScheduleSvg(card({ row: allYes({ 2: 'first', 16: 'second' }) })));
  assert.deepEqual(labels, ['00:00', '01:00', '01:30', '12:00', '12:00', '15:30', '16:00', '24:00']);
});

// Where each label was put: [left edge, baseline], read from the white box behind it.
function labelBoxes(svg) {
  return [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="80" height="36"/g)]
    .map((match) => [Number(match[1]), Number(match[2])]);
}

test('labels never touch, even with a change every half hour, and none is dropped', () => {
  const row = allYes();
  for (let hour = 1; hour <= 24; hour += 2) row[hour] = 'first';
  for (let hour = 2; hour <= 24; hour += 2) row[hour] = 'second';
  const svg = buildScheduleSvg(card({ row }));
  const boxes = labelBoxes(svg);
  assert.ok(boxes.length >= 24, `labels: ${boxes.length}`);
  boxes.forEach(([x, y], index) => {
    for (const [otherX, otherY] of boxes.slice(index + 1)) {
      const sameLevel = y === otherY;
      // The boxes behind the labels are 2px wider than the labels on each side.
      const overlap = x + 2 < otherX + 78 && otherX + 2 < x + 78;
      assert.ok(!(sameLevel && overlap), `labels at ${x} and ${otherX} on level ${y}`);
    }
  });
  assert.ok(boxes.every(([x]) => x >= 0 && x + 80 <= 1080), 'all labels stay on the picture');
});

test('the labels of an hour-long bar stay side by side on one level', () => {
  const svg = buildScheduleSvg(card({ row: allYes({ 1: 'no', 5: 'no' }) }));
  // The first row: 00:00, 01:00, 04:00, 05:00, 12:00.
  const levels = new Set(labelBoxes(svg).slice(0, 5).map(([, y]) => y));
  assert.equal(levels.size, 1);
});

test('half-hour bars move a label down a level', () => {
  const svg = buildScheduleSvg(card({ row: allYes({ 5: 'first' }) }));
  const levels = new Set(labelBoxes(svg).slice(0, 4).map(([, y]) => y));
  assert.equal(levels.size, 2);
});

test('lower labels push the next row down instead of running into it', () => {
  const tight = allYes({ 2: 'first', 3: 'first', 4: 'first' });
  const svg = buildScheduleSvg(card({ row: tight }));
  const [, secondRowTop] = svg.match(/y="([\d.]+)"[^>]*data-from="24"/);
  const lowest = Math.max(...labelBoxes(svg).slice(0, 8).map(([, y]) => y));
  assert.ok(Number(secondRowTop) > lowest);
});

test('totals are in the legend, and the possible ones only when there are any', () => {
  const plain = buildScheduleSvg(card({ row: allYes({ 12: 'no', 13: 'first' }) }));
  assert.match(plain, /Світло <tspan[^>]*>22 год 30 хв/);
  assert.match(plain, /Без світла <tspan[^>]*>1 год 30 хв/);
  assert.doesNotMatch(plain, /Можливо/);
  assert.match(buildScheduleSvg(card({ row: allYes({ 4: 'maybe' }) })), /Можливо без світла <tspan[^>]*>1 год/);
});

test('the now marker appears only for the day that has it, at the right time', () => {
  const withMarker = buildScheduleSvg(card({ row: allYes(), nowMinutes: 15 * 60 + 30 }));
  assert.match(withMarker, /data-now="930"/);
  assert.match(withMarker, />зараз</);
  assert.doesNotMatch(buildScheduleSvg(card({ row: allYes() })), /зараз/);
});

test('the marker stays inside the picture at both ends of the day', () => {
  for (const nowMinutes of [0, 719, 720, 1439]) {
    const svg = buildScheduleSvg(card({ row: allYes(), nowMinutes }));
    const pill = svg.match(/<rect x="([\d.]+)" y="[\d.]+" width="(\d+)"[^>]*data-pill/);
    assert.ok(Number(pill[1]) >= 48 && Number(pill[1]) + Number(pill[2]) <= 1032, `pill at ${nowMinutes}`);
  }
});

test('several days are drawn in order', () => {
  const svg = buildScheduleSvg({
    address: 'а', queues: 'черга 1.1', days: [{ title: 'Сьогодні', lines: [{ row: allYes() }] }, { title: 'Завтра', lines: [{ row: allYes() }] }],
  });
  assert.ok(svg.indexOf('Сьогодні') < svg.indexOf('Завтра'));
});

test('names from the site cannot break the picture', () => {
  const svg = buildScheduleSvg(card({ row: allYes() }, { address: 'вул. <Нова> & "Стара"' }));
  assert.match(svg, /вул\. &lt;Нова&gt; &amp; &quot;Стара&quot;/);
  renderScheduleImage(card({ row: allYes() }, { address: 'вул. <Нова> & "Стара"' }));
});

test('a very long address is shortened to stay on the picture', () => {
  const svg = buildScheduleSvg(card({ row: allYes() }, { address: 'д'.repeat(100) }));
  assert.match(svg, /д{43}… · черга 3\.2/);
});

test('a house on two lines shows each one, named, and still renders', () => {
  const schedule = {
    address: 'м. Переяслав, вул. Шкільна, 44',
    queues: 'черги 6.2, 4.1',
    days: [{
      title: 'Сьогодні',
      nowMinutes: 600,
      lines: [{ label: 'Черга 6.2', row: allYes({ 1: 'no' }) }, { label: 'Черга 4.1', row: allYes({ 2: 'first' }) }],
    }],
  };
  const svg = buildScheduleSvg(schedule);
  assert.match(svg, /черги 6\.2, 4\.1/);
  assert.ok(svg.indexOf('Черга 6.2') < svg.indexOf('Черга 4.1'));
  assert.equal((svg.match(/data-from="0"/g) ?? []).length, 2, 'two lines, each drawn from the start of the day');
  assert.equal((svg.match(/data-now=/g) ?? []).length, 2, 'the marker is on both lines');
  assert.ok(renderScheduleImage(schedule).length > 5000);
});

test('without an address the card holds only the days', () => {
  const svg = buildScheduleSvg({ queues: 'черга 3.2', days: [{ title: 'Сьогодні', lines: [{ row: allYes() }] }] });
  assert.doesNotMatch(svg, /черга 3\.2/);
  assert.doesNotMatch(svg, /Оновлено/);
  assert.match(svg, />Сьогодні</);
  assert.ok(renderScheduleImage({ queues: 'черга 3.2', days: [{ title: 'Сьогодні', lines: [{ row: allYes() }] }] }).length > 5000);
});

test('one line needs no name', () => {
  assert.doesNotMatch(buildScheduleSvg(card({ row: allYes() })), /Черга/);
});
