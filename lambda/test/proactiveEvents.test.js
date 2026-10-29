'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMediaAvailablePayload,
  parseWebhookPayload,
  getProactiveEventsToken,
  sendProactiveEvent,
  resetTokenCache,
  PROACTIVE_ENDPOINTS,
} = require('../lib/proactiveEvents');
const { handleHttpRequest } = require('../lib/auth');

test.beforeEach(() => {
  resetTokenCache();
});

test('buildMediaAvailablePayload creates valid AMAZON.MediaContent.Available event', () => {
  const now = new Date('2026-10-10T12:00:00.000Z');
  const payload = buildMediaAvailablePayload({
    title: 'Der Herr der Ringe',
    author: 'J.R.R. Tolkien',
    contentType: 'BOOK',
    providerName: 'Audiobookshelf',
    now,
  });

  assert.equal(payload.event.name, 'AMAZON.MediaContent.Available');
  assert.equal(payload.event.payload.content.contentType, 'BOOK');
  assert.equal(payload.event.payload.availability.method, 'RELEASE');
  assert.equal(payload.event.payload.availability.startTime, '2026-10-10T12:00:00.000Z');
  assert.equal(payload.expiryTime, '2026-10-11T12:00:00.000Z');
  assert.equal(payload.relevantAudience.type, 'Multicast');

  assert.equal(payload.localizedAttributes.length, 2);
  const de = payload.localizedAttributes.find((l) => l.locale === 'de-DE');
  assert.equal(de['provider.name'], 'Audiobookshelf');
  assert.equal(de['content.name'], 'Der Herr der Ringe von J.R.R. Tolkien');

  const en = payload.localizedAttributes.find((l) => l.locale === 'en-US');
  assert.equal(en['provider.name'], 'Audiobookshelf');
  assert.equal(en['content.name'], 'Der Herr der Ringe by J.R.R. Tolkien');
});

test('buildMediaAvailablePayload supports podcast episodes and Unicast targeting', () => {
  const now = new Date('2026-10-10T12:00:00.000Z');
  const payload = buildMediaAvailablePayload({
    title: 'Tech Talk Folge 42',
    contentType: 'EPISODE',
    method: 'STREAM',
    userId: 'amzn1.ask.account.USER123',
    now,
  });

  assert.equal(payload.event.payload.content.contentType, 'EPISODE');
  assert.equal(payload.event.payload.availability.method, 'STREAM');
  assert.equal(payload.relevantAudience.type, 'Unicast');
  assert.equal(payload.relevantAudience.payload.user, 'amzn1.ask.account.USER123');

  const de = payload.localizedAttributes.find((l) => l.locale === 'de-DE');
  assert.equal(de['content.name'], 'Tech Talk Folge 42');
});

test('buildMediaAvailablePayload requires title', () => {
  assert.throws(() => {
    buildMediaAvailablePayload({ title: '' });
  }, /Title is required/);
});

test('parseWebhookPayload parses native Audiobookshelf item_added event', () => {
  const absBody = {
    event: 'item_added',
    item: {
      mediaType: 'book',
      media: {
        metadata: {
          title: 'QualityLand',
          authorName: 'Marc-Uwe Kling',
        },
      },
    },
  };

  const parsed = parseWebhookPayload(absBody);
  assert.ok(parsed);
  assert.equal(parsed.title, 'QualityLand');
  assert.equal(parsed.author, 'Marc-Uwe Kling');
  assert.equal(parsed.contentType, 'BOOK');
});

test('parseWebhookPayload parses native Audiobookshelf podcast item', () => {
  const absBody = {
    event: 'item_added',
    libraryItem: {
      mediaType: 'podcast',
      media: {
        metadata: {
          title: 'Daily Tech News',
        },
      },
    },
  };

  const parsed = parseWebhookPayload(absBody);
  assert.ok(parsed);
  assert.equal(parsed.title, 'Daily Tech News');
  assert.equal(parsed.contentType, 'EPISODE');
});

test('parseWebhookPayload parses Apprise format with author in body', () => {
  const appriseBody = {
    title: 'Neues Hörbuch hinzugefügt',
    body: 'Klartext von Markus Busche',
    type: 'info',
  };

  const parsed = parseWebhookPayload(appriseBody);
  assert.ok(parsed);
  assert.equal(parsed.title, 'Klartext');
  assert.equal(parsed.author, 'Markus Busche');
  assert.equal(parsed.contentType, 'BOOK');
});

test('parseWebhookPayload returns null on invalid or empty body', () => {
  assert.equal(parseWebhookPayload(null), null);
  assert.equal(parseWebhookPayload({}), null);
  assert.equal(parseWebhookPayload('invalid text without key-value'), null);
});

