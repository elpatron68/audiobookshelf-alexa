'use strict';

// In-memory fake of the audiobookshelf HTTP API, just enough for the
// handler tests. Install via installFetch() — replaces globalThis.fetch
// with a router that serves canned responses out of the FIXTURE state.
// Restore with restoreFetch() in test cleanup.

const FIXTURE = {
  baseUrl: 'https://abs.test',
  apiKey: 'test-key',
  libraries: [
    { id: 'lib-1', name: 'Books', mediaType: 'book' },
    { id: 'lib-2', name: 'Podcasts', mediaType: 'podcast' },
  ],
  // Keyed by item id. audioFiles[].duration sums to media.duration; chapters
  // align to file boundaries here, but they don't have to in real data.
  items: {
    'item-A': {
      id: 'item-A',
      mediaType: 'book',
      media: {
        metadata: { title: 'The Hobbit', authorName: 'Tolkien' },
        chapters: [
          { id: 0, start: 0, end: 60, title: 'Chapter 1' },
          { id: 1, start: 60, end: 150, title: 'Chapter 2' },
          { id: 2, start: 150, end: 180, title: 'Chapter 3' },
        ],
        audioFiles: [
          { ino: '101', duration: 60 },
          { ino: '102', duration: 90 },
          { ino: '103', duration: 30 },
        ],
        duration: 180,
      },
      // 70s -> within Chapter 2, 10s into track 102.
      userMediaProgress: {
        currentTime: 70,
        duration: 180,
        isFinished: false,
        lastUpdate: 1_700_000_000_000,
      },
    },
    'item-B': {
      id: 'item-B',
      mediaType: 'book',
      media: {
        metadata: { title: 'Dune', authorName: 'Herbert' },
        chapters: [
          { id: 0, start: 0, end: 120, title: 'Part 1' },
          { id: 1, start: 120, end: 220, title: 'Part 2' },
        ],
        audioFiles: [
          { ino: '201', duration: 120 },
          { ino: '202', duration: 100 },
        ],
        duration: 220,
      },
      userMediaProgress: null,
    },
    'item-pod-1': {
      id: 'item-pod-1',
      mediaType: 'podcast',
      media: {
        metadata: { title: 'Tech Talk', author: 'Coder' },
        episodes: [
          {
            id: 'ep-1',
            title: 'Episode 1: Hello World',
            episode: '1',
            publishedAt: 1_700_000_000_000,
            duration: 120,
            audioTrack: {
              contentUrl: '/api/items/item-pod-1/file/track-ep1',
              duration: 120,
            },
          },
          {
            id: 'ep-2',
            title: 'Episode 2: Deep Dive',
            episode: '2',
            publishedAt: 1_700_100_000_000,
            duration: 180,
            audioTrack: {
              contentUrl: '/api/items/item-pod-1/file/track-ep2',
              duration: 180,
            },
          },
        ],
      },
      userMediaProgress: null,
    },
  },
  me: {
    username: 'tester',
    mediaProgress: [
      {
        libraryItemId: 'item-A',
        currentTime: 70,
        duration: 180,
        isFinished: false,
        lastUpdate: 1_700_000_000_000,
      },
    ],
  },
  // Sessions live for the duration of a single test; recorded so that
  // tests can assert on sync calls made by AudioPlayerEventHandler.
  sessions: new Map(),
  syncCalls: [],
};

function audioTracksFor(item, episodeId = null) {
  if (item.mediaType === 'podcast' || (item.media && item.media.episodes)) {
    const ep = (item.media.episodes || []).find((e) => e.id === episodeId) || (item.media.episodes || [])[0];
    if (!ep) return [];
    return [{
      index: 1,
      title: ep.title,
      duration: ep.duration,
      mimeType: 'audio/mpeg',
      contentUrl: ep.audioTrack ? ep.audioTrack.contentUrl : `/api/items/${item.id}/file/${ep.id}`,
      startOffset: 0,
    }];
  }

  let acc = 0;
  return (item.media.audioFiles || []).map((f, i) => {
    const t = {
      index: i + 1,
      title: `Track ${i + 1}`,
      duration: f.duration,
      mimeType: 'audio/mpeg',
      contentUrl: `/api/items/${item.id}/file/${f.ino}`,
      startOffset: acc,
    };
    acc += f.duration;
    return t;
  });
}

function makeResponse(body, { status = 200, contentType = 'application/json' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => text,
  };
}

