// Minimal X (Twitter) client: OAuth 1.0a user context, no dependencies.
// Posting uses API v2 (POST /2/tweets); images go through the v1.1 media upload.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** OAuth 1.0a HMAC-SHA1 signature (RFC 5849). `params` = query + form params (not JSON bodies). */
export function oauthSignature(method, url, params, consumerSecret, tokenSecret) {
  const base = [
    method.toUpperCase(),
    enc(url),
    enc(
      Object.keys(params)
        .map((k) => [enc(k), enc(params[k])])
        .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join('&'),
    ),
  ].join('&');
  return crypto.createHmac('sha1', `${enc(consumerSecret)}&${enc(tokenSecret)}`).update(base).digest('base64');
}

export function authHeader({ method, url, params = {}, keys, nonce, timestamp }) {
  const oauth = {
    oauth_consumer_key: keys.apiKey,
    oauth_nonce: nonce || crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp || Math.floor(Date.now() / 1000)),
    oauth_token: keys.accessToken,
    oauth_version: '1.0',
  };
  oauth.oauth_signature = oauthSignature(method, url, { ...params, ...oauth }, keys.apiSecret, keys.accessSecret);
  return 'OAuth ' + Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(', ');
}

export class X {
  constructor(keys, { fetchImpl = fetch } = {}) {
    this.keys = keys;
    this.fetch = fetchImpl;
  }

  async _call(method, url, { query = {}, json, form } = {}) {
    const qs = new URLSearchParams(query).toString();
    const res = await this.fetch(qs ? `${url}?${qs}` : url, {
      method,
      headers: {
        Authorization: authHeader({ method, url, params: query, keys: this.keys }),
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json ? JSON.stringify(json) : form,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!res.ok) {
      const err = new Error(`X ${method} ${url} → ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
      err.status = res.status;
      err.retryAfter = Number(res.headers.get('x-rate-limit-reset')) || null;
      throw err;
    }
    return body;
  }

  async uploadImage(file) {
    const form = new FormData();
    const type = path.extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
    form.append('media', new Blob([fs.readFileSync(file)], { type }), path.basename(file));
    const out = await this._call('POST', 'https://upload.twitter.com/1.1/media/upload.json', { form });
    return out.media_id_string;
  }

  async post(text, { image, replyTo } = {}) {
    const json = { text };
    if (image) json.media = { media_ids: [await this.uploadImage(image)] };
    if (replyTo) json.reply = { in_reply_to_tweet_id: replyTo };
    const out = await this._call('POST', 'https://api.x.com/2/tweets', { json });
    return out.data?.id;
  }

  me() {
    return this._call('GET', 'https://api.x.com/2/users/me').then((r) => r.data);
  }

  mentions(userId, sinceId) {
    const query = { max_results: '20', 'tweet.fields': 'author_id,conversation_id,created_at' };
    if (sinceId) query.since_id = sinceId;
    return this._call('GET', `https://api.x.com/2/users/${userId}/mentions`, { query }).then((r) => r.data || []);
  }
}
