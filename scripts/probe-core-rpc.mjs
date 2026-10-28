import axios from 'file:///D:/projectradom/geminirouter/server/node_modules/axios/lib/axios.js';
import crypto from 'node:crypto';
import os from 'node:os';

const userScope = crypto
  .createHash('sha256')
  .update(os.homedir().toLowerCase())
  .digest('hex')
  .slice(0, 16);
const ENDPOINT = `\\\\.\\pipe\\antigravity-manager-core-v1-${userScope}`;

async function tryCall(proc, body) {
  try {
    const res = await axios.request({
      adapter: 'http',
      socketPath: ENDPOINT,
      baseURL: 'http://localhost',
      url: `/rpc/${proc}`,
      method: 'POST',
      data: body,
      timeout: 4000,
      headers: { 'Content-Type': 'application/json' },
    });
    return { proc, body: JSON.stringify(body), status: res.status, data: res.data };
  } catch (err) {
    return {
      proc,
      body: JSON.stringify(body),
      status: err?.response?.status ?? 'ERR',
      data: err?.response?.data ?? err?.code ?? err?.message,
    };
  }
}

// oRPC standard serializer wraps input as { json: ... }; also try plain shapes
const attempts = [
  ['ping', { json: undefined }],
  ['ping', { json: {} }],
  ['ping', {}],
  ['serviceConfig.read', { json: {} }],
  ['serviceConfig.read', {}],
  ['serviceConfig.revealSecret', { json: { name: 'api-key' } }],
  ['serviceConfig.revealSecret', { name: 'api-key' }],
];

for (const [proc, body] of attempts) {
  const r = await tryCall(proc, body);
  console.log(JSON.stringify(r).slice(0, 500));
}