test('getProactiveEventsToken requests token and uses cache on subsequent calls', async () => {
  let callCount = 0;
  const mockFetch = async (url, opts) => {
    callCount++;
    assert.equal(url, 'https://api.amazon.com/auth/o2/token');
    assert.ok(opts.body.includes('client_id=TEST_CLIENT'));
    assert.ok(opts.body.includes('scope=alexa%3A%3Aproactive_events'));
    return {
      ok: true,
      json: async () => ({
        access_token: 'MOCK_ACCESS_TOKEN_123',
        expires_in: 3600,
      }),
    };
  };

  const token1 = await getProactiveEventsToken({
    clientId: 'TEST_CLIENT',
    clientSecret: 'TEST_SECRET',
    fetchFn: mockFetch,
  });
  assert.equal(token1, 'MOCK_ACCESS_TOKEN_123');
  assert.equal(callCount, 1);

  // Second call should hit the memory cache
  const token2 = await getProactiveEventsToken({
    clientId: 'TEST_CLIENT',
    clientSecret: 'TEST_SECRET',
    fetchFn: mockFetch,
  });
  assert.equal(token2, 'MOCK_ACCESS_TOKEN_123');
  assert.equal(callCount, 1);
});

test('sendProactiveEvent successfully posts to EU and NA endpoints', async () => {
  let requestedUrl = null;
  let authHeader = null;

  const mockFetch = async (url, opts) => {
    requestedUrl = url;
    authHeader = opts.headers.Authorization;
    return {
      status: 202,
      text: async () => '',
    };
  };

  const payload = buildMediaAvailablePayload({ title: 'Test Book' });
  const res = await sendProactiveEvent({
    payload,
    stage: 'development',
    region: 'eu',
    accessToken: 'TEST_TOKEN',
    fetchFn: mockFetch,
  });

  assert.equal(res.success, true);
  assert.equal(res.statusCode, 202);
  assert.equal(requestedUrl, PROACTIVE_ENDPOINTS.eu.development);
  assert.equal(authHeader, 'Bearer TEST_TOKEN');
});

test('handleHttpRequest POST /webhook rejects missing or invalid secret when configured', async () => {
  const origSecret = process.env.WEBHOOK_SECRET;
  process.env.WEBHOOK_SECRET = 'supersecret123';

  try {
    const res = await handleHttpRequest({
      rawPath: '/webhook',
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ title: 'Test Book' }),
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'unauthorized');
  } finally {
    if (origSecret !== undefined) process.env.WEBHOOK_SECRET = origSecret;
    else delete process.env.WEBHOOK_SECRET;
  }
});

test('handleHttpRequest POST /webhook rejects invalid payload', async () => {
  const res = await handleHttpRequest({
    rawPath: '/webhook',
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ unknown: 'data' }),
  });

  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'bad_request');
});

test('handleHttpRequest POST /webhook returns 503 if Alexa credentials are not configured', async () => {
  const origId = process.env.ALEXA_CLIENT_ID;
  const origSecret = process.env.ALEXA_CLIENT_SECRET;
  delete process.env.ALEXA_CLIENT_ID;
  delete process.env.ALEXA_CLIENT_SECRET;

  try {
    const res = await handleHttpRequest({
      rawPath: '/webhook',
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ title: 'QualityLand von Marc-Uwe Kling' }),
    });

    assert.equal(res.statusCode, 503);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'service_unavailable');
  } finally {
    if (origId !== undefined) process.env.ALEXA_CLIENT_ID = origId;
    else delete process.env.ALEXA_CLIENT_ID;
    if (origSecret !== undefined) process.env.ALEXA_CLIENT_SECRET = origSecret;
    else delete process.env.ALEXA_CLIENT_SECRET;
  }
});

test('handleHttpRequest POST /webhook successfully processes and sends event', async () => {
  const origId = process.env.ALEXA_CLIENT_ID;
  const origSecret = process.env.ALEXA_CLIENT_SECRET;
  process.env.ALEXA_CLIENT_ID = 'test-id';
  process.env.ALEXA_CLIENT_SECRET = 'test-secret';

  // Mock global fetch to handle token and event requests
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('auth/o2/token')) {
      return {
        ok: true,
        json: async () => ({ access_token: 'fake-token', expires_in: 3600 }),
      };
    }
    if (url.includes('proactiveEvents')) {
      return {
        status: 202,
        text: async () => '',
      };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const res = await handleHttpRequest({
      rawPath: '/webhook',
      httpMethod: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Der Herr der Ringe',
        author: 'J.R.R. Tolkien',
        contentType: 'BOOK',
      }),
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'success');
    assert.equal(body.event, 'AMAZON.MediaContent.Available');
    assert.equal(body.content.title, 'Der Herr der Ringe');
    assert.equal(body.content.author, 'J.R.R. Tolkien');
  } finally {
    globalThis.fetch = origFetch;
    if (origId !== undefined) process.env.ALEXA_CLIENT_ID = origId;
    else delete process.env.ALEXA_CLIENT_ID;
    if (origSecret !== undefined) process.env.ALEXA_CLIENT_SECRET = origSecret;
    else delete process.env.ALEXA_CLIENT_SECRET;
  }
});
