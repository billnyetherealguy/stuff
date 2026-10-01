// Post text for the Solworld bot. Pure functions, so they're easy to test.

const sol = (lamports) => {
  const v = lamports / 1e9;
  return v >= 1 ? v.toFixed(2).replace(/\.?0+$/, '') : v.toPrecision(2).replace(/\.?0+$/, '');
};
const pick = (list, seed) => list[[...String(seed)].reduce((a, c) => a + c.charCodeAt(0), 0) % list.length];
const where = (r) => r.place || `${r.lat.toFixed(3)}, ${r.lng.toFixed(3)}`;
const linkFor = (r, site) => (site ? (r.key ? `${site}/#/b/${r.key}` : site) : '');
const by = (r) => (r.name ? ` by ${r.name}` : '');

/** One post for one on-chain event. */
export function describe(r, site) {
  const link = linkFor(r, site);
  let lines;
  if (r.kind === 'land') {
    lines = [
      pick(['👑 City takeover.', '👑 Someone just took over a whole city.', '👑 New territory claimed.'], r.sig),
      `"${r.title || 'A new city'}" was just founded${by(r)}: ${r.count} buildings in ${where(r)}, for ${sol(r.price)} SOL.`,
    ];
  } else if (r.kind === 'sale') {
    lines = [pick(['💸 Sold.', '💸 A building just changed hands.', '💸 New owner.'], r.sig), `A building in ${where(r)} just sold for ${sol(r.price)} SOL${by(r)}.`];
  } else {
    const how = r.kind === 'hold' ? ' with holder credit' : ` for ${sol(r.price)} SOL`;
    lines = [pick(['🏙️ New landowner.', '🏙️ Another building claimed.', '🏙️ Just claimed.'], r.sig), `A building in ${where(r)} was just claimed${how}${by(r)}.`];
  }
  lines.push('', 'Every building on Earth is on the map. Pick yours 👇', link);
  return lines.join('\n').trim();
}

/** One post for a burst of events. */
export function roundup(records, totals, site) {
  const buys = records.filter((r) => r.kind === 'buy' || r.kind === 'hold').length;
  const sales = records.filter((r) => r.kind === 'sale').length;
  const lands = records.filter((r) => r.kind === 'land').length;
  const places = [...new Set(records.map((r) => r.place).filter(Boolean))].slice(0, 3);
  const parts = [buys && `${buys} buildings claimed`, sales && `${sales} sold`, lands && `${lands} cities taken over`].filter(Boolean);
  const lines = [`🔥 ${parts.join(', ')} on Solworld just now.`];
  if (places.length) lines.push(`📍 ${places.join(' · ')}`);
  if (totals?.owners) lines.push(`${totals.owners} landowners so far.`);
  lines.push('', 'Every building on Earth is for sale 👇', site || '');
  return lines.join('\n').trim();
}

/** The scheduled queue: posts separated by lines of ---, each with an optional "image: path" first line. */
export function parseQueue(md) {
  return md
    .split(/^---\s*$/m)
    .map((block) => block.replace(/<!--[\s\S]*?-->/g, '').trim())
    .filter(Boolean)
    .map((block) => {
      const m = /^image:\s*(.+)$/m.exec(block);
      return { image: m ? m[1].trim() : null, text: block.replace(/^image:.*$/m, '').trim() };
    });
}

/** A short reply to someone who mentioned the account. */
export function mentionReply(seed, site) {
  const lines = [
    'Appreciate you 🙏 Every building on Earth is up for grabs, go claim yours:',
    'gm 🌍 Find your building and make it yours:',
    "Thanks for the shout! Which building are you claiming first? 👀",
    "Let's go 🏙️ The whole map is live:",
  ];
  return `${pick(lines, seed)} ${site || ''}`.trim();
}
