'use strict';

const Alexa = require('ask-sdk-core');
const { AbsClient, fromEnv } = require('./lib/absClient');
const { handleHttpRequest, decryptCredentials } = require('./lib/auth');
const {
  locateTrack,
  bookOffsetForTrack,
  findChapter,
  encodeToken,
  decodeToken,
  sleepDeadlineExpired,
  unitToSeconds,
  sortEpisodes,
  matchEpisode,
} = require('./lib/playback');
const { t } = require('./lib/strings');

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function speakerOf(handlerInput) {
  const locale = Alexa.getLocale(handlerInput.requestEnvelope) || 'en-US';
  return t(locale);
}

function getClient(handlerInput) {
  try {
    const reqEnv = handlerInput.requestEnvelope;
    // 1. Check for linked account access token from Alexa
    const token = reqEnv?.context?.System?.user?.accessToken
      || reqEnv?.session?.user?.accessToken;
    if (token) {
      const creds = decryptCredentials(token);
      if (creds && creds.baseUrl && creds.apiKey) {
        return new AbsClient(creds.baseUrl, creds.apiKey);
      }
    }

    // 2. Fallback to process.env for local development / legacy single-user
    if (process.env.ABS_BASE_URL && process.env.ABS_API_KEY) {
      return fromEnv(process.env);
    }

    // 3. User has not linked an account
    handlerInput.__needsLink = true;
    const speak = speakerOf(handlerInput);
    handlerInput.__speech = speak('accountNotLinked');
    return null;
  } catch (err) {
    console.error('Audiobookshelf client init failed:', err.message);
    const speak = speakerOf(handlerInput);
    handlerInput.__speech = speak('notConfigured');
    return null;
  }
}

function handleMissingClient(h) {
  const rb = h.responseBuilder.speak(h.__speech);
  if (h.__needsLink) {
    rb.withLinkAccountCard();
  }
  return rb.getResponse();
}

async function getLibraries(client) {
  const res = await client.listLibraries();
  return res.libraries || res || [];
}

async function getLibrariesByType(client, mediaType) {
  const libs = await getLibraries(client);
  if (!mediaType) return libs;
  return libs.filter((l) => l.mediaType === mediaType);
}

async function resolveLibraryId(client, preferredType = 'book') {
  if (process.env.ABS_DEFAULT_LIBRARY_ID) return process.env.ABS_DEFAULT_LIBRARY_ID;
  const libs = await getLibraries(client);
  const preferred = libs.find((l) => l.mediaType === preferredType);
  if (preferred) return preferred.id;
  const fallback = libs[0];
  if (!fallback) throw new Error('no libraries configured on audiobookshelf');
  return fallback.id;
}

// Generate progressively-broader search queries from a user utterance.
function searchVariants(query) {
  const variants = [];
  const push = (q) => {
    const s = (q || '').trim();
    if (s && !variants.includes(s)) variants.push(s);
  };
  push(query);

  const dehyphenated = query.replace(/[-–—]+/g, ' ').replace(/\s+/g, ' ').trim();
  push(dehyphenated);

  const stripped = dehyphenated.replace(
    /^(die|der|das|den|dem|des|ein|eine|einen|einem|einer|the|a|an)\s+/i,
    '',
  ).trim();
  push(stripped);

  const longest = stripped.split(/\s+/)
    .filter((w) => w.length >= 4)
    .sort((a, b) => b.length - a.length)[0];
  if (longest) push(longest);

  return variants;
}

function normalizeForMatch(s) {
  return (s || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '');
}

function fuzzyScore(qNorm, titleNorm) {
  if (!qNorm || !titleNorm) return 0;
  if (titleNorm.includes(qNorm) || qNorm.includes(titleNorm)) return 1;
  if (qNorm.length < 3) return 0;
  let hits = 0;
  for (let i = 0; i <= qNorm.length - 3; i += 1) {
    if (titleNorm.includes(qNorm.slice(i, i + 3))) hits += 1;
  }
  return hits / (qNorm.length - 2);
}

async function localFuzzyFind(client, libraries, query) {
  const qNorm = normalizeForMatch(query);
  if (!qNorm || qNorm.length < 3) return null;

  let best = null;
  let bestScore = 0;

  for (const lib of libraries) {
    const page = await client.listItems(lib.id, { limit: 1000, page: 0 }).catch(() => null);
    if (!page) continue;
    const items = (page.results || page.items || page || []);

    for (const it of items) {
      const meta = (it.media && it.media.metadata) || it.metadata || {};
      const candidates = [meta.title, meta.subtitle, meta.titleIgnorePrefix]
        .filter(Boolean)
        .map(normalizeForMatch);
      let score = 0;
      for (const c of candidates) {
        score = Math.max(score, fuzzyScore(qNorm, c));
      }
      if (score > bestScore) {
        bestScore = score;
        best = it;
      }
    }
  }

  return bestScore >= 0.5 ? best : null;
}

