import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createDtekClient, parsePage } from '../src/dtek.js';

// Local stand-in for the site: hands out numbered sessions and only honours the newest one.
async function withFakeSite(run, { challenge = false } = {}) {
  const calls = { pages: 0, posts: [] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.method === 'GET') {
        calls.pages++;
        res.setHeader('Set-Cookie', [`sid=s${calls.pages}; path=/; HttpOnly`, 'Domain=example.test; HttpOnly']);
        res.end(challenge
          ? '<html>Incapsula incident</html>'
          : `<meta name="csrf-token" content="t${calls.pages}"><script>DisconSchedule.streets = {"с. А":["вул. Б"]}
DisconSchedule.fact = {"data":{},"update":"u${calls.pages}"}</script>`);
        return;
      }
      const fields = new URLSearchParams(body);
      calls.posts.push({ cookie: req.headers.cookie, csrf: req.headers['x-csrf-token'], fields });
      if (req.headers.cookie !== `sid=s${calls.expiredOnce ? 2 : 1}` || req.headers['x-csrf-token'] !== `t${calls.expiredOnce ? 2 : 1}`) {
        res.statusCode = 400;
        res.end('Bad Request');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      if (fields.get('method') === 'checkDisconUpdate') {
        res.end(JSON.stringify(fields.get('update') === 'current' ? { result: false } : { result: true, fact: { data: {}, update: 'current' } }));
      } else {
        res.end(JSON.stringify({ result: true, data: { 12: { sub_type_reason: ['GPV1.1'] } } }));
      }
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    await run(createDtekClient({ baseUrl: `http://127.0.0.1:${server.address().port}` }), calls);
  } finally {
    server.close();
  }
}

test('update check returns null when nothing is new and the schedule when something is', async () => {
  await withFakeSite(async (client, calls) => {
    await client.loadPage();
    assert.equal(await client.checkUpdate('current'), null);
    assert.equal((await client.checkUpdate('old')).update, 'current');
    assert.equal(calls.pages, 1, 'a check does not reload the page');
    assert.equal(calls.posts[0].cookie, 'sid=s1', 'the odd Domain=... header is not sent back as a cookie');
  });
});

test('address lookup sends the fields the site requires', async () => {
  await withFakeSite(async (client, calls) => {
    const houses = await client.lookupHouses('с. А', 'вул. Б');
    assert.deepEqual(houses['12'].sub_type_reason, ['GPV1.1']);
    const { fields } = calls.posts[0];
    assert.equal(fields.get('method'), 'getHomeNum');
    assert.equal(fields.get('data[0][value]'), 'с. А');
    assert.equal(fields.get('data[1][value]'), 'вул. Б');
    assert.equal(fields.get('data[2][name]'), 'house_num');
  });
});

test('an expired session is renewed and the request repeated once', async () => {
  await withFakeSite(async (client, calls) => {
    await client.loadPage();
    calls.expiredOnce = true;
    assert.equal(await client.checkUpdate('current'), null);
    assert.equal(calls.pages, 2);
    assert.equal(calls.posts.at(-1).csrf, 't2');
  });
});

test('a bot challenge surfaces as a failure, not as empty data', async () => {
  await withFakeSite(async (client) => {
    await assert.rejects(client.checkUpdate('current'), /нет данных графика/);
  }, { challenge: true });
});

const PAGE = `<html><head><meta name="csrf-token" content="abc=="></head><body>
<script>DisconSchedule.streets = {"с. Гатне":["вул. \\"Лісова\\" {стара}","пров. Шляхова"]}
DisconSchedule.preset = {"time_type":{"yes":"Світло є"}}
DisconSchedule.fact = {"data":{"1793916000":{"GPV1.1":{"1":"no"}}},"update":"06.11.2026 12:18","today":1793916000}</script>
<script src="/_Incapsula_Resource"></script></body></html>`;

test('reads the schedule, streets and token out of the page, even with braces and quotes in names', () => {
  const page = parsePage(PAGE);
  assert.equal(page.csrf, 'abc==');
  assert.equal(page.fact.update, '06.11.2026 12:18');
  assert.equal(page.fact.data['1793916000']['GPV1.1']['1'], 'no');
  assert.deepEqual(page.streets['с. Гатне'], ['вул. "Лісова" {стара}', 'пров. Шляхова']);
});

test('a page without the schedule block is an error, so a bot challenge is never taken for "no outages"', () => {
  assert.throws(() => parsePage('<html><body>Request unsuccessful. Incapsula incident ID: 1</body></html>'), /нет данных графика/);
});

test('no published schedule at all is valid and means empty data', () => {
  const page = parsePage('<meta name="csrf-token" content="t"><script>DisconSchedule.streets = {"с. А":[""]}</script>');
  assert.deepEqual(page.fact, { data: {}, update: '' });
});
