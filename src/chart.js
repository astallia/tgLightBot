// Draws the schedule as a picture: an SVG card turned into a PNG, with the font shipped in
// assets/ so that it looks the same on any server.
//
// Telegram shows this 1080px card about three times smaller on a phone, so sizes are chosen for
// that: bars of about 22px, axis text of about 10px. Each row is a real time axis: stretches of the
// same state are one bar, thin gaps mark the hours, and every bar is labelled where it starts and
// ends, so nobody has to count hours from the nearest mark.

import { readFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { formatDuration, rowStates, summarizeDay } from './schedule.js';

const FONT_FILES = ['Inter_500Medium.ttf', 'Inter_700Bold.ttf'];
const fonts = FONT_FILES.map((name) => readFileSync(new URL(`../assets/fonts/${name}`, import.meta.url)));

const COLORS = {
  background: '#FFFFFF', text: '#1C2033', muted: '#5F6478', tick: '#9AA0B8', on: '#F2A900', off: '#2A2E45', maybe: '#9AA0B8', now: '#E5484D',
};
const FILLS = { on: COLORS.on, off: COLORS.off, maybe: COLORS.maybe };

const WIDTH = 1080;
const MARGIN = 48;
const ROW_WIDTH = WIDTH - 2 * MARGIN;
const HALVES_PER_ROW = 24;
const HALF_WIDTH = ROW_WIDTH / HALVES_PER_ROW;
const BAR_HEIGHT = 68;
const RADIUS = 12;
const STATE_GAP = 6;
const HOUR_GAP = 3;
const TICK_HEIGHT = 12;
// One hour of the row is 82px: with these, the labels of an hour-long bar still fit side by side.
const LABEL_WIDTH = 76;
const LABEL_GAP = 6;
const LABEL_HEIGHT = 42;
const MARKER_SPACE = 56;
const ROW_SPACE = 18;
const PILL_WIDTH = 116;
const MAX_ADDRESS_LENGTH = 44;

const escapeXml = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const text = (x, y, content, { size = 30, color = COLORS.text, weight = 500, anchor = 'start' } = {}) => (
  `<text x="${x}" y="${y}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${escapeXml(content)}</text>`
);

const xOfHalf = (half) => MARGIN + half * HALF_WIDTH;

function clockAtHalf(half) {
  const hours = String(Math.floor(half / 2)).padStart(2, '0');
  return `${hours}:${half % 2 ? '30' : '00'}`;
}

// A label for each edge of a bar and for both ends of the row. Edges can be half an hour apart,
// closer than a label is wide, so labels that would touch move down a level. None is ever dropped.
function placeEdgeLabels(states, firstHalf) {
  const edges = [0];
  for (let half = 1; half < HALVES_PER_ROW; half++) {
    if (states[firstHalf + half] !== states[firstHalf + half - 1]) edges.push(half);
  }
  edges.push(HALVES_PER_ROW);

  const levelEnds = [];
  return edges.map((half) => {
    const x = xOfHalf(half);
    const left = x - LABEL_WIDTH / 2;
    let level = levelEnds.findIndex((end) => left >= end + LABEL_GAP);
    if (level < 0) level = levelEnds.length;
    levelEnds[level] = left + LABEL_WIDTH;
    return { half, x, left, level, clock: clockAtHalf(firstHalf + half) };
  });
}

const axisHeight = (labels) => TICK_HEIGHT + (Math.max(...labels.map((label) => label.level)) + 1) * LABEL_HEIGHT + 6;

// One row of twelve hours. firstHalf is the half hour of the day the row starts at.
function renderRow(states, firstHalf, top, labels) {
  const parts = [];
  const xOf = xOfHalf;
  let start = 0;
  for (let half = 1; half <= HALVES_PER_ROW; half++) {
    if (half < HALVES_PER_ROW && states[firstHalf + half] === states[firstHalf + start]) continue;
    const left = xOf(start) + (start ? STATE_GAP / 2 : 0);
    const right = xOf(half) - (half < HALVES_PER_ROW ? STATE_GAP / 2 : 0);
    parts.push(`<rect x="${left}" y="${top}" width="${right - left}" height="${BAR_HEIGHT}" rx="${RADIUS}" fill="${FILLS[states[firstHalf + start]]}" data-from="${firstHalf + start}" data-to="${firstHalf + half}"/>`);
    start = half;
  }
  for (let hour = 1; hour < 12; hour++) {
    parts.push(`<rect x="${xOf(hour * 2) - HOUR_GAP / 2}" y="${top}" width="${HOUR_GAP}" height="${BAR_HEIGHT}" fill="${COLORS.background}"/>`);
  }
  // Every tick goes first, so a long one from a lower level passes behind the labels above it.
  const barBottom = top + BAR_HEIGHT;
  for (const { x, level } of labels) {
    parts.push(`<rect x="${x - 1}" y="${barBottom + 4}" width="2" height="${TICK_HEIGHT - 4 + level * LABEL_HEIGHT}" fill="${COLORS.tick}"/>`);
  }
  for (const { left, level, clock } of labels) {
    const baseline = barBottom + TICK_HEIGHT + 30 + level * LABEL_HEIGHT;
    parts.push(
      `<rect x="${left - 2}" y="${baseline - 28}" width="${LABEL_WIDTH + 4}" height="36" fill="${COLORS.background}"/>`,
      text(left + LABEL_WIDTH / 2, baseline, clock, { size: 30, weight: 700, anchor: 'middle' }),
    );
  }
  return parts.join('');
}

function renderNowMarker(minutes, rowTops) {
  const row = minutes < 720 ? 0 : 1;
  const x = MARGIN + (minutes - row * 720) / 720 * ROW_WIDTH;
  const top = rowTops[row];
  const pillX = Math.min(Math.max(MARGIN, x - PILL_WIDTH / 2), WIDTH - MARGIN - PILL_WIDTH);
  return [
    `<rect x="${x - 3}" y="${top - 10}" width="6" height="${BAR_HEIGHT + 20}" rx="3" fill="${COLORS.now}" stroke="${COLORS.background}" stroke-width="2" data-now="${minutes}"/>`,
    `<rect x="${pillX}" y="${top - 52}" width="${PILL_WIDTH}" height="40" rx="20" fill="${COLORS.now}" data-pill="true"/>`,
    text(pillX + PILL_WIDTH / 2, top - 21, 'зараз', { size: 28, color: '#FFFFFF', weight: 700, anchor: 'middle' }),
  ].join('');
}

function renderLegendItem(x, y, fill, label, value) {
  return [
    `<rect x="${x}" y="${y - 30}" width="36" height="36" rx="9" fill="${fill}"/>`,
    `<text x="${x + 50}" y="${y}" font-family="Inter" font-size="36" fill="${COLORS.text}" font-weight="500">${escapeXml(label)} <tspan font-weight="700">${escapeXml(value)}</tspan></text>`,
  ].join('');
}

// One line of the house: its name when there are several, two rows of hours and the totals.
function renderLine(line, nowMinutes, top) {
  const parts = [];
  let cursor = top;
  if (line.label) {
    parts.push(text(MARGIN, cursor + 38, line.label, { size: 36, weight: 700 }));
    cursor += 50;
  }
  const states = rowStates(line.row);
  const { totals } = summarizeDay(line.row);
  const hasNow = nowMinutes !== undefined;
  const firstLabels = placeEdgeLabels(states, 0);
  const secondLabels = placeEdgeLabels(states, HALVES_PER_ROW);
  // Room for the "now" label is kept only above the row it falls in.
  const firstRow = cursor + (hasNow && nowMinutes < 720 ? MARKER_SPACE : ROW_SPACE);
  const secondRow = firstRow + BAR_HEIGHT + axisHeight(firstLabels) + (hasNow && nowMinutes >= 720 ? MARKER_SPACE : ROW_SPACE);
  const legendY = secondRow + BAR_HEIGHT + axisHeight(secondLabels) + 50;
  parts.push(
    renderRow(states, 0, firstRow, firstLabels),
    renderRow(states, HALVES_PER_ROW, secondRow, secondLabels),
    hasNow ? renderNowMarker(nowMinutes, [firstRow, secondRow]) : '',
    renderLegendItem(MARGIN, legendY, COLORS.on, 'Світло', formatDuration(totals.on)),
    renderLegendItem(WIDTH / 2 - 44, legendY, COLORS.off, 'Без світла', formatDuration(totals.off)),
  );
  let height = legendY + 14 - top;
  if (totals.maybe) {
    parts.push(renderLegendItem(MARGIN, legendY + 58, COLORS.maybe, 'Можливо без світла', formatDuration(totals.maybe)));
    height += 58;
  }
  return { height, svg: parts.join('') };
}

// Returns the drawing of one day and the height it takes.
function renderDay(day, top) {
  const parts = [text(MARGIN, top + 50, day.title, { size: 48, weight: 700 })];
  let cursor = top + 66;
  for (const line of day.lines) {
    const drawn = renderLine(line, day.nowMinutes, cursor);
    parts.push(drawn.svg);
    cursor += drawn.height + 26;
  }
  return { height: cursor - 26 - top, svg: parts.join('') };
}

// days: [{ title, lines: [{ label, row }], nowMinutes }]. label is set only when the house has
// several lines; nowMinutes, minutes since midnight, is set only for today.
// address is given only when it is needed to tell addresses apart.
export function buildScheduleSvg({ address, queues, days }) {
  const parts = [];
  let top = 24;
  if (address) {
    const label = address.length > MAX_ADDRESS_LENGTH ? `${address.slice(0, MAX_ADDRESS_LENGTH - 1)}…` : address;
    parts.push(text(MARGIN, 66, `${label} · ${queues}`, { size: 30, color: COLORS.muted }));
    top = 98;
  }
  days.forEach((day, index) => {
    if (index > 0) {
      parts.push(`<rect x="${MARGIN}" y="${top}" width="${ROW_WIDTH}" height="2" fill="${COLORS.tick}"/>`);
      top += 28;
    }
    const drawn = renderDay(day, top);
    parts.push(drawn.svg);
    top += drawn.height + 28;
  });
  const height = top + 4;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">`,
    `<rect width="${WIDTH}" height="${height}" fill="${COLORS.background}"/>`,
    ...parts,
    '</svg>',
  ].join('');
}

export function renderScheduleImage(schedule) {
  const image = new Resvg(buildScheduleSvg(schedule), {
    font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: 'Inter' },
  });
  return image.render().asPng();
}
