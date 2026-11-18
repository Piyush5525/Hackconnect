// Dark theme for the Nexconn Chat UI SDK (@nexconn/chatui).
// The SDK ships a fixed light palette inside its web components' shadow DOM, which page CSS cannot reach. This esbuild
// plugin rewrites the SDK's colour literals while bundling, so the Team hub matches HackConnect's dark interface.
// Each colour is mapped by where it is used: a background, a text colour, a border, or an SVG icon / JS string.
// Every literal goes through one function, so the SDK's own `icon.replace(/#020814/g, '#0047FF')` hover swaps keep
// working: both sides of the swap are mapped the same way.
import { readFile } from 'node:fs/promises';

const P = { surface: '#141a18', raised: '#1d2522', soft: '#1a211f', hover: '#26302c', tint: '#253220', line: '#2a3430', text: '#edf3ee', soft2: '#c6d1cb', muted: '#8a9892', faint: '#66736e', mint: '#b9f07c', mintDark: '#81bb4b', ink: '#10170d' };
const set = (keys, value) => Object.fromEntries(keys.split(' ').map((k) => [k, value]));
const ACCENT = 'FFF FFFFFF'.split(' ');
const ACCENT_BG = '#0047FF #0099FF #297BFF #366EFF'.split(' ');

const BG = {
  ...set('#FFF #FFFFFF #FCFCFC', P.surface), ...set('#F3F5FA', P.raised), ...set('#F5F5F5 #F1F1F1 #EFEFEF #EAEAEA', P.soft),
  ...set('#E3E7EF #E6ECF3 #E4E8EF #E5E5E5', P.hover), ...set('#D0DDFF #D2E1FE #E9F0FB #ECF1FF #E7EEFF #C2D7FF #CFD8ED #C9D2E8', P.tint),
  ...set(ACCENT_BG.join(' '), P.mint), ...set('#020814', P.soft2), ...set('#909399', '#3a4541'),
};
const TEXT = {
  ...set('#020814 #000 #000000 #333 #333333 #1D2129 #0E1012', P.text), ...set('#41464F', P.soft2),
  ...set('#7C838E #85909C #909399 #A1AABF #7B87A5 #606060', P.muted), ...set('#B3B3B3 #BCBCBC #C4C4C4 #A1A1A1 #CCCCCC #B8B8B8', P.faint),
  ...set('#0047FF #0099FF #337ECC #297BFF #366EFF', P.mint),
};
const BORDER = { ...set('#E4E7ED #EFEFEF #EAEAEA #DEDEDE #E3E7EF #E5E5E5 #ABB8CB #CCCCCC #F3F5FA #FFFFFF #FFF #E4E8EF', P.line), ...set('#0047FF #0099FF', P.mintDark) };
// SVG icons (fill / stroke inside inline SVG strings) and plain JS strings.
const OTHER = {
  ...set('#020814', P.text), ...set('#41464F', P.soft2), ...set('#7C838E', P.muted), ...set('#F3F5FA', P.raised), ...set('#E3E7EF', P.hover),
  ...set('#D0DDFF', P.tint), ...set('#0047FF', P.mint), ...set('#CCCCCC', '#55625d'), ...set('#E4E7ED', P.line), ...set('#F5F5F5', P.soft),
};
const MENU = /(menu|popover|modal|dialog|tooltip|secondary|combine-header)/i;

export function darken(source) {
  return source.replace(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g, (hex, _, at) => {
    const key = hex.toUpperCase();
    const before = source.slice(Math.max(0, at - 60), at);
    const decl = /([a-zA-Z-]+)\s*:\s*[^;:{}"'`]*$/.exec(before);
    const prop = decl?.[1].toLowerCase();
    if (prop && /^(background|background-color)$/.test(prop)) {
      if (BG[key] === P.surface) { const open = source.lastIndexOf('{', at); const selector = source.slice(source.lastIndexOf('}', open) + 1, open); if (MENU.test(selector)) return P.raised; }
      return BG[key] ?? hex;
    }
    if (prop === 'color') {
      if (ACCENT.includes(key.slice(1))) { const open = source.lastIndexOf('{', at); const close = source.indexOf('}', at); const rule = source.slice(open, close); if (ACCENT_BG.some((c) => new RegExp(`background(-color)?\\s*:\\s*${c}\\b`, 'i').test(rule))) return P.ink; return hex; }
      return TEXT[key] ?? hex;
    }
    if (prop && prop.startsWith('border')) return BORDER[key] ?? hex;
    return OTHER[key] ?? hex;
  });
}

export const nexconnDark = {
  name: 'nexconn-dark',
  setup(b) {
    b.onLoad({ filter: /[\\/]@nexconn[\\/]chatui[\\/]dist[\\/].*\.js$/ }, async (args) => ({ contents: darken(await readFile(args.path, 'utf8')), loader: 'js' }));
  },
};
