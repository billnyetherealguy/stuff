// Transaction builders for every Solworld action, including the marketplace.
//
// Sales are atomic and need no escrow or server:
//  1. Each owned building has a durable-nonce account whose authority is the
//     current owner (created by the first bidder).
//  2. A bidder builds the sale transaction against that nonce (payment to the
//     owner, fee to the treasury, nonce authority handed to the bidder), signs
//     it, and publishes their signature in an on-chain "offer".
//  3. The owner accepts by adding their signature and submitting it. Payment
//     and ownership change hands in one transaction; the nonce advances, which
//     invalidates every other outstanding offer, so nobody can be paid twice.

import {
  advanceNonceInstruction,
  authorizeNonceInstruction,
  compileMessage,
  computeUnitLimitInstruction,
  computeUnitPriceInstruction,
  createNonceAccountInstructions,
  createWithSeedAddress,
  memoInstruction,
  transferInstruction,
} from './solana.js';
import { buildMemo, saleFee } from './registry.js';

/**
 * Instructions for a standard action: pay `lamports` (often 0) to the treasury
 * with the registry reference attached, plus the memo.
 */
export function actionInstructions({ from, treasury, reference, lamports = 0, memo, extraRefs = [], memoSigners = [], priorityFee = 0, referral = null }) {
  const ixs = [computeUnitLimitInstruction(40_000)];
  if (priorityFee) ixs.push(computeUnitPriceInstruction(priorityFee));
  // A friend's invite (registry REFERRAL_BPS): their share goes to them directly.
  const cut = referral ? referral.lamports : 0;
  ixs.push(transferInstruction({ from, to: treasury, lamports: lamports - cut, references: [reference, ...extraRefs] }));
  if (cut) ixs.push(transferInstruction({ from, to: referral.to, lamports: cut }));
  ixs.push(memoInstruction(memo, memoSigners));
  return ixs;
}

export function actionMessage(opts, recentBlockhash) {
  return compileMessage({ payer: opts.from, instructions: actionInstructions(opts), recentBlockhash });
}

/** The exact sale transaction both parties sign (deterministic from its inputs). */
export function buildSaleMessage({ buyer, seller, treasury, reference, key, price, feeBps, nonce, nonceValue }) {
  const fee = saleFee(price, feeBps);
  return compileMessage({
    payer: buyer,
    recentBlockhash: nonceValue,
    instructions: [
      advanceNonceInstruction({ nonce, authority: seller }),
      transferInstruction({ from: buyer, to: seller, lamports: price - fee }),
      transferInstruction({ from: buyer, to: treasury, lamports: fee, references: [reference] }),
      authorizeNonceInstruction({ nonce, authority: seller, newAuthority: buyer }),
      memoInstruction(buildMemo('sale', { key, price })),
    ],
  });
}

export const nonceSeed = (key, n = 0) => (n ? `sw${key}.${n}` : `sw${key}`);

export async function nonceAddressFor(base, key, n = 0) {
  return createWithSeedAddress(base, nonceSeed(key, n));
}

export function createNonceMessage({ payer, nonce, key, n = 0, lamports, authority, recentBlockhash }) {
  return compileMessage({
    payer,
    recentBlockhash,
    instructions: createNonceAccountInstructions({ from: payer, nonce, seed: nonceSeed(key, n), lamports, authority }),
  });
}
