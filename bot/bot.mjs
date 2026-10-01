// Solworld X bot. One run = one pass; run it every ~15 minutes (GitHub Actions
// does this for free, see .github/workflows/solworld-bot.yml).
//
// Each pass, it:
//   1. reads new Solworld activity from the Solana ledger and posts it
//      (buildings claimed, sales, cities taken over), real events only;
//   2. posts the next item from bot/queue.md every POST_EVERY_HOURS;
//   3. optionally replies to people who @mention the account (REPLY_TO_MENTIONS=1).
//
// It never replies to, likes or follows accounts that haven't engaged with you:
// X suspends accounts that do that automatically.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rpc } from '../solworld/assets/js/solana.js';
import { ChainRegistry } from '../solworld/assets/js/registry.js';
import { X } from './x.mjs';
import { describe, roundup, parseQueue, mentionReply } from './posts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const STATE = env.BOT_STATE || path.join(here, 'state.json');
const SITE = (env.SITE_URL || '').replace(/\/$/, '');
const TREASURY = env.TREASURY || '8tiwEgFFPdkMRhPMZtxHRwvopwf1PeqzgMpVMq7GKkpV';
const RPC = (env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com').split(',');
const EVERY_H = Number(env.POST_EVERY_HOURS || 3);
const MAX_PER_DAY = Number(env.MAX_POSTS_PER_DAY || 16);
const MAX_REPLIES = Number(env.MAX_REPLIES_PER_RUN || 5);
const keys = { apiKey: env.X_API_KEY, apiSecret: env.X_API_SECRET, accessToken: env.X_ACCESS_TOKEN, accessSecret: env.X_ACCESS_SECRET };
const DRY = env.DRY_RUN === '1' || !Object.values(keys).every(Boolean);

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
state.seen ||= [];
state.store ||= {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state));
const today = new Date().toISOString().slice(0, 10);
if (state.day !== today) Object.assign(state, { day: today, postsToday: 0 });

const x = DRY ? null : new X(keys);
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function post(text, opts = {}) {
  if (state.postsToday >= MAX_PER_DAY) return log('daily cap reached, skipping:', text.split('\n')[0]);
  if (DRY) {
    log('[dry run] would post:\n' + text + (opts.image ? `\n[image ${opts.image}]` : '') + '\n');
  } else {
    const id = await x.post(text, opts);
    log('posted', id);
  }
  state.postsToday++;
  save();
}

// Where a building is, in words ("Brooklyn, United States"); coordinates if the lookup fails.
async function placeOf(lat, lng) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lng}`, {
      headers: { 'User-Agent': `solworld-bot (${SITE || 'solworld'})`, 'Accept-Language': 'en' },
    });
    const a = (await res.json()).address || {};
    const city = a.city || a.town || a.village || a.county || a.state;
    return [city, a.country].filter(Boolean).join(', ') || null;
  } catch {
    return null;
  }
}

async function activity() {
  const storage = { get: (k) => state.store[k] ?? null, set: (k, v) => (state.store[k] = v), remove: (k) => delete state.store[k] };
  const registry = new ChainRegistry({ rpc: new Rpc(RPC), treasury: TREASURY, cluster: 'mainnet-beta', rules: { treasury: TREASURY, feeBps: 100, memecoin: null }, storage });
  await registry.init();
  await registry.sync();
  const s = registry.state;
  const records = (s.activity || []).filter((r) => ['buy', 'hold', 'sale', 'land'].includes(r.kind) && !r.seed);
  const seen = new Set(state.seen);
  if (!state.primed) {
    // First run: everything so far is history, not news.
    state.seen = records.map((r) => r.sig).slice(-2000);
    state.primed = true;
    save();
    return log(`primed with ${records.length} past events`);
  }
  const fresh = records.filter((r) => !seen.has(r.sig));
  for (const r of fresh) {
    r.place = await placeOf(r.lat, r.lng);
    r.name = s.names?.get?.(r.owner) || null;
    await new Promise((ok) => setTimeout(ok, 1100)); // Nominatim: 1 request a second
  }
  const totals = { owners: s.owners?.size ?? null, buildings: s.buildings?.size ?? null };
  if (fresh.length > 3) await post(roundup(fresh, totals, SITE));
  else for (const r of fresh) await post(describe(r, SITE));
  state.seen = [...state.seen, ...fresh.map((r) => r.sig)].slice(-2000);
  save();
}

async function scheduled() {
  const queue = parseQueue(fs.readFileSync(path.join(here, 'queue.md'), 'utf8'));
  if (!queue.length) return;
  if (Date.now() - (state.lastScheduled || 0) < EVERY_H * 3600e3) return;
  const i = (state.queueIndex || 0) % queue.length;
  const item = queue[i];
  const image = item.image ? path.resolve(here, '..', item.image) : null;
  await post(item.text.replaceAll('{site}', SITE), { image: image && fs.existsSync(image) ? image : undefined });
  state.queueIndex = i + 1;
  state.lastScheduled = Date.now();
  save();
}

async function mentions() {
  if (env.REPLY_TO_MENTIONS !== '1' || DRY) return;
  state.me ||= await x.me();
  const list = await x.mentions(state.me.id, state.mentionsSince);
  if (!list.length) return;
  state.mentionsSince = list[0].id;
  state.replied ||= [];
  let n = 0;
  for (const t of list.reverse()) {
    if (n >= MAX_REPLIES || t.author_id === state.me.id || state.replied.includes(t.conversation_id)) continue;
    await x.post(mentionReply(t.id, SITE), { replyTo: t.id });
    state.replied = [...state.replied, t.conversation_id].slice(-500);
    n++;
    log('replied to mention', t.id);
  }
  save();
}

for (const [name, job] of [['activity', activity], ['scheduled', scheduled], ['mentions', mentions]]) {
  try {
    await job();
  } catch (err) {
    log(`${name} failed:`, err.message);
    process.exitCode = 1;
  }
}
if (DRY) log('dry run: set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_SECRET to post for real');
