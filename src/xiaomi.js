// Client for the Xiaomi Home cloud, used only to read whether devices are online.
// Xiaomi has no public API for this. The calls follow the community tool
// PiotrMachowski/Xiaomi-cloud-tokens-extractor, so they can stop working without notice.
// Login is by QR code: the account password never reaches this program.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const USER_AGENT = 'DtekSvetBot/1.0 (personal, non-commercial)';
const SERVERS = ['de', 'ru', 'us', 'sg', 'i2', 'in', 'tw', 'cn'];
const LOGIN_URL = 'https://account.xiaomi.com/longPolling/loginUrl';
const RESPONSE_PREFIX = '&&&START&&&';
const LONG_POLL_MS = 10000;
const REQUEST_TIMEOUT_MS = 30000;

export class XiaomiAuthError extends Error {}

export const SESSION_FILE = 'data/xiaomi-session.json';

export function loadSession() {
  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// RC4 with the first 1024 bytes of the keystream dropped, as the Xiaomi API expects.
// Written out because OpenSSL 3 no longer enables RC4 in Node by default.
export function rc4(keyBase64, input) {
  const key = Buffer.from(keyBase64, 'base64');
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
  }
  let a = 0;
  let b = 0;
  const nextByte = () => {
    a = (a + 1) & 255;
    b = (b + state[a]) & 255;
    [state[a], state[b]] = [state[b], state[a]];
    return state[(state[a] + state[b]) & 255];
  };
  for (let i = 0; i < 1024; i++) nextByte();
  return Buffer.from(input.map((byte) => byte ^ nextByte()));
}

export function signNonce(ssecurity, nonce) {
  return createHash('sha256')
    .update(Buffer.from(ssecurity, 'base64'))
    .update(Buffer.from(nonce, 'base64'))
    .digest('base64');
}

function createNonce(nowMs) {
  const minutes = Buffer.alloc(4);
  minutes.writeUInt32BE(Math.floor(nowMs / 60000));
  return Buffer.concat([randomBytes(8), minutes]).toString('base64');
}

function signParams(url, signedNonce, params) {
  const path = url.split('com')[1].replace('/app/', '/');
  const parts = ['POST', path, ...Object.entries(params).map(([key, value]) => `${key}=${value}`), signedNonce];
  return createHash('sha1').update(parts.join('&')).digest('base64');
}

export function encryptParams(url, nonce, ssecurity, plain) {
  const signedNonce = signNonce(ssecurity, nonce);
  const withHash = { ...plain, rc4_hash__: signParams(url, signedNonce, plain) };
  const encrypted = Object.fromEntries(Object.entries(withHash).map(([key, value]) => (
    [key, rc4(signedNonce, Buffer.from(value)).toString('base64')]
  )));
  return { ...encrypted, signature: signParams(url, signedNonce, encrypted), ssecurity, _nonce: nonce };
}

export function decryptBody(text, nonce, ssecurity) {
  return JSON.parse(rc4(signNonce(ssecurity, nonce), Buffer.from(text, 'base64')).toString('utf8'));
}

const parseAccountResponse = (text) => JSON.parse(text.replace(RESPONSE_PREFIX, ''));

async function fetchServiceToken(location) {
  let url = location;
  for (let hop = 0; hop < 5 && url; hop++) {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith('serviceToken='));
    if (cookie) return cookie.split(';')[0].slice('serviceToken='.length);
    url = response.headers.get('location');
  }
  throw new XiaomiAuthError('Xiaomi не выдал токен после входа');
}

