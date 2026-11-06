import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildScheduleSvg, renderScheduleImage } from '../src/chart.js';

const allYes = (overrides = {}) => {
  const row = {};
  for (let hour = 1; hour <= 24; hour++) row[hour] = 'yes';
  return { ...row, ...overrides };
};
const ON = '#FFD23F';
const OFF = '#2A2E45';

const card = ({ row, nowMinutes }, extra = {}) => ({
  address: 'с. Гатне, вул. Шляхова, 4',
  queues: 'черга 3.2',
  update: '06.11.2026 15:09',
  days: [{ title: 'Сьогодні', lines: row ? [{ row }] : [], nowMinutes }],
  ...extra,
});

function tileFills(svg, hour) {
  const start = svg.indexOf(`data-hour="${hour}"`);
  const shapeStart = svg.lastIndexOf('<', start);
  if (svg.startsWith('<rect', shapeStart)) return [svg.slice(shapeStart).match(/fill="([^"]+)"/)[1]];
  const group = svg.slice(shapeStart, svg.indexOf('</g>', shapeStart));
  return [...group.matchAll(/fill="([^"]+)"/g)].map((match) => match[1]);
}

test('it produces a real PNG, Ukrainian letters and all', () => {
  const png = renderScheduleImage(card({ row: allYes({ 12: 'no', 5: 'first', 7: 'maybe' }), nowMinutes: 600 }));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(png.length > 5000, 'a card with text is not an empty picture');
});

test('every hour is drawn with the right half hours', () => {
  const svg = buildScheduleSvg(card({ row: allYes({ 1: 'no', 2: 'first', 3: 'second', 4: 'maybe', 5: 'mfirst', 6: 'msecond' }) }));
  assert.deepEqual(tileFills(svg, 0), [OFF]);
  assert.deepEqual(tileFills(svg, 1), [OFF, ON], 'no light in the first half');
  assert.deepEqual(tileFills(svg, 2), [ON, OFF], 'no light in the second half');
  assert.deepEqual(tileFills(svg, 3), ['url(#maybe)']);
  assert.deepEqual(tileFills(svg, 4), ['url(#maybe)', ON]);
  assert.deepEqual(tileFills(svg, 5), [ON, 'url(#maybe)']);
  assert.deepEqual(tileFills(svg, 23), [ON]);
});

test('all 24 hours are labelled', () => {
  const svg = buildScheduleSvg(card({ row: allYes() }));
  for (let hour = 0; hour < 24; hour++) {
    assert.ok(svg.includes(`>${String(hour).padStart(2, '0')}</text>`), `hour ${hour}`);
  }
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
    const pill = svg.match(/<rect x="([\d.]+)" y="[\d.]+" width="104"/);
    assert.ok(Number(pill[1]) >= 48 && Number(pill[1]) + 104 <= 1032, `pill at ${nowMinutes}`);
  }
});

test('several days are drawn in order', () => {
  const svg = buildScheduleSvg({
    address: 'а', queues: 'черга 1.1', update: 'u', days: [{ title: 'Сьогодні', lines: [{ row: allYes() }] }, { title: 'Завтра', lines: [{ row: allYes() }] }],
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
    update: 'u',
    days: [{
      title: 'Сьогодні',
      nowMinutes: 600,
      lines: [{ label: 'Черга 6.2', row: allYes({ 1: 'no' }) }, { label: 'Черга 4.1', row: allYes({ 2: 'first' }) }],
    }],
  };
  const svg = buildScheduleSvg(schedule);
  assert.match(svg, /черги 6\.2, 4\.1/);
  assert.ok(svg.indexOf('Черга 6.2') < svg.indexOf('Черга 4.1'));
  assert.equal((svg.match(/data-hour="0"/g) ?? []).length, 2, 'two lines, two drawings of each hour');
  assert.equal((svg.match(/data-now=/g) ?? []).length, 2, 'the marker is on both lines');
  const ids = [...svg.matchAll(/clipPath id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'clip ids do not collide between lines');
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