function notFound(path) {
  return makeResponse({ error: `not found: ${path}` }, { status: 404 });
}

async function route(url, init = {}) {
  const u = new URL(url);
  const path = u.pathname;
  const method = (init.method || 'GET').toUpperCase();

  // Listings
  if (method === 'GET' && path === '/api/libraries') {
    return makeResponse({ libraries: FIXTURE.libraries });
  }

  let m;
  if ((m = path.match(/^\/api\/libraries\/([^/]+)\/items$/)) && method === 'GET') {
    const libId = m[1];
    const lib = FIXTURE.libraries.find((l) => l.id === libId);
    if (!lib) return notFound(path);
    const all = Object.values(FIXTURE.items).filter((it) => {
      if (lib.mediaType === 'podcast') return it.mediaType === 'podcast';
      return it.mediaType !== 'podcast';
    });
    const limit = parseInt(u.searchParams.get('limit') || '50', 10);
    return makeResponse({ results: all.slice(0, limit), total: all.length });
  }

  if ((m = path.match(/^\/api\/libraries\/([^/]+)\/search$/)) && method === 'GET') {
    const libId = m[1];
    const lib = FIXTURE.libraries.find((l) => l.id === libId);
    const q = (u.searchParams.get('q') || '').toLowerCase();
    const hits = Object.values(FIXTURE.items)
      .filter((it) => {
        if (lib && lib.mediaType === 'podcast' && it.mediaType !== 'podcast') return false;
        if (lib && lib.mediaType === 'book' && it.mediaType === 'podcast') return false;
        return it.media.metadata.title.toLowerCase().includes(q);
      })
      .map((it) => ({ libraryItem: it }));

    if (lib && lib.mediaType === 'podcast') {
      return makeResponse({ podcast: hits });
    }
    return makeResponse({ book: hits });
  }

  if ((m = path.match(/^\/api\/items\/([^/]+)$/)) && method === 'GET') {
    const item = FIXTURE.items[m[1]];
    return item ? makeResponse(item) : notFound(path);
  }

  if ((m = path.match(/^\/api\/items\/([^/]+)\/play(?:\/([^/]+))?$/)) && method === 'POST') {
    const itemId = m[1];
    const episodeId = m[2];
    const item = FIXTURE.items[itemId];
    if (!item || (item.media && (item.media.ebookFile || item.media.numAudioFiles === 0))) return notFound(path);
    const sessionId = `sess-${itemId}-${FIXTURE.sessions.size + 1}`;
    const audioTracks = audioTracksFor(item, episodeId);
    FIXTURE.sessions.set(sessionId, { itemId, episodeId, audioTracks });
    const body = init.body ? JSON.parse(init.body) : {};
    return makeResponse({
      id: sessionId,
      audioTracks,
      mediaPlayer: body.mediaPlayer,
      playMethod: 0,
    });
  }

  if ((m = path.match(/^\/api\/session\/([^/]+)\/sync$/)) && method === 'POST') {
    const body = init.body ? JSON.parse(init.body) : {};
    FIXTURE.syncCalls.push({ sessionId: m[1], ...body });
    return makeResponse('OK', { contentType: 'text/plain' });
  }

  if (path.match(/^\/api\/session\/[^/]+\/close$/) && method === 'POST') {
    return makeResponse('OK', { contentType: 'text/plain' });
  }

  if (method === 'GET' && path === '/api/me') {
    return makeResponse(FIXTURE.me);
  }

  // Stream URL — handler tests don't fetch streams, but exercise via HEAD
  // if anyone wants to.
  if (path.match(/^\/api\/items\/[^/]+\/file\/[^/]+$/)) {
    return makeResponse('', {
      contentType: 'audio/mpeg',
      status: method === 'HEAD' ? 200 : 200,
    });
  }

  return notFound(path);
}

let savedFetch = null;
function installFetch() {
  if (savedFetch === null) savedFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => route(url, init);
  process.env.ABS_BASE_URL = FIXTURE.baseUrl;
  process.env.ABS_API_KEY = FIXTURE.apiKey;
  // Reset per-test state.
  FIXTURE.sessions.clear();
  FIXTURE.syncCalls.length = 0;
}

function restoreFetch() {
  if (savedFetch !== null) globalThis.fetch = savedFetch;
  savedFetch = null;
}

module.exports = { FIXTURE, installFetch, restoreFetch, audioTracksFor };