// Returns the QR code to show the user and a function that waits until they confirm the login.
export async function startQrLogin() {
  const query = new URLSearchParams({
    _qrsize: '480',
    qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
    callback: 'https://sts.api.io.mi.com/sts',
    _hasLogo: 'false',
    sid: 'xiaomiio',
    serviceParam: '',
    _locale: 'en_GB',
    _dc: String(Date.now()),
  });
  const response = await fetch(`${LOGIN_URL}?${query}`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Xiaomi ответил ${response.status}`);
  const login = parseAccountResponse(await response.text());
  if (!login.qr || !login.lp) throw new Error('Xiaomi не выдал QR-код');

  async function waitForConfirmation() {
    const deadline = Date.now() + login.timeout * 1000;
    while (Date.now() < deadline) {
      let poll;
      try {
        poll = await fetch(login.lp, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(LONG_POLL_MS) });
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        continue;
      }
      if (!poll.ok) {
        await sleep(2000);
        continue;
      }
      const confirmed = parseAccountResponse(await poll.text());
      if (!confirmed.location || !confirmed.ssecurity) throw new XiaomiAuthError('Вход через QR-код не подтверждён');
      return {
        userId: confirmed.userId,
        ssecurity: confirmed.ssecurity,
        serviceToken: await fetchServiceToken(confirmed.location),
      };
    }
    throw new XiaomiAuthError('QR-код устарел, запустите вход ещё раз');
  }

  return { qrUrl: login.qr, loginUrl: login.loginUrl, waitForConfirmation };
}

const apiUrl = (server) => `https://${server === 'cn' ? '' : `${server}.`}api.io.mi.com/app`;

export function createXiaomiClient(session, { urlForServer = apiUrl, now = Date.now } = {}) {
  let servers = null;

  async function call(server, path, data) {
    const url = `${urlForServer(server)}${path}`;
    const nonce = createNonce(now());
    const fields = encryptParams(url, nonce, session.ssecurity, { data });
    const response = await fetch(`${url}?${new URLSearchParams(fields)}`, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept-Encoding': 'identity',
        'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
        'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4',
        Cookie: `userId=${session.userId}; yetAnotherServiceToken=${session.serviceToken}; serviceToken=${session.serviceToken}; locale=en_GB`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      throw new XiaomiAuthError(`Xiaomi отклонил сессию (${response.status})`);
    }
    if (!response.ok) throw new Error(`Xiaomi ответил ${response.status}`);
    const text = await response.text();
    const answer = text.trimStart().startsWith('{') ? JSON.parse(text) : decryptBody(text, nonce, session.ssecurity);
    if (!answer.result) throw new Error(`Xiaomi вернул ошибку: ${answer.code} ${answer.message ?? ''}`);
    return answer.result;
  }

  async function homesOn(server) {
    const owned = await call(server, '/v2/homeroom/gethome', '{"fg":true,"fetch_share":true,"fetch_share_dev":true,"limit":300,"app_ver":7}');
    const shared = await call(server, '/v2/user/get_device_cnt', '{"fetch_own":true,"fetch_share":true}');
    return [
      ...(owned.homelist ?? []).map((home) => ({ id: home.id, owner: session.userId })),
      ...(shared.share?.share_family ?? []).map((home) => ({ id: home.home_id, owner: home.home_owner })),
    ];
  }

  // Only the fields needed here are kept: the raw record also holds the device token, MAC and IP.
  async function devicesOn(server) {
    const devices = [];
    for (const home of await homesOn(server)) {
      const result = await call(server, '/v2/home/home_device_list', `{"home_owner":${home.owner},"home_id":${home.id},"limit":200,"get_split_device":true,"support_smart_home":true}`);
      for (const device of result.device_info ?? []) {
        devices.push({ id: device.did, name: device.name, model: device.model, online: Boolean(device.isOnline) });
      }
    }
    return devices;
  }

  return {
    // The first call looks through all regions, later calls ask only those that had devices.
    async listDevices() {
      if (servers) return (await Promise.all(servers.map(devicesOn))).flat();
      const found = [];
      let lastError = null;
      for (const server of SERVERS) {
        try {
          const devices = await devicesOn(server);
          if (devices.length) found.push({ server, devices });
        } catch (error) {
          if (error instanceof XiaomiAuthError) throw error;
          lastError = error;
        }
      }
      if (!found.length && lastError) throw lastError;
      if (found.length) servers = found.map((item) => item.server);
      return found.flatMap((item) => item.devices);
    },
  };
}