// Find media (audiobook or podcast) across relevant libraries.
async function findMedia(client, query, { mediaType = null } = {}) {
  const allLibs = await getLibraries(client);
  const targetLibs = mediaType
    ? allLibs.filter((l) => l.mediaType === mediaType)
    : allLibs;

  if (!targetLibs.length) return null;

  // 1. Fast path: Server-side search across target libraries
  for (const q of searchVariants(query)) {
    for (const lib of targetLibs) {
      const results = await client.search(lib.id, q, { limit: 5 }).catch(() => null);
      if (!results) continue;
      const hits = (results.book || results.podcast || results.items || []).map((h) => h.libraryItem || h);
      if (hits.length) return hits[0];
    }
  }

  // 2. Slow path: Local fuzzy search
  return localFuzzyFind(client, targetLibs, query);
}

// Compatibility helper for existing code/tests expecting findBook
async function findBook(client, libraryId, query) {
  const lib = libraryId ? [{ id: libraryId, mediaType: 'book' }] : await getLibrariesByType(client, 'book');
  for (const q of searchVariants(query)) {
    for (const l of lib) {
      const results = await client.search(l.id, q, { limit: 5 }).catch(() => null);
      if (!results) continue;
      const hits = (results.book || results.items || []).map((h) => h.libraryItem || h);
      if (hits.length) return hits[0];
    }
  }
  return localFuzzyFind(client, lib, query);
}

// Decoded AudioPlayer state from the inbound request (token + offset). Null
// when no playback context is attached.
function currentPlaybackState(handlerInput) {
  const ap = handlerInput.requestEnvelope.context && handlerInput.requestEnvelope.context.AudioPlayer;
  if (!ap || !ap.token) return null;
  const state = decodeToken(ap.token);
  if (!state) return null;
  const offsetSec = (ap.offsetInMilliseconds || 0) / 1000;
  return {
    ...state,
    offsetInTrackSec: offsetSec,
    bookOffset: (state.trackStart || 0) + offsetSec,
  };
}

// Build an AudioPlayer Play directive that streams an audiobookshelf item
// (either a book or a podcast episode) from a given offset.
async function buildPlayDirective(client, item, opts = {}) {
  const { bookOffsetSec = 0, sleepDeadline = null } = opts;
  const isPodcast = item.mediaType === 'podcast' || Boolean(item.media && Array.isArray(item.media.episodes));

  let session;
  let episode = null;
  const meta = (item.media && item.media.metadata) || {};
  let displayTitle = meta.title || 'Audio';
  let displaySubtitle = meta.authorName
    || (Array.isArray(meta.authors) && meta.authors.map((a) => a.name).join(', '))
    || '';

  if (isPodcast) {
    const episodes = (item.media && item.media.episodes) || [];
    if (!episodes.length) throw new Error(`podcast ${item.id} has no episodes`);

    if (opts.episode) {
      episode = opts.episode;
    } else if (opts.episodeId) {
      episode = episodes.find((e) => e.id === opts.episodeId) || episodes[0];
    } else if (opts.episodeQuery) {
      episode = matchEpisode(episodes, opts.episodeQuery);
    } else {
      // Check if user has an in-progress episode
      const inProg = episodes.find((e) => e.userMediaProgress && !e.userMediaProgress.isFinished && e.userMediaProgress.currentTime > 0);
      if (inProg) {
        episode = inProg;
        if (opts.bookOffsetSec === undefined || opts.bookOffsetSec === 0) {
          opts.bookOffsetSec = inProg.userMediaProgress.currentTime;
        }
      } else {
        const sorted = sortEpisodes(episodes, { ascending: true });
        episode = sorted[sorted.length - 1]; // latest episode
      }
    }

    session = await client.startPlaybackSession(item.id, { episodeId: episode.id });
    displayTitle = episode.title || `Episode ${episode.episode || ''}`;
    displaySubtitle = meta.title || 'Podcast';
  } else {
    session = await client.startPlaybackSession(item.id);
  }

  const tracks = session.audioTracks || [];
  if (!tracks.length) throw new Error(`item ${item.id} has no audio tracks`);

  const totalDuration = isPodcast
    ? ((episode && episode.duration) || tracks[0].duration || 0)
    : tracks.reduce((s, x) => s + (x.duration || 0), 0);

  const clampedOffset = Math.max(0, Math.min(bookOffsetSec, Math.max(0, totalDuration - 1)));
  const { trackIndex, offsetInTrack } = locateTrack(tracks, clampedOffset);
  const track = tracks[trackIndex];
  const url = client.streamUrlFor(track.contentUrl);

  const tokenState = {
    sessionId: session.id,
    itemId: item.id,
    mediaType: isPodcast ? 'podcast' : 'book',
    episodeId: episode ? episode.id : null,
    trackIndex,
    trackCount: tracks.length,
    trackStart: bookOffsetForTrack(tracks, trackIndex),
    bookDuration: totalDuration,
  };
  if (sleepDeadline) tokenState.sleepDeadline = sleepDeadline;

  const directive = {
    type: 'AudioPlayer.Play',
    playBehavior: 'REPLACE_ALL',
    audioItem: {
      stream: {
        token: encodeToken(tokenState),
        url,
        offsetInMilliseconds: Math.round(offsetInTrack * 1000),
      },
      metadata: { title: displayTitle, subtitle: displaySubtitle },
    },
  };

  return {
    directive,
    title: displayTitle,
    author: displaySubtitle,
    itemTitle: meta.title || displayTitle,
    session,
    tracks,
    bookDuration: totalDuration,
    isPodcast,
    episode,
  };
}

