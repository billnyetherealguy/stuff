import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { oauthSignature, authHeader } from '../../bot/x.mjs';
import { describe, roundup, parseQueue, mentionReply } from '../../bot/posts.mjs';

test('OAuth 1.0a signature matches the X documentation example', () => {
  const sig = oauthSignature(
    'POST',
    'https://api.twitter.com/1.1/statuses/update.json',
    {
      include_entities: 'true',
      status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
      oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
      oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: '1318622958',
      oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      oauth_version: '1.0',
    },
    'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
  );
  assert.equal(sig, 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
  const header = authHeader({ method: 'POST', url: 'https://api.x.com/2/tweets', keys: { apiKey: 'a', apiSecret: 'b', accessToken: 'c', accessSecret: 'd' } });
  assert.match(header, /^OAuth oauth_consumer_key="a", oauth_nonce="[0-9a-f]+", oauth_signature="[^"]+"/);
});

test('event posts read well and stay under 280 characters', () => {
  const site = 'https://solworld.example';
  const buy = describe({ kind: 'buy', key: 'w123', price: 21_000_000, lat: 40.75, lng: -73.99, place: 'New York, United States', sig: 'abc' }, site);
  assert.match(buy, /New York, United States was just claimed for 0\.021 SOL\./);
  assert.match(buy, /https:\/\/solworld\.example\/#\/b\/w123$/);
  const land = describe({ kind: 'land', key: null, price: 2e9, count: 340, title: 'Solana City', lat: 40.75, lng: -73.99, sig: 'x', name: 'bill' }, site);
  assert.match(land, /"Solana City" was just founded by bill: 340 buildings in 40\.750, -73\.990, for 2 SOL\./);
  const sale = describe({ kind: 'sale', key: 'w9', price: 3.4e9, lat: 1, lng: 2, place: 'Paris, France', sig: 's' }, site);
  assert.match(sale, /Paris, France just sold for 3\.4 SOL/);
  const r = roundup([{ kind: 'buy', place: 'Tokyo, Japan' }, { kind: 'buy', place: 'Lagos, Nigeria' }, { kind: 'sale' }, { kind: 'land' }], { owners: 42 }, site);
  assert.match(r, /2 buildings claimed, 1 sold, 1 cities taken over/);
  for (const t of [buy, land, sale, r, mentionReply('1', site)]) assert.ok(t.length <= 280, t);
});

test('the queue parses and every post fits', () => {
  const queue = parseQueue(fs.readFileSync(new URL('../../bot/queue.md', import.meta.url), 'utf8'));
  assert.ok(queue.length >= 10);
  for (const q of queue) {
    assert.ok(q.text.replaceAll('{site}', 'https://x'.padEnd(40, 'x')).length <= 280, q.text);
    if (q.image) assert.ok(fs.existsSync(new URL(`../../${q.image}`, import.meta.url)), q.image);
  }
});
