// Client for the DTEK KREM shutdowns page. The site has no public API: the schedule is embedded
// in the page, and the page itself polls /ua/ajax for updates. The bot uses the same two calls
// and identifies itself honestly. If the site starts answering with a bot challenge, that is
// reported as a failure and not worked around.

const USER_AGENT = 'DtekSvetTelegramBot/1.0 (personal, non-commercial)';
const PAGE_PATH = '/ua/shutdowns';
const AJAX_PATH = '/ua/ajax';
const REQUEST_TIMEOUT_MS = 30000;

function extractObject(html, name) {
  const marker = html.match(new RegExp(`DisconSchedule\\.${name}\\s*=\\s*`));
  if (!marker) return null;
  const open = marker.index + marker[0].length;
  if (html[open] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < html.length; i++) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(open, i + 1));
    }
  }
  return null;
}

export function parsePage(html) {
  const streets = extractObject(html, 'streets');
  const csrf = html.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  if (!streets || !csrf) {
    throw new Error('На странице нет данных графика: сайт изменился или не пропустил запрос');
  }
  return { streets, csrf, fact: extractObject(html, 'fact') ?? { data: {}, update: '' } };
}

export function createDtekClient({ baseUrl = 'https://www.dtek-krem.com.ua' } = {}) {
  let session = null;

  async function loadPage() {
    const response = await fetch(baseUrl + PAGE_PATH, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Сайт ответил ${response.status}`);
    const page = parsePage(await response.text());
    const cookie = response.headers.getSetCookie()
      .map((value) => value.split(';')[0])
      .filter((value) => !value.startsWith('Domain='))
      .join('; ');
    session = { cookie, csrf: page.csrf };
    return page;
  }

  async function postOnce(fields) {
    if (!session) await loadPage();
    const response = await fetch(baseUrl + AJAX_PATH, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Cookie: session.cookie,
        'X-CSRF-Token': session.csrf,
        'X-Requested-With': 'XMLHttpRequest',
        Referer: baseUrl + PAGE_PATH,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Сайт ответил ${response.status}`);
    return JSON.parse(await response.text());
  }

  // The session cookie lives 30 minutes, so one failed post is normal: renew it and retry once.
  async function post(fields) {
    try {
      return await postOnce(fields);
    } catch {
      await loadPage();
      return postOnce(fields);
    }
  }

  return {
    loadPage,

    // New schedule if the site has something newer than `update`, otherwise null.
    async checkUpdate(update) {
      const answer = await post({ method: 'checkDisconUpdate', update });
      return answer.result && answer.fact ? answer.fact : null;
    },

    // { houseNumber: { sub_type, start_date, end_date, type, sub_type_reason: [group] } }.
    // The site uses the single key "-" when an address has no house numbers.
    async lookupHouses(city, street) {
      const answer = await post({
        method: 'getHomeNum',
        'data[0][name]': 'city',
        'data[0][value]': city,
        'data[1][name]': 'street',
        'data[1][value]': street,
        'data[2][name]': 'house_num',
        'data[2][value]': '',
      });
      return answer.result ? answer.data ?? {} : {};
    },
  };
}