// Build a directive that enqueues the next track of a book or the next episode of a podcast.
async function buildEnqueueNextDirective(client, prevState) {
  if (sleepDeadlineExpired(prevState)) return null;

  // Podcast auto-enqueue: enqueue next chronological episode
  if (prevState.mediaType === 'podcast' && prevState.episodeId) {
    const item = await client.getItem(prevState.itemId);
    const episodes = (item.media && item.media.episodes) || [];
    const sorted = sortEpisodes(episodes, { ascending: true }); // index 0 is oldest, last is newest
    const currentIdx = sorted.findIndex((e) => e.id === prevState.episodeId);
    if (currentIdx === -1 || currentIdx >= sorted.length - 1) return null; // No next episode

    const nextEpisode = sorted[currentIdx + 1];
    const session = await client.startPlaybackSession(item.id, { episodeId: nextEpisode.id });
    const tracks = session.audioTracks || [];
    if (!tracks.length) return null;

    const url = client.streamUrlFor(tracks[0].contentUrl);
    const newTokenState = {
      sessionId: session.id,
      itemId: item.id,
      mediaType: 'podcast',
      episodeId: nextEpisode.id,
      trackIndex: 0,
      trackCount: tracks.length,
      trackStart: 0,
      bookDuration: nextEpisode.duration || tracks[0].duration || 0,
      sleepDeadline: prevState.sleepDeadline || null,
    };

    return {
      type: 'AudioPlayer.Play',
      playBehavior: 'ENQUEUE',
      audioItem: {
        stream: {
          token: encodeToken(newTokenState),
          expectedPreviousToken: encodeToken(prevState),
          url,
          offsetInMilliseconds: 0,
        },
      },
    };
  }

  // Audiobook track enqueue
  const { itemId, trackIndex, trackCount } = prevState;
  if (trackIndex == null || trackIndex >= (trackCount || 0) - 1) return null;

  const session = await client.startPlaybackSession(itemId);
  const tracks = session.audioTracks || [];
  const nextIndex = trackIndex + 1;
  if (!tracks[nextIndex]) return null;

  const url = client.streamUrlFor(tracks[nextIndex].contentUrl);
  const newTokenState = {
    ...prevState,
    sessionId: session.id,
    trackIndex: nextIndex,
    trackCount: tracks.length,
    trackStart: bookOffsetForTrack(tracks, nextIndex),
  };

  return {
    type: 'AudioPlayer.Play',
    playBehavior: 'ENQUEUE',
    audioItem: {
      stream: {
        token: encodeToken(newTokenState),
        expectedPreviousToken: encodeToken(prevState),
        url,
        offsetInMilliseconds: 0,
      },
    },
  };
}

// Re-launch playback at a new offset, preserving the existing sleepDeadline (if any).
async function relaunchAtOffset(client, current, newBookOffset, { sleepDeadline } = {}) {
  const item = await client.getItem(current.itemId);
  return buildPlayDirective(client, item, {
    episodeId: current.episodeId || null,
    bookOffsetSec: newBookOffset,
    sleepDeadline: sleepDeadline !== undefined ? sleepDeadline : current.sleepDeadline || null,
  });
}

// Localized labels for spoken units.
function unitLabel(locale, unitSlotValue, n) {
  const isDe = locale && locale.startsWith('de');
  const u = String(unitSlotValue || '').toLowerCase();
  if (u.startsWith('sek') || u.startsWith('sec')) return isDe ? (n === 1 ? 'Sekunde' : 'Sekunden') : (n === 1 ? 'second' : 'seconds');
  return isDe ? (n === 1 ? 'Minute' : 'Minuten') : (n === 1 ? 'minute' : 'minutes');
}

// ---------------------------------------------------------------------------
// Intent handlers — launch / informational
// ---------------------------------------------------------------------------

const LaunchRequestHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'LaunchRequest'; },
  handle(h) {
    const client = getClient(h);
    if (!client && h.__needsLink) {
      return handleMissingClient(h);
    }
    const speak = speakerOf(h);
    return h.responseBuilder.speak(speak('welcome')).reprompt(speak('help')).getResponse();
  },
};

const HelpIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.HelpIntent';
  },
  handle(h) {
    const speak = speakerOf(h);
    return h.responseBuilder.speak(speak('help')).reprompt(speak('help')).getResponse();
  },
};

const FallbackIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.FallbackIntent';
  },
  handle(h) {
    const speak = speakerOf(h);
    return h.responseBuilder.speak(speak('help')).reprompt(speak('help')).getResponse();
  },
};

const ListLibrariesIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'ListLibrariesIntent';
  },
  async handle(h) {
    const speak = speakerOf(h);
    const client = getClient(h);
    if (!client) return handleMissingClient(h);
    try {
      const libraries = await getLibraries(client);
      if (!libraries.length) return h.responseBuilder.speak(speak('noLibraries')).getResponse();
      return h.responseBuilder.speak(speak('libraries', libraries.map((l) => l.name))).getResponse();
    } catch (err) {
      console.error('ListLibrariesIntent error:', err);
      return h.responseBuilder.speak(speak('serverError')).getResponse();
    }
  },
};

const RecentBooksIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && (Alexa.getIntentName(h.requestEnvelope) === 'RecentBooksIntent'
        || Alexa.getIntentName(h.requestEnvelope) === 'RecentMediaIntent');
  },
  async handle(h) {
    const speak = speakerOf(h);
    const client = getClient(h);
    if (!client) return handleMissingClient(h);
    try {
      const libs = await getLibraries(client);
      const titles = [];
      for (const lib of libs) {
        const list = await client.listItems(lib.id, { limit: 3, sort: 'addedAt', desc: 1 }).catch(() => null);
        if (list) {
          const items = (list.results || list.items || []);
          for (const it of items) {
            const tName = it.media && it.media.metadata && it.media.metadata.title;
            if (tName && !titles.includes(tName)) titles.push(tName);
          }
        }
      }
      return h.responseBuilder.speak(speak('recentBooks', titles.slice(0, 5))).getResponse();
    } catch (err) {
      console.error('RecentBooksIntent error:', err);
      return h.responseBuilder.speak(speak('serverError')).getResponse();
    }
  },
};

const ListInProgressIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'ListInProgressIntent';
  },
  async handle(h) {
    const speak = speakerOf(h);
    const client = getClient(h);
    if (!client) return handleMissingClient(h);
    try {
      const me = await client.getMe();
      const inProg = (me.mediaProgress || [])
        .filter((p) => !p.isFinished && p.currentTime > 0)
        .sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0))
        .slice(0, 5);

      const titles = await Promise.all(inProg.map(async (p) => {
        try {
          const it = await client.getItem(p.libraryItemId);
          const metaTitle = it.media && it.media.metadata && it.media.metadata.title;
          if (p.episodeId && it.media && Array.isArray(it.media.episodes)) {
            const ep = it.media.episodes.find((e) => e.id === p.episodeId);
            return ep ? `${ep.title} (${metaTitle})` : metaTitle;
          }
          return metaTitle;
        } catch (_) { return null; }
      }));
      return h.responseBuilder.speak(speak('inProgress', titles.filter(Boolean))).getResponse();
    } catch (err) {
      console.error('ListInProgressIntent error:', err);
      return h.responseBuilder.speak(speak('serverError')).getResponse();
    }
  },
};

// ---------------------------------------------------------------------------
// Intent handlers — playback start / resume
// ---------------------------------------------------------------------------

const PlayBookIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'PlayBookIntent';
  },
  async handle(h) {
    const speak = speakerOf(h);
    const client = getClient(h);
    if (!client) return handleMissingClient(h);

    const query = Alexa.getSlotValue(h.requestEnvelope, 'bookTitle');
    if (!query) {
      return h.responseBuilder.speak(speak('noQuery')).reprompt(speak('noQuery')).getResponse();
    }
    try {
      // Find across all libraries (books or podcasts)
      const found = await findMedia(client, query);
      if (!found) return h.responseBuilder.speak(speak('bookNotFound', query)).getResponse();

      const fullItem = await client.getItem(found.id);
      const isPodcast = fullItem.mediaType === 'podcast' || Boolean(fullItem.media && Array.isArray(fullItem.media.episodes));

      let resumeAt = 0;
      if (!isPodcast) {
        const progress = fullItem.userMediaProgress || (fullItem.media && fullItem.media.userMediaProgress);
        resumeAt = progress && !progress.isFinished ? (progress.currentTime || 0) : 0;
      }

      const { directive, title, author, isPodcast: isPod } = await buildPlayDirective(client, fullItem, { bookOffsetSec: resumeAt });
      const speechText = isPod
        ? speak('playingPodcast', title, fullItem.media.metadata.title)
        : speak('playing', title, author);

      return h.responseBuilder.speak(speechText).addDirective(directive).getResponse();
    } catch (err) {
      console.error('PlayBookIntent error:', err);
      return h.responseBuilder.speak(speak('serverError')).getResponse();
    }
  },
};

const PlayPodcastIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'PlayPodcastIntent';
  },
  async handle(h) {
    const speak = speakerOf(h);
    const client = getClient(h);
    if (!client) return handleMissingClient(h);

    const query = Alexa.getSlotValue(h.requestEnvelope, 'podcastTitle')
      || Alexa.getSlotValue(h.requestEnvelope, 'bookTitle');
    if (!query) {
      return h.responseBuilder.speak(speak('noQuery')).reprompt(speak('noQuery')).getResponse();
    }

    try {
      const found = await findMedia(client, query, { mediaType: 'podcast' });
      if (!found) return h.responseBuilder.speak(speak('podcastNotFound', query)).getResponse();

      const fullItem = await client.getItem(found.id);
      const { directive, title, itemTitle } = await buildPlayDirective(client, fullItem);
      return h.responseBuilder
        .speak(speak('playingPodcast', title, itemTitle))
        .addDirective(directive)
        .getResponse();
    } catch (err) {
      console.error('PlayPodcastIntent error:', err);
      return h.responseBuilder.speak(speak('serverError')).getResponse();
    }
  },
};

const PlayEpisodeIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'PlayEpisodeIntent';
  },
  async handle(h) {
    const speak = speakerOf(h);
    const client = getClient(h);
    if (!client) return handleMissingClient(h);

    let podcastTitle = Alexa.getSlotValue(h.requestEnvelope, 'podcastTitle');
    let episodeQuery = Alexa.getSlotValue(h.requestEnvelope, 'episodeQuery')
      || Alexa.getSlotValue(h.requestEnvelope, 'episodeNumber');
    const episodeSearch = Alexa.getSlotValue(h.requestEnvelope, 'episodeSearch');

    if (!podcastTitle && episodeSearch) {
      // Handles phrases like:
      // "5 von Fest und Flauschig"
      // "die neueste von Tech Talk"
      // "fünf aus Fest und Flauschig"
      const matchSplit = episodeSearch.match(/^(?:folge\s+|episode\s+)?(.+?)\s+(?:von|aus|of|from)\s+(?:podcast\s+)?(.+)$/i);
      if (matchSplit) {
        episodeQuery = matchSplit[1].trim();
        podcastTitle = matchSplit[2].trim();
      } else {
        // Handles phrases like "Fest und Flauschig Folge 5"
        const reverseSplit = episodeSearch.match(/^(.+?)\s+(?:folge|episode)\s+(.+)$/i);
        if (reverseSplit) {
          podcastTitle = reverseSplit[1].trim();
          episodeQuery = reverseSplit[2].trim();
        } else if (/^\d+$/.test(episodeSearch.trim())) {
          episodeQuery = episodeSearch.trim();
        } else {
          podcastTitle = episodeSearch.trim();
        }
      }
    }

    try {
      let fullItem = null;
      if (podcastTitle) {
        const found = await findMedia(client, podcastTitle, { mediaType: 'podcast' });
        if (!found) return h.responseBuilder.speak(speak('podcastNotFound', podcastTitle)).getResponse();
        fullItem = await client.getItem(found.id);
      } else {
        // If no podcastTitle given (e.g. "spiele folge 5"), check currently playing podcast or in-progress
        const current = currentPlaybackState(h);
        if (current && current.mediaType === 'podcast' && current.itemId) {
          fullItem = await client.getItem(current.itemId);
        } else {
          const me = await client.getMe();
          const inProg = (me.mediaProgress || [])
            .filter((p) => !p.isFinished && p.episodeId)
            .sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0));
          if (inProg.length) {
            fullItem = await client.getItem(inProg[0].libraryItemId);
          }
        }
      }

      if (!fullItem) {
        return h.responseBuilder.speak(speak('noQuery')).reprompt(speak('noQuery')).getResponse();
      }

      const episodes = (fullItem.media && fullItem.media.episodes) || [];
      if (!episodes.length) return h.responseBuilder.speak(speak('noEpisodes')).getResponse();

      const matched = matchEpisode(episodes, episodeQuery);
      const titleName = (fullItem.media && fullItem.media.metadata && fullItem.media.metadata.title) || podcastTitle || '';
      if (!matched) return h.responseBuilder.speak(speak('episodeNotFound', episodeQuery || '', titleName)).getResponse();

      const { directive, title, itemTitle } = await buildPlayDirective(client, fullItem, { episode: matched });
      return h.responseBuilder
        .speak(speak('playingPodcast', title, itemTitle))
        .addDirective(directive)
        .getResponse();
    } catch (err) {
      console.error('PlayEpisodeIntent error:', err);
      return h.responseBuilder.speak(speak('serverError')).getResponse();
    }
  },
};

const ContinueListeningIntentHandler = {
  canHandle(h) {
    if (Alexa.getRequestType(h.requestEnvelope) !== 'IntentRequest') return false;
    const name = Alexa.getIntentName(h.requestEnvelope);
    return name === 'ContinueListeningIntent' || name === 'AMAZON.ResumeIntent';
  },
  async handle(h) {
    const speak = speakerOf(h);

    const ap = h.requestEnvelope.context && h.requestEnvelope.context.AudioPlayer;
    const intentName = Alexa.getIntentName(h.requestEnvelope);
    if (intentName === 'AMAZON.ResumeIntent' && ap && ap.playerActivity === 'PAUSED' && ap.token) {
      const state = decodeToken(ap.token);
      if (state) {
        const client = getClient(h);
        if (!client) return handleMissingClient(h);
        try {
          const { directive } = await relaunchAtOffset(client, {
            ...state,
            bookOffset: (state.trackStart || 0) + (ap.offsetInMilliseconds || 0) / 1000,
          }, (state.trackStart || 0) + (ap.offsetInMilliseconds || 0) / 1000);
          return h.responseBuilder.addDirective(directive).getResponse();
        } catch (err) {
          console.error('Resume current playback failed:', err);
        }
      }
    }

    const client = getClient(h);
    if (!client) return handleMissingClient(h);

    const query = Alexa.getSlotValue(h.requestEnvelope, 'bookTitle')
      || Alexa.getSlotValue(h.requestEnvelope, 'podcastTitle');

    try {
      let item;
      let targetEpisodeId = null;
      let resumeAt = 0;

      if (query) {
        const found = await findMedia(client, query);
        if (!found) return h.responseBuilder.speak(speak('bookNotFound', query)).getResponse();
        item = await client.getItem(found.id);

        if (item.mediaType === 'podcast' || (item.media && Array.isArray(item.media.episodes))) {
          // Check progress in podcast episodes
          const me = await client.getMe();
          const inProg = (me.mediaProgress || [])
            .filter((p) => p.libraryItemId === item.id && !p.isFinished && p.currentTime > 0)
            .sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0))[0];
          if (inProg) {
            targetEpisodeId = inProg.episodeId;
            resumeAt = inProg.currentTime;
          }
        } else {
          const progress = item.userMediaProgress || (item.media && item.media.userMediaProgress);
          resumeAt = progress && !progress.isFinished ? (progress.currentTime || 0) : 0;
        }
      } else {
        const me = await client.getMe();
        const inProgress = (me.mediaProgress || [])
          .filter((p) => !p.isFinished && p.currentTime > 0)
          .sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0));

        if (!inProgress.length) {
          return h.responseBuilder.speak(speak('nothingToResume')).getResponse();
        }

        const top = inProgress[0];
        item = await client.getItem(top.libraryItemId);
        targetEpisodeId = top.episodeId || null;
        resumeAt = top.currentTime || 0;
      }

      const { directive, title, author, isPodcast, itemTitle } = await buildPlayDirective(client, item, {
        episodeId: targetEpisodeId,
        bookOffsetSec: resumeAt,
      });

      const speechText = isPodcast
        ? speak('resumingPodcast', title, itemTitle)
        : speak('resuming', title, author);

      return h.responseBuilder.speak(speechText).addDirective(directive).getResponse();
    } catch (err) {
      console.error('ContinueListeningIntent error:', err);
      return h.responseBuilder.speak(speak('serverError')).getResponse();
    }
  },
};

