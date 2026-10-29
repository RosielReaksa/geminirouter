import axios from 'file:///D:/projectradom/geminirouter/server/node_modules/axios/lib/axios.js';

const status = await axios.get('http://127.0.0.1:3000/api/status');
const endpoint = status.data.coreEndpoint;
console.log('core endpoint:', endpoint);

const call = async (proc, input) => {
  const res = await axios.request({
    adapter: 'http',
    socketPath: endpoint,
    baseURL: 'http://localhost',
    url: `/rpc/${proc}`,
    method: 'POST',
    data: { json: input },
    timeout: 10000,
    headers: { 'Content-Type': 'application/json' },
  });
  return res.data?.json ?? res.data;
};

await call('gatewayStop');
console.log('gatewayStop sent');

await new Promise((r) => setTimeout(r, 2500));

const key = (await import('node:fs')).readFileSync(
  'D:/projectradom/geminirouter/core-profile/API_KEY.txt',
  'utf8'
).trim();

const probe = async (label) => {
  try {
    const r = await axios.get('http://127.0.0.1:8046/v1/models', {
      timeout: 4000,
      validateStatus: () => true,
      headers: { Authorization: `Bearer ${key}` },
    });
    console.log(`${label}: ${r.status}`);
  } catch (e) {
    console.log(`${label}: DOWN (${e.code || e.message})`);
  }
};

await probe('right after stop');

// The supervisor runs every 30s; wait for it.
for (let i = 1; i <= 4; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  await probe(`+${i * 10}s`);
}
