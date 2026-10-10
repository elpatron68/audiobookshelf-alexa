'use strict';

const crypto = require('node:crypto');

// Alexa Proactive Events endpoints by region and stage
const PROACTIVE_ENDPOINTS = {
  eu: {
    development: 'https://api.eu.amazonalexa.com/v1/proactiveEvents/stages/development',
    live: 'https://api.eu.amazonalexa.com/v1/proactiveEvents/stages/live',
  },
  na: {
    development: 'https://api.amazonalexa.com/v1/proactiveEvents/stages/development',
    live: 'https://api.amazonalexa.com/v1/proactiveEvents/stages/live',
  },
  fe: {
    development: 'https://api.fe.amazonalexa.com/v1/proactiveEvents/stages/development',
    live: 'https://api.fe.amazonalexa.com/v1/proactiveEvents/stages/live',
  },
};

// In-memory token cache to avoid requesting an LWA token on every notification
let tokenCache = {
  token: null,
  expiresAt: 0,
};

/**
 * Resets in-memory token cache (useful for testing).
 */
function resetTokenCache() {
  tokenCache = { token: null, expiresAt: 0 };
}

/**
 * Fetches an LWA access token for the proactive events scope.
 */
async function getProactiveEventsToken({
  clientId = process.env.ALEXA_CLIENT_ID,
  clientSecret = process.env.ALEXA_CLIENT_SECRET,
  tokenUrl = 'https://api.amazon.com/auth/o2/token',
  fetchFn = fetch,
} = {}) {
  if (!clientId || !clientSecret) {
    throw new Error('ALEXA_CLIENT_ID and ALEXA_CLIENT_SECRET are required to send proactive events.');
  }

  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 60000) {
    return tokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'alexa::proactive_events',
  }).toString();

  const res = await fetchFn(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to retrieve LWA proactive events token (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Invalid token response from LWA: missing access_token');
  }

  tokenCache = {
    token: data.access_token,
    expiresAt: now + (data.expires_in || 3600) * 1000,
  };

  return tokenCache.token;
}

/**
 * Formats an AMAZON.MediaContent.Available event payload.
 *
 * @param {Object} options
 * @param {string} options.title - The title of the book or episode
 * @param {string} [options.author] - Optional author / creator name
 * @param {string} [options.contentType] - 'BOOK', 'EPISODE', or 'ALBUM' (default: 'BOOK')
 * @param {string} [options.providerName] - Provider name (default: 'Audiobookshelf')
 * @param {string} [options.method] - 'RELEASE', 'STREAM', or 'AIR' (default: 'RELEASE')
 * @param {string} [options.userId] - Optional Alexa userId for Unicast (default: Multicast broadcast)
 * @param {number} [options.expiryHours] - Expiry in hours from now (default: 24)
 * @param {string} [options.referenceId] - Custom reference ID (default: generated UUID)
 * @param {Date} [options.now] - Current date/time reference
 */
function buildMediaAvailablePayload({
  title,
  author,
  contentType = 'BOOK',
  providerName = 'Audiobookshelf',
  method = 'RELEASE',
  userId = null,
  expiryHours = 24,
  referenceId = null,
  now = new Date(),
} = {}) {
  if (!title || !title.trim()) {
    throw new Error('Title is required for AMAZON.MediaContent.Available event');
  }

  const cleanTitle = title.trim();
  const startTime = now.toISOString();
  const expiryTime = new Date(now.getTime() + expiryHours * 3600 * 1000).toISOString();
  const refId = referenceId || `urn:uuid:${crypto.randomUUID()}`;

  // Content type normalization
  const validTypes = ['BOOK', 'EPISODE', 'ALBUM', 'SINGLE', 'MOVIE', 'GAME'];
  const normalizedType = validTypes.includes((contentType || '').toUpperCase())
    ? contentType.toUpperCase()
    : 'BOOK';

  // Method normalization
  const validMethods = ['RELEASE', 'STREAM', 'AIR', 'PREMIERE', 'DROP'];
  const normalizedMethod = validMethods.includes((method || '').toUpperCase())
    ? method.toUpperCase()
    : 'RELEASE';

  // Audience
  const relevantAudience = userId
    ? { type: 'Unicast', payload: { user: userId } }
    : { type: 'Multicast' };

  // Content display name with optional author
  const displayNameDe = author && author.trim()
    ? `${cleanTitle} von ${author.trim()}`
    : cleanTitle;

  const displayNameEn = author && author.trim()
    ? `${cleanTitle} by ${author.trim()}`
    : cleanTitle;

  return {
    timestamp: startTime,
    referenceId: refId,
    expiryTime,
    event: {
      name: 'AMAZON.MediaContent.Available',
      payload: {
        availability: {
          startTime,
          provider: {
            name: 'localized:provider.name',
          },
          method: normalizedMethod,
        },
        content: {
          name: 'localized:content.name',
          contentType: normalizedType,
        },
      },
    },
    localizedAttributes: [
      {
        locale: 'de-DE',
        'provider.name': providerName,
        'content.name': displayNameDe,
      },
      {
        locale: 'en-US',
        'provider.name': providerName,
        'content.name': displayNameEn,
      },
    ],
    relevantAudience,
  };
}