// ---------------------------------------------------------------------------
// Intent handlers — chapter / episode navigation
// ---------------------------------------------------------------------------

const NextChapterIntentHandler = {
  canHandle(h) {
    if (Alexa.getRequestType(h.requestEnvelope) !== 'IntentRequest') return false;
    const n = Alexa.getIntentName(h.requestEnvelope);
    return n === 'AMAZON.NextIntent' || n === 'NextChapterIntent';
  },
  async handle(h) {
    const current = currentPlaybackState(h);
    if (current && current.mediaType === 'podcast') {
      return moveByEpisode(h, +1);
    }
    return moveByChapter(h, +1);
  },
};

const PreviousChapterIntentHandler = {
  canHandle(h) {
    if (Alexa.getRequestType(h.requestEnvelope) !== 'IntentRequest') return false;
    const n = Alexa.getIntentName(h.requestEnvelope);
    return n === 'AMAZON.PreviousIntent' || n === 'PreviousChapterIntent';
  },
  async handle(h) {
    const current = currentPlaybackState(h);
    if (current && current.mediaType === 'podcast') {
      return moveByEpisode(h, -1);
    }
    return moveByChapter(h, -1);
  },
};

const NextEpisodeIntentHandler = {
  canHandle(h) {
    if (Alexa.getRequestType(h.requestEnvelope) !== 'IntentRequest') return false;
    return Alexa.getIntentName(h.requestEnvelope) === 'NextEpisodeIntent';
  },
  async handle(h) {
    return moveByEpisode(h, +1);
  },
};

const PreviousEpisodeIntentHandler = {
  canHandle(h) {
    if (Alexa.getRequestType(h.requestEnvelope) !== 'IntentRequest') return false;
    return Alexa.getIntentName(h.requestEnvelope) === 'PreviousEpisodeIntent';
  },
  async handle(h) {
    return moveByEpisode(h, -1);
  },
};

async function moveByEpisode(h, direction) {
  const speak = speakerOf(h);
  const current = currentPlaybackState(h);
  if (!current) return h.responseBuilder.speak(speak('notPlaying')).getResponse();
  const client = getClient(h);
  if (!client) return handleMissingClient(h);

  try {
    const item = await client.getItem(current.itemId);
    const episodes = (item.media && item.media.episodes) || [];
    if (!episodes.length) return h.responseBuilder.speak(speak('noEpisodes')).getResponse();

    const sorted = sortEpisodes(episodes, { ascending: true }); // index 0 is oldest, last is newest
    const currentIdx = sorted.findIndex((e) => e.id === current.episodeId);

    const targetIdx = currentIdx === -1 ? sorted.length - 1 : currentIdx + direction;
    if (direction > 0 && targetIdx >= sorted.length) {
      return h.responseBuilder.speak(speak('alreadyAtNewestEpisode')).getResponse();
    }
    if (direction < 0 && targetIdx < 0) {
      return h.responseBuilder.speak(speak('alreadyAtOldestEpisode')).getResponse();
    }

    const target = sorted[targetIdx];
    const { directive } = await buildPlayDirective(client, item, {
      episode: target,
      bookOffsetSec: 0,
      sleepDeadline: current.sleepDeadline || null,
    });

    return h.responseBuilder
      .speak(speak('movedToEpisode', target.title || `Episode ${target.episode || ''}`))
      .addDirective(directive)
      .getResponse();
  } catch (err) {
    console.error('moveByEpisode error:', err);
    return h.responseBuilder.speak(speak('serverError')).getResponse();
  }
}

