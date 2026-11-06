import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  createXiaomiClient, decryptBody, encryptParams, rc4, signNonce, XiaomiAuthError,
} from '../src/xiaomi.js';

// Reference values from an independent Python port of the signing code in
// PiotrMachowski/Xiaomi-cloud-tokens-extractor, with its own pure Python RC4.
const REFERENCE = {
  url: 'https://de.api.io.mi.com/app/v2/homeroom/gethome',
  ssecurity: 'c2VjdXJpdHktc2VjcmV0MQ==',
  nonce: 'AAECAwQFBgcICQoL',
  data: '{"fg":true,"limit":300}',
  signedNonce: 'tFHiff0jQb0+6/sn+obOf3zqVR02UB8vJJW9tuc38F0=',
  fields: {
    data: 'yaSXgd5Zo3iXcGGRySrwdj3hh2wpuT8=',
    rc4_hash__: '5eqbhIw7sCW3WCne0WjHSTOiyhlWxjI/r8Vb9g==',
    signature: 'gjgKQ98Mdv6/SVDGt21MbJ+GCfI=',
    ssecurity: 'c2VjdXJpdHktc2VjcmV0MQ==',
    _nonce: 'AAECAwQFBgcICQoL',
  },
  responseCipher: 'yaSSiZgG9TDCJWGThzH4bDyvyX0jqTl28P5FrpndhzA+s6AMDRCJr4sVd80UEueKyWjTjG3kVqMKeMYnqUg9lbpS',
  responsePlain: { code: 0, result: { homelist: [{ id: 7, name: 'Дім' }] } },
};

test('signing and encryption match the independent implementation', () => {
  const { url, ssecurity, nonce, data, signedNonce, fields } = REFERENCE;
  assert.equal(signNonce(ssecurity, nonce), signedNonce);
  assert.deepEqual(encryptParams(url, nonce, ssecurity, { data }), fields);
});

test('a response from Xiaomi is decrypted, including Cyrillic names', () => {
  const { responseCipher, nonce, ssecurity, responsePlain } = REFERENCE;
  assert.deepEqual(decryptBody(responseCipher, nonce, ssecurity), responsePlain);
});

const SESSION = { userId: 42, ssecurity: REFERENCE.ssecurity, serviceToken: 'service/token+1=' };

// Local stand-in for the Xiaomi cloud: reads requests the way the real one must and answers encrypted.
async function withFakeCloud(handler, run) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    const [, region] = url.pathname.split('/');
    const path = url.pathname.split('/app')[1];
    const nonce = url.searchParams.get('_nonce');
    const ssecurity = url.searchParams.get('ssecurity');
    const key = signNonce(ssecurity, nonce);
    const data = rc4(key, Buffer.from(url.searchParams.get('data'), 'base64')).toString('utf8');
    requests.push({ region, path, data, cookie: req.headers.cookie, agent: req.headers['user-agent'] });
    const answer = handler(region, path, data);
    if (typeof answer === 'number') {
      res.statusCode = answer;
      res.end('{}');
      return;
    }
    res.end(answer.plain ? JSON.stringify(answer.plain) : rc4(key, Buffer.from(JSON.stringify(answer))).toString('base64'));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const urlForServer = (region) => `http://127.0.0.1:${server.address().port}/${region}/com/app`;
  try {
    await run(createXiaomiClient(SESSION, { urlForServer }), requests);
  } finally {
    server.close();
  }
}

const RAW_DEVICE = {
  did: 'd1', name: 'Шлюз', model: 'lumi.gateway', isOnline: true, token: 'device-secret', mac: 'AA:BB', localip: '10.0.0.5',
};

function homeInRegion(wanted, devices = [RAW_DEVICE]) {
  return (region, path) => {
    if (path === '/v2/homeroom/gethome') return { code: 0, result: { homelist: region === wanted ? [{ id: 7 }] : [] } };
    if (path === '/v2/user/get_device_cnt') return { code: 0, result: { share: { share_family: [] } } };
    return { code: 0, result: { device_info: devices } };
  };
}

test('devices are found in any region, and later checks ask only that region', async () => {
  await withFakeCloud(homeInRegion('ru'), async (client, requests) => {
    const devices = await client.listDevices();
    assert.deepEqual(devices, [{ id: 'd1', name: 'Шлюз', model: 'lumi.gateway', online: true }]);
    assert.ok(new Set(requests.map((request) => request.region)).size > 1, 'all regions were tried');
    const list = requests.find((request) => request.path === '/v2/home/home_device_list');
    assert.equal(list.data, '{"home_owner":42,"home_id":7,"limit":200,"get_split_device":true,"support_smart_home":true}');
    assert.match(list.cookie, /serviceToken=service\/token\+1=/);
    assert.match(list.cookie, /userId=42/);
    assert.match(list.agent, /^DtekSvetBot/, 'the client does not pose as the Xiaomi app');
    requests.length = 0;
    await client.listDevices();
    assert.deepEqual([...new Set(requests.map((request) => request.region))], ['ru']);
  });
});

test('the device token, MAC and IP are dropped right away', async () => {
  await withFakeCloud(homeInRegion('de'), async (client) => {
    const text = JSON.stringify(await client.listDevices());
    assert.doesNotMatch(text, /device-secret|AA:BB|10\.0\.0\.5/);
  });
});

test('an offline device reads as offline', async () => {
  await withFakeCloud(homeInRegion('de', [{ ...RAW_DEVICE, isOnline: false }]), async (client) => {
    assert.equal((await client.listDevices())[0].online, false);
  });
});

test('homes shared from another account are included', async () => {
  const handler = (region, path, data) => {
    if (path === '/v2/homeroom/gethome') return { code: 0, result: { homelist: [] } };
    if (path === '/v2/user/get_device_cnt') {
      return { code: 0, result: { share: { share_family: region === 'de' ? [{ home_id: 9, home_owner: 77 }] : [] } } };
    }
    assert.match(data, /"home_owner":77,"home_id":9/);
    return { code: 0, result: { device_info: [RAW_DEVICE] } };
  };
  await withFakeCloud(handler, async (client) => {
    assert.equal((await client.listDevices()).length, 1);
  });
});

test('a broken region does not hide devices in another', async () => {
  const healthy = homeInRegion('de');
  await withFakeCloud((region, path, data) => (region === 'cn' ? 500 : healthy(region, path, data)), async (client) => {
    assert.equal((await client.listDevices()).length, 1);
  });
});

test('a rejected session is reported as such and not retried across regions', async () => {
  await withFakeCloud(() => 401, async (client, requests) => {
    await assert.rejects(client.listDevices(), XiaomiAuthError);
    assert.equal(requests.length, 1);
  });
});

test('total failure is an error, never an empty list that looks like "no devices"', async () => {
  await withFakeCloud(() => 500, async (client) => {
    await assert.rejects(client.listDevices(), /Xiaomi ответил 500/);
  });
});

test('an unencrypted error from Xiaomi is understood', async () => {
  await withFakeCloud(() => ({ plain: { code: 3, message: 'auth err' } }), async (client) => {
    await assert.rejects(client.listDevices(), /auth err/);
  });
});

test('an account with no devices is an empty list', async () => {
  await withFakeCloud(homeInRegion('none'), async (client) => {
    assert.deepEqual(await client.listDevices(), []);
  });
});
