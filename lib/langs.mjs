// Language detection for the project overview (GitHub-style: programming + markup languages only, measured in bytes).
const L = (name, color, type = 'programming') => ({ name, color, type });
const BY_EXT = {
  js: L('JavaScript', '#f1e05a'), mjs: L('JavaScript', '#f1e05a'), cjs: L('JavaScript', '#f1e05a'), jsx: L('JavaScript', '#f1e05a'),
  ts: L('TypeScript', '#3178c6'), tsx: L('TypeScript', '#3178c6'), mts: L('TypeScript', '#3178c6'), cts: L('TypeScript', '#3178c6'),
  py: L('Python', '#3572A5'), pyw: L('Python', '#3572A5'), ipynb: L('Jupyter Notebook', '#DA5B0B'),
  html: L('HTML', '#e34c26', 'markup'), htm: L('HTML', '#e34c26', 'markup'), css: L('CSS', '#563d7c', 'markup'), scss: L('SCSS', '#c6538c', 'markup'), sass: L('Sass', '#a53b70', 'markup'), less: L('Less', '#1d365d', 'markup'),
  vue: L('Vue', '#41b883'), svelte: L('Svelte', '#ff3e00'), astro: L('Astro', '#ff5a03'),
  java: L('Java', '#b07219'), kt: L('Kotlin', '#A97BFF'), kts: L('Kotlin', '#A97BFF'), scala: L('Scala', '#c22d40'), groovy: L('Groovy', '#4298b8'),
  c: L('C', '#555555'), h: L('C', '#555555'), cpp: L('C++', '#f34b7d'), cc: L('C++', '#f34b7d'), cxx: L('C++', '#f34b7d'), hpp: L('C++', '#f34b7d'), cs: L('C#', '#178600'),
  go: L('Go', '#00ADD8'), rs: L('Rust', '#dea584'), zig: L('Zig', '#ec915c'), swift: L('Swift', '#F05138'), m: L('Objective-C', '#438eff'), dart: L('Dart', '#00B4AB'),
  rb: L('Ruby', '#701516'), php: L('PHP', '#4F5D95'), pl: L('Perl', '#0298c3'), lua: L('Lua', '#000080'), r: L('R', '#198CE7'), jl: L('Julia', '#a270ba'),
  hs: L('Haskell', '#5e5086'), ex: L('Elixir', '#6e4a7e'), exs: L('Elixir', '#6e4a7e'), erl: L('Erlang', '#B83998'), clj: L('Clojure', '#db5855'), ml: L('OCaml', '#ef7a08'), nim: L('Nim', '#ffc200'),
  sh: L('Shell', '#89e051'), bash: L('Shell', '#89e051'), zsh: L('Shell', '#89e051'), ps1: L('PowerShell', '#012456'), bat: L('Batchfile', '#C1F12E'), cmd: L('Batchfile', '#C1F12E'),
  sql: L('SQL', '#e38c00'), sol: L('Solidity', '#AA6746'), vim: L('Vim Script', '#199f4b'), gradle: L('Groovy', '#4298b8'), tex: L('TeX', '#3D6117', 'markup'), xml: L('XML', '#0060ac', 'markup'), svg: L('SVG', '#ff9900', 'markup')
};
const BY_NAME = { dockerfile: L('Dockerfile', '#384d54'), makefile: L('Makefile', '#427819'), 'cmakelists.txt': L('CMake', '#DA3434') };
const NOT_COUNTED = new Set(['md', 'markdown', 'txt', 'json', 'lock', 'yml', 'yaml', 'toml', 'csv', 'ini', 'env', 'log', 'gitignore', 'svg', 'xml']); // prose / data, like GitHub

export function languageOf(path) {
  const base = String(path).split('/').pop().toLowerCase(); if (BY_NAME[base]) return BY_NAME[base];
  const ext = base.includes('.') ? base.split('.').pop() : ''; return BY_EXT[ext] || null;
}
export const isCountedLanguage = (path) => { const base = String(path).split('/').pop().toLowerCase(); const ext = base.includes('.') ? base.split('.').pop() : ''; return !NOT_COUNTED.has(ext) && languageOf(path) !== null; };

/** GitHub-style breakdown: share of bytes per programming/markup language, largest first. */
export function languageBreakdown(files) {
  const acc = new Map(); let total = 0;
  for (const [path, content] of Object.entries(files)) {
    if (!isCountedLanguage(path)) continue; const lang = languageOf(path); const bytes = Buffer.byteLength(content || '', 'utf8'); if (!bytes) continue;
    const row = acc.get(lang.name) || { language: lang.name, color: lang.color, bytes: 0, lines: 0, files: 0 }; row.bytes += bytes; row.lines += content.split('\n').length; row.files += 1; acc.set(lang.name, row); total += bytes;
  }
  return [...acc.values()].sort((a, b) => b.bytes - a.bytes).map((r) => ({ ...r, percent: total ? Math.round((r.bytes / total) * 1000) / 10 : 0 }));
}

const COLORS = new Map([...Object.values(BY_EXT), ...Object.values(BY_NAME)].map((l) => [l.name.toLowerCase(), l.color]));
export const colorOfLanguage = (name) => COLORS.get(String(name).toLowerCase()) || '#8b949e';
