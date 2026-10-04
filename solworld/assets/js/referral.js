// Invite links: https://<site>/?ref=<wallet>. The first invite a visitor opens
// is remembered; when they make their first purchase, the inviter's share
// (registry REFERRAL_BPS) is paid to the inviter in the same transaction.
import { isAddress } from './solana.js';
import { REFERRAL_BPS, referralCut } from './registry.js';

const KEY = 'solworld:ref';
export const REFERRAL_PERCENT = REFERRAL_BPS / 100;

/** Reads ?ref= from the address bar (then tidies it away). Returns the remembered inviter. */
export function captureReferral(storage, loc = globalThis.location, hist = globalThis.history) {
  try {
    const url = new URL(loc.href);
    const ref = url.searchParams.get('ref');
    if (ref != null) {
      if (isAddress(ref) && !storage.get(KEY)) storage.set(KEY, ref);
      url.searchParams.delete('ref');
      hist?.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  } catch {
    // no usable URL: nothing to capture
  }
  return storage.get(KEY);
}

/**
 * The referral to attach to a purchase, or null. Mirrors the registry rule so
 * the purchase never counts as underpaid: first purchase only, an inviter who
 * has owned something, and never yourself.
 */
export function referralFor({ storage, state, me, price, treasury }) {
  const ref = storage.get(KEY);
  if (!isAddress(ref) || ref === me || ref === treasury) return null;
  if (state.owners.get(me)?.first != null) return null;
  if (state.owners.get(ref)?.first == null) return null;
  const lamports = referralCut(price);
  return lamports > 0 ? { to: ref, lamports } : null;
}

export const inviteLink = (origin, address) => `${origin.replace(/\/$/, '')}/?ref=${address}`;
