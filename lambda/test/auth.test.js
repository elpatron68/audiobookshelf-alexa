'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  encryptCredentials,
  decryptCredentials,
  handleHttpRequest,
} = require('../lib/auth');

test('encryptCredentials and decryptCredentials roundtrip', () => {
  const payload = {
    baseUrl: 'https://abs.example.com',
    apiKey: 'my-jwt-token-123',
    userId: 'user-456',
  };
  const token = encryptCredentials(payload);
  assert.ok(token && typeof token === 'string');

  const decrypted = decryptCredentials(token);
  assert.equal(decrypted.baseUrl, payload.baseUrl);
  assert.equal(decrypted.apiKey, payload.apiKey);
  assert.equal(decrypted.userId, payload.userId);
  assert.ok(decrypted.ts > 0);
});

test('decryptCredentials returns null for corrupted or invalid tokens', () => {
  assert.equal(decryptCredentials(null), null);
  assert.equal(decryptCredentials(''), null);
  assert.equal(decryptCredentials('invalid-base64'), null);
  assert.equal(decryptCredentials('short'), null);
});

test('handleHttpRequest GET /health returns ok', async () => {
  const res = await handleHttpRequest({ rawPath: '/health', requestContext: { http: { method: 'GET' } } });
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.status, 'ok');
});

test('handleHttpRequest GET /auth returns login HTML page', async () => {
  const res = await handleHttpRequest({
    rawPath: '/auth',
    requestContext: { http: { method: 'GET' } },
    queryStringParameters: {
      redirect_uri: 'https://pitangui.amazon.com/api/skill/link/VENDOR',
      state: 'xyz123',
    },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Audiobookshelf Server-Adresse/);
  assert.match(res.body, /API-Schlüssel/);
  assert.match(res.body, /https:\/\/pitangui\.amazon\.com/);
});

test('handleHttpRequest GET /privacy and /terms return documentation', async () => {
  const privacy = await handleHttpRequest({ rawPath: '/privacy' });
  assert.equal(privacy.statusCode, 200);
  assert.match(privacy.body, /Datenschutzerklärung/);

  const terms = await handleHttpRequest({ rawPath: '/terms' });
  assert.equal(terms.statusCode, 200);
  assert.match(terms.body, /Nutzungsbedingungen/);
});

test('handleHttpRequest POST /auth with missing fields returns 400', async () => {
  const res = await handleHttpRequest({
    rawPath: '/auth',
    requestContext: { http: { method: 'POST' } },
    body: 'server_url=&api_key=',
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /Bitte gib die Server-Adresse sowie Benutzername und Passwort/);
});

test('handleHttpRequest POST /token exchanges valid authorization code', async () => {
  const code = encryptCredentials({ baseUrl: 'https://abs.test.com', apiKey: 'token-abc' });
  const res = await handleHttpRequest({
    rawPath: '/token',
    requestContext: { http: { method: 'POST' } },
    body: `grant_type=authorization_code&code=${encodeURIComponent(code)}`,
  });
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.access_token, code);
  assert.equal(data.token_type, 'Bearer');
  assert.ok(data.expires_in > 0);
});

test('handleHttpRequest POST /token returns 400 for invalid code', async () => {
  const res = await handleHttpRequest({
    rawPath: '/token',
    requestContext: { http: { method: 'POST' } },
    body: 'grant_type=authorization_code&code=bad-code',
  });
  assert.equal(res.statusCode, 400);
  const data = JSON.parse(res.body);
  assert.equal(data.error, 'invalid_grant');
});
