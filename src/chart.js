// Draws the schedule as a picture: an SVG card turned into a PNG, with the font shipped in
// assets/ so that it looks the same on any server. Each hour is a tile of two half hours.

import { readFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { formatDuration, rowStates, summarizeDay } from './schedule.js';

const FONT_FILES = ['Inter_500Medium.ttf', 'Inter_700Bold.ttf'];
const fonts = FONT_FILES.map((name) => readFileSync(new URL(`../assets/fonts/${name}`, import.meta.url)));

const COLORS = {
  background: '#FFFFFF', text: '#1C2033', muted: '#6B7085', line: '#E6E8F0', on: '#FFD23F', off: '#2A2E45', now: '#E5484D',
};
const FILLS = { on: COLORS.on, off: COLORS.off, maybe: 'url(#maybe)' };

const WIDTH = 1080;
const MARGIN = 48;
const GAP = 6;
const TILE_WIDTH = (WIDTH - 2 * MARGIN - 11 * GAP) / 12;
const TILE_HEIGHT = 84;
const RADIUS = 14;
const MARKER_SPACE = 44;
const LABEL_SPACE = 36;
const MAX_ADDRESS_LENGTH = 48;

const escapeXml = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const tileX = (column) => MARGIN + column * (TILE_WIDTH + GAP);

const text = (x, y, content, { size = 30, color = COLORS.text, weight = 500, anchor = 'start' } = {}) => (
  `<text x="${x}" y="${y}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${escapeXml(content)}</text>`
);

function renderHours(states, firstHour, top, clipPrefix) {
  const parts = [];
  for (let column = 0; column < 12; column++) {
    const hour = firstHour + column;
    const x = tileX(column);
    const first = states[hour * 2];
    const second = states[hour * 2 + 1];
    if (first === second) {
      // One shape: two touching rectangles would leave a faint seam in the middle of the hour.
      parts.push(`<rect x="${x}" y="${top}" width="${TILE_WIDTH}" height="${TILE_HEIGHT}" rx="${RADIUS}" fill="${FILLS[first]}" data-hour="${hour}"/>`);
    } else {
      const id = `${clipPrefix}-${hour}`;
      parts.push(
        `<clipPath id="${id}"><rect x="${x}" y="${top}" width="${TILE_WIDTH}" height="${TILE_HEIGHT}" rx="${RADIUS}"/></clipPath>`,
        `<g clip-path="url(#${id})" data-hour="${hour}">`,
        `<rect x="${x}" y="${top}" width="${TILE_WIDTH / 2}" height="${TILE_HEIGHT}" fill="${FILLS[first]}"/>`,
        `<rect x="${x + TILE_WIDTH / 2}" y="${top}" width="${TILE_WIDTH / 2}" height="${TILE_HEIGHT}" fill="${FILLS[second]}"/>`,
        '</g>',
      );
    }
    parts.push(text(x + TILE_WIDTH / 2, top + TILE_HEIGHT + 30, String(hour).padStart(2, '0'), { size: 24, color: COLORS.muted, anchor: 'middle' }));
  }
  return parts.join('');
}

function renderNowMarker(minutes, rowTops) {
  const row = minutes < 720 ? 0 : 1;
  const inRow = minutes - row * 720;
  const column = Math.floor(inRow / 60);
  const x = tileX(column) + (inRow % 60) / 60 * TILE_WIDTH;
  const top = rowTops[row];
  const pillWidth = 104;
  const pillX = Math.min(Math.max(MARGIN, x - pillWidth / 2), WIDTH - MARGIN - pillWidth);
  return [
    `<rect x="${x - 3}" y="${top - 8}" width="6" height="${TILE_HEIGHT + 16}" rx="3" fill="${COLORS.now}" stroke="${COLORS.background}" stroke-width="2" data-now="${minutes}"/>`,
    `<rect x="${pillX}" y="${top - 42}" width="${pillWidth}" height="34" rx="17" fill="${COLORS.now}"/>`,
    text(pillX + pillWidth / 2, top - 17, 'зараз', { size: 24, color: '#FFFFFF', weight: 700, anchor: 'middle' }),
  ].join('');
}

function renderLegendItem(x, y, fill, label, value) {
  return [
    `<rect x="${x}" y="${y - 28}" width="34" height="34" rx="9" fill="${fill}"/>`,
    `<text x="${x + 48}" y="${y}" font-family="Inter" font-size="32" fill="${COLORS.text}" font-weight="500">${escapeXml(label)} <tspan font-weight="700">${escapeXml(value)}</tspan></text>`,
  ].join('');
}

// Returns the drawing of one day and the height it takes.
function renderDay(day, top, index) {
  if (!day.row) {
    return {
      height: 112,
      svg: [
        text(MARGIN, top + 44, day.title, { size: 42, weight: 700 }),
        text(MARGIN, top + 90, 'Графіка ще немає', { size: 32, color: COLORS.muted }),
      ].join(''),
    };
  }
  const states = rowStates(day.row);
  const { totals } = summarizeDay(day.row);
  const firstRow = top + 62 + MARKER_SPACE;
  const secondRow = firstRow + TILE_HEIGHT + LABEL_SPACE + MARKER_SPACE;
  const legendY = secondRow + TILE_HEIGHT + LABEL_SPACE + 58;
  const parts = [
    text(MARGIN, top + 44, day.title, { size: 42, weight: 700 }),
    renderHours(states, 0, firstRow, `d${index}a`),
    renderHours(states, 12, secondRow, `d${index}b`),
    day.nowMinutes === undefined ? '' : renderNowMarker(day.nowMinutes, [firstRow, secondRow]),
    renderLegendItem(MARGIN, legendY, COLORS.on, 'Світло', formatDuration(totals.on)),
    renderLegendItem(WIDTH / 2 - 20, legendY, COLORS.off, 'Без світла', formatDuration(totals.off)),
  ];
  let height = legendY + 18 - top;
  if (totals.maybe) {
    parts.push(renderLegendItem(MARGIN, legendY + 54, FILLS.maybe, 'Можливо без світла', formatDuration(totals.maybe)));
    height += 54;
  }
  return { height, svg: parts.join('') };
}

// days: [{ title, row, nowMinutes }]. row is missing when no schedule is published;
// nowMinutes, minutes since midnight, is set only for today.
export function buildScheduleSvg({ address, group, days, update }) {
  const label = address.length > MAX_ADDRESS_LENGTH ? `${address.slice(0, MAX_ADDRESS_LENGTH - 1)}…` : address;
  const parts = [text(MARGIN, 66, `${label} · черга ${group}`, { size: 30, color: COLORS.muted })];
  let top = 98;
  days.forEach((day, index) => {
    if (index > 0) {
      parts.push(`<rect x="${MARGIN}" y="${top}" width="${WIDTH - 2 * MARGIN}" height="2" fill="${COLORS.line}"/>`);
      top += 28;
    }
    const drawn = renderDay(day, top, index);
    parts.push(drawn.svg);
    top += drawn.height + 28;
  });
  parts.push(text(MARGIN, top + 28, `Оновлено на сайті: ${update || 'немає даних'}`, { size: 26, color: COLORS.muted }));
  const height = top + 60;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">`,
    '<defs><pattern id="maybe" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">',
    `<rect width="16" height="16" fill="${COLORS.on}"/><rect width="8" height="16" fill="${COLORS.off}"/></pattern></defs>`,
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
