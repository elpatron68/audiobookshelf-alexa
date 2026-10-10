'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  locateTrack,
  bookOffsetForTrack,
  findChapter,
  encodeToken,
  decodeToken,
  sleepDeadlineExpired,
  unitToSeconds,
} = require('../lib/playback');

test('locateTrack picks the track containing the offset', () => {
  const tracks = [{ duration: 100 }, { duration: 200 }, { duration: 50 }];
  assert.deepEqual(locateTrack(tracks, 0), { trackIndex: 0, offsetInTrack: 0 });
  assert.deepEqual(locateTrack(tracks, 99), { trackIndex: 0, offsetInTrack: 99 });
  assert.deepEqual(locateTrack(tracks, 100), { trackIndex: 1, offsetInTrack: 0 });
  assert.deepEqual(locateTrack(tracks, 250), { trackIndex: 1, offsetInTrack: 150 });
  assert.deepEqual(locateTrack(tracks, 9999), { trackIndex: 2, offsetInTrack: 9699 });
});

test('bookOffsetForTrack sums prior track durations', () => {
  const tracks = [{ duration: 100 }, { duration: 200 }, { duration: 50 }];
  assert.equal(bookOffsetForTrack(tracks, 0), 0);
  assert.equal(bookOffsetForTrack(tracks, 1), 100);
  assert.equal(bookOffsetForTrack(tracks, 2), 300);
});

test('encodeToken / decodeToken round-trip', () => {
  const state = { sessionId: 'abc', itemId: 'xyz', trackIndex: 2, trackStart: 1234 };
  const round = decodeToken(encodeToken(state));
  assert.deepEqual(round, state);
});

test('decodeToken handles bad input gracefully', () => {
  assert.equal(decodeToken(''), null);
  assert.equal(decodeToken(null), null);
  assert.equal(decodeToken('not-base64-json!!!'), null);
});

test('findChapter returns the chapter containing the offset', () => {
  const chapters = [
    { start: 0, end: 100, title: 'Eins' },
    { start: 100, end: 250, title: 'Zwei' },
    { start: 250, end: 300, title: 'Drei' },
  ];
  assert.deepEqual(findChapter(chapters, 0).chapter.title, 'Eins');
  assert.deepEqual(findChapter(chapters, 99).chapter.title, 'Eins');
  assert.deepEqual(findChapter(chapters, 100).chapter.title, 'Zwei');
  assert.deepEqual(findChapter(chapters, 200).chapter.title, 'Zwei');
  assert.deepEqual(findChapter(chapters, 250).chapter.title, 'Drei');
  // Past the last chapter end -> snap to last.
  assert.deepEqual(findChapter(chapters, 99999).chapter.title, 'Drei');
  assert.equal(findChapter([], 10), null);
  assert.equal(findChapter(null, 10), null);
});

test('sleepDeadlineExpired respects deadline and "now"', () => {
  const now = 1_700_000_000_000;
  assert.equal(sleepDeadlineExpired(null, now), false);
  assert.equal(sleepDeadlineExpired({}, now), false);
  assert.equal(sleepDeadlineExpired({ sleepDeadline: now + 1000 }, now), false);
  assert.equal(sleepDeadlineExpired({ sleepDeadline: now }, now), true);
  assert.equal(sleepDeadlineExpired({ sleepDeadline: now - 1 }, now), true);
});

test('unitToSeconds parses unit slot values across locales', () => {
  assert.equal(unitToSeconds('Sekunden'), 1);
  assert.equal(unitToSeconds('Sekunde'), 1);
  assert.equal(unitToSeconds('seconds'), 1);
  assert.equal(unitToSeconds('Minuten'), 60);
  assert.equal(unitToSeconds('Minute'), 60);
  assert.equal(unitToSeconds('minutes'), 60);
  assert.equal(unitToSeconds('Stunde'), 3600);
  assert.equal(unitToSeconds('hours'), 3600);
  assert.equal(unitToSeconds(undefined), 60);
  assert.equal(unitToSeconds('xyz'), 60);
});

test('sortEpisodes sorts chronologically', () => {
  const { sortEpisodes } = require('../lib/playback');
  const eps = [
    { id: '3', publishedAt: 300, episode: '3' },
    { id: '1', publishedAt: 100, episode: '1' },
    { id: '2', publishedAt: 200, episode: '2' },
  ];
  const asc = sortEpisodes(eps, { ascending: true });
  assert.deepEqual(asc.map((e) => e.id), ['1', '2', '3']);
  const desc = sortEpisodes(eps, { ascending: false });
  assert.deepEqual(desc.map((e) => e.id), ['3', '2', '1']);
});

test('parseEpisodeQuery parses digits, German word numbers, and latest keywords', () => {
  const { parseEpisodeQuery } = require('../lib/playback');
  assert.deepEqual(parseEpisodeQuery('neueste'), { isLatest: true });
  assert.deepEqual(parseEpisodeQuery('die letzte folge'), { isLatest: true });
  assert.deepEqual(parseEpisodeQuery('erste'), { isFirst: true });
  assert.equal(parseEpisodeQuery('folge 5').episodeNumber, 5);
  assert.equal(parseEpisodeQuery('folge fünf').episodeNumber, 5);
  assert.equal(parseEpisodeQuery('folge zwölf').episodeNumber, 12);
  assert.equal(parseEpisodeQuery('episode 42').episodeNumber, 42);
});

test('matchEpisode finds appropriate episode by query', () => {
  const { matchEpisode } = require('../lib/playback');
  const eps = [
    { id: 'ep-1', episode: '1', title: 'Folge 1 - Intro', publishedAt: 100 },
    { id: 'ep-2', episode: '2', title: 'Folge 2 - Deep Dive', publishedAt: 200 },
    { id: 'ep-3', episode: '3', title: 'Folge 3 - Finale', publishedAt: 300 },
  ];
  assert.equal(matchEpisode(eps, 'neueste').id, 'ep-3');
  assert.equal(matchEpisode(eps, 'erste').id, 'ep-1');
  assert.equal(matchEpisode(eps, 'folge 2').id, 'ep-2');
  assert.equal(matchEpisode(eps, 'zwei').id, 'ep-2');
  assert.equal(matchEpisode(eps, 'Deep Dive').id, 'ep-2');
  assert.equal(matchEpisode(eps, null).id, 'ep-3'); // default is latest
});
