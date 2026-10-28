import axios from 'file:///D:/projectradom/geminirouter/server/node_modules/axios/lib/axios.js';
import crypto from 'node:crypto';

const home = 'D:\\projectradom\\geminirouter\\core-profile';
const scope = crypto.createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 16);
const ENDPOINT = `\\\\.\\pipe\\antigravity-manager-core-v1-${scope}`;

async function tryCall(proc, body, method = 'POST') {
  try {
    const res = await axios.request({
      adapter: 'http',
      socketPath: ENDPOINT,
      baseURL: 'http://localhost',
      url: `/rpc/${proc}`,
      method,
      data: body,
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' },
    });
    return { proc, body: JSON.stringify(body), status: res.status, data: JSON.stringify(res.data).slice(0, 220) };
  } catch (err) {
    return {
      proc,
      body: JSON.stringify(body),
      status: err?.response?.status ?? 'ERR',
      data: JSON.stringify(err?.response?.data ?? err?.code ?? err?.message).slice(0, 220),
    };
  }
}

const attempts = [
  ['ping', {}],
  ['ping', { json: {} }],
  ['accountViews', {}],
  ['accountViews', { json: {} }],
];

for (const [proc, body] of attempts) {
  console.log(JSON.stringify(await tryCall(proc, body)));
}
