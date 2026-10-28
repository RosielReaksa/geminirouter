import fs from 'node:fs';

const files = [
  'D:/projectradom/geminirouter/frontend/src/components/GatewayPage.tsx',
  'D:/projectradom/geminirouter/frontend/src/components/OverviewPage.tsx',
  'D:/projectradom/geminirouter/frontend/src/components/TrafficPage.tsx',
  'D:/projectradom/geminirouter/frontend/src/components/SettingsPage.tsx',
  'D:/projectradom/geminirouter/frontend/src/components/OAuthModal.tsx',
];

// More specific patterns first to avoid substring collisions
const reverseReplacements = [
  // Inputs / composite
  ['bg-[#161b26]/80', 'bg-white/80'],
  ['focus:border-[#0284c7]', 'focus:border-[#C25938]'],
  ['focus:ring-[#0284c7]/20', 'focus:ring-[#C25938]/20'],

  // Gradient banner
  ['from-[#161b26] to-[#121620]', 'from-[#FAF2EF] to-[#FBF9F5]'],

  // Backgrounds
  ['bg-[#161b26]', 'bg-[#FFFFFF]'],
  ['bg-[#121620]', 'bg-[#FAF7F2]'],
  ['bg-[#1c2230]', 'bg-[#FAF2EF]'],
  ['bg-[#0d1117]', 'bg-[#FBF9F5]'],
  ['bg-[#181d28]', 'bg-[#F6F3EE]'],
  ['bg-[#1a2333]', 'bg-[#F7EEEA]'],
  ['bg-[#1a202c]', 'bg-stone-100'],

  // Borders
  ['border-[#232936]', 'border-[#EAE5DE]'],
  ['border-[#2d3748]', 'border-[#DDD7CE]'],
  ['border-[#0284c7]', 'border-[#C25938]'],
  ['border-stone-200', 'border-[#EAE5DE]'],

  // Text colors
  ['text-[#f0f3f6]', 'text-[#2A2723]'],
  ['text-[#cbd5e1]', 'text-[#504C46]'],
  ['text-[#9aa4b2]', 'text-[#706B65]'],
  ['text-[#6b7687]', 'text-[#9E988F]'],
  ['text-[#94a3b8]', 'text-[#786358]'],
  ['text-[#e2e8f0]', 'text-stone-700'],
  ['text-[#374151]', 'text-stone-300'],

  // Accents back to terracotta
  ['text-[#38bdf8]', 'text-[#C25938]'],
  ['bg-[#0284c7]', 'bg-[#C25938]'],
  ['hover:bg-[#0369a1]', 'hover:bg-[#B24E2E]'],
];

for (const f of files) {
  if (!fs.existsSync(f)) continue;
  let content = fs.readFileSync(f, 'utf8');
  for (const [from, to] of reverseReplacements) {
    content = content.replaceAll(from, to);
  }
  fs.writeFileSync(f, content);
  console.log(`Reverted ${f}`);
}
console.log('done');
