import fs from 'node:fs';

const files = [
  'D:/projectradom/geminirouter/frontend/src/components/GatewayPage.tsx',
  'D:/projectradom/geminirouter/frontend/src/components/OverviewPage.tsx',
  'D:/projectradom/geminirouter/frontend/src/components/TrafficPage.tsx',
  'D:/projectradom/geminirouter/frontend/src/components/SettingsPage.tsx',
  'D:/projectradom/geminirouter/frontend/src/components/OAuthModal.tsx',
];

const replacements = [
  // Backgrounds
  ['bg-[#FFFFFF]', 'bg-[#161b26]'],
  ['bg-white', 'bg-[#161b26]'],
  ['bg-[#FAF7F2]', 'bg-[#121620]'],
  ['bg-[#FAF2EF]', 'bg-[#1c2230]'],
  ['bg-[#FBF9F5]', 'bg-[#0d1117]'],
  ['bg-[#F6F3EE]', 'bg-[#181d28]'],
  ['bg-[#F7EEEA]', 'bg-[#1a2333]'],
  ['from-[#FAF2EF] to-[#FBF9F5]', 'from-[#161b26] to-[#121620]'],

  // Borders
  ['border-[#EAE5DE]', 'border-[#232936]'],
  ['border-[#DDD7CE]', 'border-[#2d3748]'],
  ['border-[#F2DDD5]', 'border-[#232936]'],
  ['border-[#C25938]', 'border-[#0284c7]'],

  // Text colors
  ['text-[#2A2723]', 'text-[#f0f3f6]'],
  ['text-[#504C46]', 'text-[#cbd5e1]'],
  ['text-[#706B65]', 'text-[#9aa4b2]'],
  ['text-[#9E988F]', 'text-[#6b7687]'],
  ['text-[#786358]', 'text-[#94a3b8]'],

  // Accents (terracotta -> cyan/blue from image 2)
  ['text-[#C25938]', 'text-[#38bdf8]'],
  ['bg-[#C25938]', 'bg-[#0284c7]'],
  ['hover:bg-[#B24E2E]', 'hover:bg-[#0369a1]'],
  ['text-stone-300', 'text-[#374151]'],

  // Inputs
  ['bg-white/80', 'bg-[#161b26]/80'],
  ['focus:border-[#C25938]', 'focus:border-[#0284c7]'],
  ['focus:ring-[#C25938]/20', 'focus:ring-[#0284c7]/20'],
  ['bg-stone-50', 'bg-[#121620]'],
  ['bg-stone-100', 'bg-[#1a202c]'],
  ['text-stone-700', 'text-[#e2e8f0]'],
  ['border-stone-200', 'border-[#232936]'],
];

for (const f of files) {
  if (!fs.existsSync(f)) continue;
  let content = fs.readFileSync(f, 'utf8');
  for (const [from, to] of replacements) {
    content = content.replaceAll(from, to);
  }
  fs.writeFileSync(f, content);
  console.log(`Updated ${f}`);
}
console.log('All files converted to dark theme!');
