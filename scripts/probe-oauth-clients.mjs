import axios from 'file:///D:/projectradom/geminirouter/server/node_modules/axios/lib/axios.js';
import crypto from 'node:crypto';

const home = 'D:\\projectradom\\geminirouter\\core-profile';
const scope = crypto.createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 16);
const ENDPOINT = `\\\\.\\pipe\\antigravity-manager-core-v1-${scope}`;

async function call(method, url, body) {
  try {
    const res = await axios.request({
      adapter: 'http',
      socketPath: ENDPOINT,
      baseURL: 'http://localhost',
      url,
      method,
      data: body,
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' },
    });
    return { status: res.status, data: res.data };
  } catch (err) {
    return { status: err?.response?.status ?? 0, data: err?.response?.data ?? err?.code ?? err?.message };
  }
}

const unwrap = (d) => (d && typeof d === 'object' && 'json' in d ? d.json : d);

console.log('--- oauthClientList ---');
console.log(JSON.stringify(unwrap((await call('POST', '/rpc/oauthClientList', {})).data))?.slice(0, 400));

console.log('--- oauthClientActive ---');
console.log(JSON.stringify(unwrap((await call('POST', '/rpc/oauthClientActive', {})).data))?.slice(0, 200));