/**
 * Parses incoming webhook body from Audiobookshelf or Apprise.
 * Supports:
 * 1. Audiobookshelf native webhook event format:
 *    { event: "item_added", item: { mediaType: "book", media: { metadata: { title: "..." } } } }
 * 2. Apprise notification format:
 *    { title: "...", body: "...", type: "info" }
 * 3. Simple custom payload:
 *    { title: "...", author: "...", contentType: "book" }
 */
function parseWebhookPayload(body) {
  if (!body) return null;
  let data = body;
  if (typeof body === 'string') {
    try {
      data = JSON.parse(body);
    } catch {
      const params = new URLSearchParams(body);
      const title = params.get('title');
      const bodyText = params.get('body');
      if (title || bodyText) {
        data = { title: title || bodyText, body: bodyText };
      } else {
        return null;
      }
    }
  }

  // 1. Audiobookshelf native webhook event format
  if (data.item || data.libraryItem) {
    const item = data.item || data.libraryItem;
    const media = item.media || {};
    const metadata = media.metadata || item.metadata || {};
    const title = metadata.title || item.title || item.name || '';
    const author = metadata.authorName || metadata.author || '';
    const mediaType = (item.mediaType || media.mediaType || 'book').toLowerCase();
    const contentType = mediaType === 'podcast' ? 'EPISODE' : 'BOOK';

    if (title) {
      return {
        title,
        author,
        contentType,
        raw: data,
      };
    }
  }

  // 2. Standard Apprise format: { title: "...", body: "..." }
  if (data.title || data.body) {
    let title = (data.title || '').trim();
    let bodyText = (data.body || '').trim();

    // If title is generic (e.g. "Audiobookshelf", "Neues Hörbuch hinzugefügt", "item_added"), use body as title
    const isGenericTitle = /^(audiobookshelf|neues?\s+(element|h[öo]rbuch|buch|podcast|titel).*|item[_\s]added|notification.*)$/i.test(title);
    if ((isGenericTitle || !title) && bodyText) {
      title = bodyText;
      bodyText = '';
    }

    // Try extracting author if title or body is formatted as "... von / by ..."
    let author = data.author || '';
    if (!author && title.includes(' von ')) {
      const parts = title.split(' von ');
      title = parts[0].trim();
      author = parts.slice(1).join(' von ').trim();
    } else if (!author && title.includes(' by ')) {
      const parts = title.split(' by ');
      title = parts[0].trim();
      author = parts.slice(1).join(' by ').trim();
    } else if (!author && bodyText && (bodyText.startsWith('von ') || bodyText.startsWith('by '))) {
      author = bodyText.replace(/^(von|by)\s+/i, '').trim();
    }

    const contentType = (data.contentType || (data.type === 'podcast' ? 'EPISODE' : 'BOOK')).toUpperCase();

    return {
      title: title || 'Neues Bibliotheks-Element',
      author,
      contentType: contentType === 'EPISODE' ? 'EPISODE' : 'BOOK',
      raw: data,
    };
  }

  return null;
}

/**
 * Sends a proactive event to the Alexa Proactive Events API.
 */
async function sendProactiveEvent({
  payload,
  stage = process.env.ALEXA_SKILL_STAGE || 'development',
  region = process.env.ALEXA_API_REGION || 'eu',
  accessToken,
  clientId,
  clientSecret,
  fetchFn = fetch,
} = {}) {
  const token = accessToken || await getProactiveEventsToken({ clientId, clientSecret, fetchFn });

  const regionEndpoints = PROACTIVE_ENDPOINTS[region.toLowerCase()] || PROACTIVE_ENDPOINTS.eu;
  const endpoint = regionEndpoints[stage.toLowerCase()] || regionEndpoints.development;

  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  // 202 Accepted indicates success per ASK Proactive Events specification
  if (res.status === 202) {
    return {
      success: true,
      statusCode: 202,
      referenceId: payload.referenceId,
    };
  }

  const errText = await res.text().catch(() => '');
  throw new Error(`Alexa Proactive Events API responded with status ${res.status}: ${errText}`);
}

module.exports = {
  buildMediaAvailablePayload,
  parseWebhookPayload,
  getProactiveEventsToken,
  sendProactiveEvent,
  resetTokenCache,
  PROACTIVE_ENDPOINTS,
};
