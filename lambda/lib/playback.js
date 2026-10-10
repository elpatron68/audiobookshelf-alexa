'use strict';

// Helpers for turning an audiobookshelf item + playback session into the
// shape Alexa's AudioPlayer needs, and for round-tripping playback state
// through the AudioPlayer token.

// Concatenates audioTracks[*].duration to find which track contains a given
// "book-relative" offset (in seconds), and returns { trackIndex, offsetInTrack }.
function locateTrack(audioTracks, bookOffsetSec) {
  let acc = 0;
  for (let i = 0; i < audioTracks.length; i += 1) {
    const t = audioTracks[i];
    const end = acc + (t.duration || 0);
    if (bookOffsetSec < end || i === audioTracks.length - 1) {
      return { trackIndex: i, offsetInTrack: Math.max(0, bookOffsetSec - acc) };
    }
    acc = end;
  }
  return { trackIndex: 0, offsetInTrack: 0 };
}

// Sum of durations of tracks before `trackIndex`. Used to convert a
// per-track AudioPlayer offset back into a book-relative time.
function bookOffsetForTrack(audioTracks, trackIndex) {
  let acc = 0;
  for (let i = 0; i < trackIndex && i < audioTracks.length; i += 1) {
    acc += audioTracks[i].duration || 0;
  }
  return acc;
}

// Find the chapter that contains the given book-relative offset.
// audiobookshelf chapter shape: { id, start, end, title }.
// Returns { index, chapter } or null when the chapter list is empty.
function findChapter(chapters, bookOffsetSec) {
  if (!Array.isArray(chapters) || !chapters.length) return null;
  for (let i = 0; i < chapters.length; i += 1) {
    const c = chapters[i];
    if (bookOffsetSec >= c.start && bookOffsetSec < c.end) {
      return { index: i, chapter: c };
    }
  }
  // Past the last chapter end -> snap to the last chapter.
  const last = chapters.length - 1;
  return { index: last, chapter: chapters[last] };
}

