import http from 'node:http';
import fs from 'node:fs';

const pipes = fs.readdirSync('//./pipe/').filter((p) => p.startsWith('antigravity-manager-core-v1-'));
const activePipe = pipes.find((p) => !p.includes('2a014b31fabdb803')) || pipes[0];
const endpoint = `\\\\.\\pipe\\${activePipe}`;
console.log('Connecting to live pipe:', endpoint);

const req = http.request(
  {
    socketPath: endpoint,
    path: '/rpc/accountViews',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  },
  (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => {
      console.log('HTTP Status:', res.statusCode);
      const j = JSON.parse(data);
      console.log('ACCOUNTS IN CORE VIEWS:');
      j.json?.forEach((a) => console.log('ID:', a.id, '| Email:', a.email));
    });
  }
);

req.on('error', (err) => console.log('HTTP ERR:', err.message));
req.write(JSON.stringify({ json: {} }));
req.end();
