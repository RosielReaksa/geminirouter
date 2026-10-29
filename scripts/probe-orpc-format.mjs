import axios from 'file:///D:/projectradom/geminirouter/server/node_modules/axios/lib/axios.js';
import crypto from 'node:crypto';

import fs from 'node:fs';

const pipes = fs.readdirSync('//./pipe/').filter((p) => p.startsWith('antigravity-manager-core-v1-'));
const activePipe = pipes.find((p) => !p.includes('2a014b31fabdb803')) || pipes[0];
const ENDPOINT = `\\\\.\\pipe\\${activePipe}`;

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
    return { proc, status: res.status, data: JSON.stringify(res.data).slice(0, 220) };
  } catch (err) {
    return {
      proc,
      status: err?.response?.status ?? 'ERR',
      data: JSON.stringify(err?.response?.data ?? err?.code ?? err?.message).slice(0, 220),
    };
  }
}

const attempts = [
  ['accountValidationUrl', { json: { accountId: '7a3584d3-de62-4024-8418-3d61140613cf' } }],
  ['accountViews', { json: {} }],
];

for (const [proc, body] of attempts) {
  console.log(JSON.stringify(await tryCall(proc, body)));
}