async function moveByChapter(h, direction) {
  const speak = speakerOf(h);
  const current = currentPlaybackState(h);
  if (!current) return h.responseBuilder.speak(speak('notPlaying')).getResponse();
  const client = getClient(h);
  if (!client) return handleMissingClient(h);
  try {
    const item = await client.getItem(current.itemId);
    const chapters = (item.media && item.media.chapters) || [];
    if (!chapters.length) return h.responseBuilder.speak(speak('noChapters')).getResponse();

    const found = findChapter(chapters, current.bookOffset);
    const idx = found ? found.index : 0;
    const targetIdx = idx + direction;
    if (targetIdx < 0) return h.responseBuilder.speak(speak('alreadyAtFirstChapter')).getResponse();
    if (targetIdx >= chapters.length) return h.responseBuilder.speak(speak('alreadyAtLastChapter')).getResponse();

    const target = chapters[targetIdx];
    const { directive } = await buildPlayDirective(client, item, {
      bookOffsetSec: target.start,
      sleepDeadline: current.sleepDeadline || null,
    });
    return h.responseBuilder
      .speak(speak('movedToChapter', target.title || `${targetIdx + 1}`))
      .addDirective(directive)
      .getResponse();
  } catch (err) {
    console.error('moveByChapter error:', err);
    return h.responseBuilder.speak(speak('serverError')).getResponse();
  }
}

// ---------------------------------------------------------------------------
// Intent handlers — seek
// ---------------------------------------------------------------------------

const SeekForwardIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'SeekForwardIntent';
  },
  async handle(h) { return seekBy(h, +1); },
};

const SeekBackwardIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'SeekBackwardIntent';
  },
  async handle(h) { return seekBy(h, -1); },
};

async function seekBy(h, sign) {
  const speak = speakerOf(h);
  const locale = Alexa.getLocale(h.requestEnvelope);
  const current = currentPlaybackState(h);
  if (!current) return h.responseBuilder.speak(speak('notPlaying')).getResponse();
  const client = getClient(h);
  if (!client) return handleMissingClient(h);

  const nRaw = Alexa.getSlotValue(h.requestEnvelope, 'duration');
  const unit = Alexa.getSlotValue(h.requestEnvelope, 'unit');
  const n = parseInt(nRaw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return h.responseBuilder.speak(speak('help')).getResponse();
  }
  const deltaSec = n * unitToSeconds(unit);
  const newOffset = Math.max(0, current.bookOffset + sign * deltaSec);

  try {
    const { directive } = await relaunchAtOffset(client, current, newOffset);
    const key = sign > 0 ? 'seekedForward' : 'seekedBackward';
    return h.responseBuilder
      .speak(speak(key, n, unitLabel(locale, unit, n)))
      .addDirective(directive)
      .getResponse();
  } catch (err) {
    console.error('seekBy error:', err);
    return h.responseBuilder.speak(speak('serverError')).getResponse();
  }
}

// ---------------------------------------------------------------------------
// Intent handlers — sleep timer
// ---------------------------------------------------------------------------

const SetSleepTimerIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'SetSleepTimerIntent';
  },
  async handle(h) {
    const speak = speakerOf(h);
    const locale = Alexa.getLocale(h.requestEnvelope);
    const current = currentPlaybackState(h);
    if (!current) return h.responseBuilder.speak(speak('notPlaying')).getResponse();
    const client = getClient(h);
    if (!client) return handleMissingClient(h);

    const nRaw = Alexa.getSlotValue(h.requestEnvelope, 'duration');
    const unit = Alexa.getSlotValue(h.requestEnvelope, 'unit');
    const n = parseInt(nRaw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      return h.responseBuilder.speak(speak('help')).getResponse();
    }
    const deadline = Date.now() + n * unitToSeconds(unit) * 1000;

    try {
      const { directive } = await relaunchAtOffset(client, current, current.bookOffset, { sleepDeadline: deadline });
      return h.responseBuilder
        .speak(speak('sleepTimerSet', n, unitLabel(locale, unit, n)))
        .addDirective(directive)
        .getResponse();
    } catch (err) {
      console.error('SetSleepTimerIntent error:', err);
      return h.responseBuilder.speak(speak('serverError')).getResponse();
    }
  },
};

const CancelSleepTimerIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'CancelSleepTimerIntent';
  },
  async handle(h) {
    const speak = speakerOf(h);
    const current = currentPlaybackState(h);
    if (!current) return h.responseBuilder.speak(speak('noSleepTimer')).getResponse();
    if (!current.sleepDeadline) return h.responseBuilder.speak(speak('noSleepTimer')).getResponse();
    const client = getClient(h);
    if (!client) return handleMissingClient(h);
    try {
      const { directive } = await relaunchAtOffset(client, current, current.bookOffset, { sleepDeadline: null });
      return h.responseBuilder.speak(speak('sleepTimerCancelled')).addDirective(directive).getResponse();
    } catch (err) {
      console.error('CancelSleepTimerIntent error:', err);
      return h.responseBuilder.speak(speak('serverError')).getResponse();
    }
  },
};

// ---------------------------------------------------------------------------
// Transport (Pause/Stop) and PlaybackController (hardware buttons)
// ---------------------------------------------------------------------------

