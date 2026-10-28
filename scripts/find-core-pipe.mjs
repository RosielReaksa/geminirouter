import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';

console.log('os.homedir() =', os.homedir());
console.log('USERPROFILE env =', process.env.USERPROFILE);

const pipes = fs
  .readdirSync('//./pipe/')
  .filter((p) => p.toLowerCase().includes('antigravity'));
console.log('antigravity pipes:');
console.log(pipes.length ? pipes.join('\n') : '(none)');

const home = 'D:\\projectradom\\geminirouter\\core-profile';
const scope = crypto.createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 16);
console.log('expected core pipe suffix:', scope);

// Try connecting to each discovered antigravity pipe to see which is live
for (const p of pipes) {
  await new Promise((resolve) => {
    const s = net.connect('\\\\.\\pipe\\' + p);
    s.setTimeout(1000);
    s.on('connect', () => {
      console.log('LIVE:', p);
      s.destroy();
      resolve();
    });
    s.on('error', (e) => {
      console.log('dead:', p, e.code);
      resolve();
    });
    s.on('timeout', () => {
      console.log('timeout:', p);
      s.destroy();
      resolve();
    });
  });
}