// Compact JSON token Alexa echoes back on every AudioPlayer event. Keep
// it small — Alexa enforces a token length limit (~1024 chars).
function encodeToken(state) {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

function decodeToken(token) {
  if (!token) return null;
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

// True when the token carries a sleep deadline that has already passed.
function sleepDeadlineExpired(state, nowMs = Date.now()) {
  return Boolean(state && state.sleepDeadline && nowMs >= state.sleepDeadline);
}

// Convert {duration, unit} from a SetSleepTimer / Seek intent into seconds.
// Accepts either the resolved Amazon TimeUnit slot value (Sekunden/Minuten/
// seconds/minutes) or the raw user utterance.
function unitToSeconds(unit) {
  if (!unit) return 60; // default: minutes
  const u = String(unit).toLowerCase();
  if (u.startsWith('sek') || u.startsWith('sec')) return 1;
  if (u.startsWith('min')) return 60;
  if (u.startsWith('std') || u.startsWith('hour') || u.startsWith('stunde')) return 3600;
  return 60;
}

// Sort podcast episodes chronologically (default: oldest -> newest, so ep1 is index 0)
// or reverse (ascending: false -> newest first).
function sortEpisodes(episodes, { ascending = true } = {}) {
  if (!Array.isArray(episodes)) return [];
  const list = [...episodes];
  return list.sort((a, b) => {
    const timeA = a.publishedAt || (a.pubDate ? new Date(a.pubDate).getTime() : 0) || a.addedAt || 0;
    const timeB = b.publishedAt || (b.pubDate ? new Date(b.pubDate).getTime() : 0) || b.addedAt || 0;
    if (timeA !== timeB) {
      return ascending ? timeA - timeB : timeB - timeA;
    }
    const numA = parseInt(a.episode, 10);
    const numB = parseInt(b.episode, 10);
    if (!Number.isNaN(numA) && !Number.isNaN(numB) && numA !== numB) {
      return ascending ? numA - numB : numB - numA;
    }
    return 0;
  });
}

const NUMBER_WORDS = {
  eins: 1, eine: 1, ersten: 1, erste: 1, one: 1, first: 1,
  zwei: 2, zweiten: 2, zweite: 2, two: 2, second: 2,
  drei: 3, dritten: 3, dritte: 3, three: 3, third: 3,
  vier: 4, vierten: 4, vierte: 4, four: 4, fourth: 4,
  fünf: 5, fuenf: 5, fünften: 5, five: 5, fifth: 5,
  sechs: 6, sechsten: 6, six: 6, sixth: 6,
  sieben: 7, siebten: 7, seven: 7, seventh: 7,
  acht: 8, achten: 8, eight: 8, eighth: 8,
  neun: 9, neunten: 9, nine: 9, ninth: 9,
  zehn: 10, zehnten: 10, ten: 10, tenth: 10,
  elf: 11, elften: 11, eleven: 11,
  zwölf: 12, zwoelf: 12, zwölften: 12, twelve: 12,
  dreizehn: 13, dreizehnten: 13, thirteen: 13,
  vierzehn: 14, vierzehnten: 14, fourteen: 14,
  fünfzehn: 15, fuenfzehn: 15, fünfzehnten: 15, fifteen: 15,
  zwanzig: 20, zwanzigsten: 20, twenty: 20,
};

function parseEpisodeQuery(rawQuery) {
  if (!rawQuery) return { isLatest: true };
  const q = String(rawQuery).toLowerCase().trim();

  // Latest / Newest checks
  if (/\b(neueste|neuesten|aktuellste|aktuellsten|letzte|letzten|neue|latest|newest|last)\b/i.test(q)) {
    return { isLatest: true };
  }
  // First / Oldest checks
  if (/\b(erste|ersten|älteste|ältesten|first|oldest)\b/i.test(q)) {
    return { isFirst: true };
  }

  // Look for digit
  const digitMatch = q.match(/\b(\d+)\b/);
  if (digitMatch) {
    return { episodeNumber: parseInt(digitMatch[1], 10), textQuery: q };
  }

  // Look for word numbers
  for (const [word, val] of Object.entries(NUMBER_WORDS)) {
    const rx = new RegExp(`\\b${word}\\b`, 'i');
    if (rx.test(q)) {
      return { episodeNumber: val, textQuery: q };
    }
  }

  return { textQuery: q };
}

function matchEpisode(episodes, rawQuery) {
  if (!Array.isArray(episodes) || !episodes.length) return null;
  const sorted = sortEpisodes(episodes, { ascending: true }); // index 0 is oldest, last is newest
  const parsed = parseEpisodeQuery(rawQuery);

  if (parsed.isLatest) {
    return sorted[sorted.length - 1];
  }
  if (parsed.isFirst) {
    return sorted[0];
  }

  if (parsed.episodeNumber != null) {
    const num = parsed.episodeNumber;
    // 1. Direct match on episode attribute
    const byNum = sorted.find((ep) => parseInt(ep.episode, 10) === num);
    if (byNum) return byNum;

    // 2. Search in title e.g. "Folge 5" or "#5"
    const byTitleRx = new RegExp(`(?:folge|episode|#)\\s*0*${num}\\b`, 'i');
    const byTitle = sorted.find((ep) => ep.title && byTitleRx.test(ep.title));
    if (byTitle) return byTitle;

    // 3. Fallback: if num <= episodes.length, treat as 1-based index
    if (num >= 1 && num <= sorted.length) {
      return sorted[num - 1];
    }
  }

  if (parsed.textQuery) {
    const cleanQ = parsed.textQuery.replace(/^(folge|episode)\s+/i, '').trim();
    // Substring match in title
    const hit = sorted.find((ep) => (ep.title || '').toLowerCase().includes(cleanQ));
    if (hit) return hit;
  }

  // Fallback to latest
  return sorted[sorted.length - 1];
}

module.exports = {
  locateTrack,
  bookOffsetForTrack,
  findChapter,
  encodeToken,
  decodeToken,
  sleepDeadlineExpired,
  unitToSeconds,
  sortEpisodes,
  parseEpisodeQuery,
  matchEpisode,
};