const PauseIntentHandler = {
  canHandle(h) {
    if (Alexa.getRequestType(h.requestEnvelope) !== 'IntentRequest') return false;
    const n = Alexa.getIntentName(h.requestEnvelope);
    return n === 'AMAZON.PauseIntent' || n === 'AMAZON.StopIntent' || n === 'AMAZON.CancelIntent';
  },
  handle(h) {
    return h.responseBuilder.addDirective({ type: 'AudioPlayer.Stop' }).getResponse();
  },
};

const PlaybackControllerHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope).startsWith('PlaybackController.');
  },
  async handle(h) {
    const type = h.requestEnvelope.request.type;
    if (type === 'PlaybackController.PauseCommandIssued') {
      return h.responseBuilder.addDirective({ type: 'AudioPlayer.Stop' }).getResponse();
    }
    if (type === 'PlaybackController.PlayCommandIssued') {
      const current = currentPlaybackState(h);
      if (!current) return h.responseBuilder.getResponse();
      const client = getClient(h);
      if (!client) return h.responseBuilder.getResponse();
      const { directive } = await relaunchAtOffset(client, current, current.bookOffset);
      return h.responseBuilder.addDirective(directive).getResponse();
    }
    if (type === 'PlaybackController.NextCommandIssued') {
      const current = currentPlaybackState(h);
      if (current && current.mediaType === 'podcast') return moveByEpisode(h, +1);
      return moveByChapter(h, +1);
    }
    if (type === 'PlaybackController.PreviousCommandIssued') {
      const current = currentPlaybackState(h);
      if (current && current.mediaType === 'podcast') return moveByEpisode(h, -1);
      return moveByChapter(h, -1);
    }
    return h.responseBuilder.getResponse();
  },
};

// ---------------------------------------------------------------------------
// AudioPlayer events: progress sync + auto-enqueue + sleep timer enforcement
// ---------------------------------------------------------------------------

const AudioPlayerEventHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope).startsWith('AudioPlayer.');
  },
  async handle(h) {
    const req = h.requestEnvelope.request;
    const type = req.type;
    console.log('AudioPlayer event:', type, JSON.stringify({ error: req.error, offsetInMilliseconds: req.offsetInMilliseconds }));
    const state = decodeToken(req.token);
    if (!state) return h.responseBuilder.getResponse();

    let client = null;
    try { client = getClient(h); } catch (_) { /* noop */ }

    const offsetSec = (req.offsetInMilliseconds || 0) / 1000;
    const currentOffset = (state.trackStart || 0) + offsetSec;

    try {
      if (client && state.sessionId
        && (type === 'AudioPlayer.PlaybackStopped'
          || type === 'AudioPlayer.PlaybackFinished'
          || type === 'AudioPlayer.PlaybackNearlyFinished')) {
        await client.syncSession(state.sessionId, {
          currentTime: currentOffset,
          timeListened: 5,
          duration: state.bookDuration || 0,
        }).catch((e) => console.warn('session sync failed:', e.message));
      }

      if (type === 'AudioPlayer.PlaybackNearlyFinished' && client) {
        if (sleepDeadlineExpired(state)) {
          return h.responseBuilder.getResponse();
        }
        const next = await buildEnqueueNextDirective(client, state).catch((e) => {
          console.warn('enqueue next failed:', e.message);
          return null;
        });
        if (next) return h.responseBuilder.addDirective(next).getResponse();
      }
    } catch (err) {
      console.error('AudioPlayer handler error:', err);
    }

    return h.responseBuilder.getResponse();
  },
};

const SessionEndedRequestHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'SessionEndedRequest'; },
  handle(h) { return h.responseBuilder.getResponse(); },
};

const ErrorHandler = {
  canHandle() { return true; },
  handle(h, err) {
    console.error('Unhandled error:', err);
    const speak = speakerOf(h);
    return h.responseBuilder.speak(speak('serverError')).getResponse();
  },
};

// ---------------------------------------------------------------------------
// Skill entry point
// ---------------------------------------------------------------------------

const skillLambda = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    PlayPodcastIntentHandler,
    PlayEpisodeIntentHandler,
    PlayBookIntentHandler,
    ContinueListeningIntentHandler,
    ListInProgressIntentHandler,
    ListLibrariesIntentHandler,
    RecentBooksIntentHandler,
    NextEpisodeIntentHandler,
    PreviousEpisodeIntentHandler,
    NextChapterIntentHandler,
    PreviousChapterIntentHandler,
    SeekForwardIntentHandler,
    SeekBackwardIntentHandler,
    SetSleepTimerIntentHandler,
    CancelSleepTimerIntentHandler,
    PauseIntentHandler,
    PlaybackControllerHandler,
    HelpIntentHandler,
    FallbackIntentHandler,
    AudioPlayerEventHandler,
    SessionEndedRequestHandler,
  )
  .addErrorHandlers(ErrorHandler)
  .lambda();

exports.handler = async (event, context, callback) => {
  // If invoked via Lambda Function URL / HTTP request (Account Linking portal)
  if (event.rawPath || event.requestContext?.http || (event.httpMethod && !event.request)) {
    return handleHttpRequest(event);
  }
  return skillLambda(event, context, callback);
};

// Exported for testing
exports._internals = {
  buildPlayDirective,
  buildEnqueueNextDirective,
  relaunchAtOffset,
  currentPlaybackState,
  findMedia,
  getLibraries,
};
