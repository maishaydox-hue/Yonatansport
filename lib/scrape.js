const cheerio = require('cheerio');

const BASE_URL = 'https://www.football.org.il/players/player/';
const GAMES_ENDPOINT = 'https://www.football.org.il/Components.asmx/GetPlayerGames';

// Simple in-memory cache so we don't hammer the federation site on every page load.
const cache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function cacheKey(playerId, seasonId) {
  return `${playerId}:${seasonId || 'default'}`;
}

function cleanText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

function findHeadingEl($, headingText) {
  let found = null;
  $('h1,h2,h3,h4').each((_, el) => {
    if (found) return;
    if (cleanText($(el).text()).includes(headingText)) found = el;
  });
  return found;
}

function extractSeasons($) {
  let seasons = [];
  $('select').each((_, select) => {
    if (seasons.length) return;
    const $select = $(select);
    const options = $select.find('option');
    if (!options.length) return;
    const yearPattern = /\d{4}\/\d{4}/;
    let matchCount = 0;
    options.each((__, opt) => {
      if (yearPattern.test(cleanText($(opt).text()))) matchCount++;
    });
    if (matchCount >= Math.max(2, Math.floor(options.length * 0.6))) {
      options.each((__, opt) => {
        const $opt = $(opt);
        seasons.push({
          value: $opt.attr('value') || '',
          label: cleanText($opt.text()),
          selected: $opt.attr('selected') !== undefined || $select.val() === $opt.attr('value'),
        });
      });
    }
  });
  return seasons;
}

function categorizeFramework(frameworkText) {
  const text = frameworkText || '';
  if (/טוטו/.test(text)) return 'toto';
  if (/גביע/.test(text)) return 'cup';
  return 'league';
}

/**
 * Strips the accessibility "sr-only" label span from a column div/element and
 * returns the remaining visible text (the actual value).
 */
function stripSrOnlyLabel($$, $el) {
  const $clone = $el.clone();
  $clone.find('.sr-only').remove();
  return cleanText($clone.text());
}

/**
 * Parses the HTML fragment returned by football.org.il's
 * Components.asmx/GetPlayerGames endpoint (one <a class="table_row"> per
 * game) into a clean games list plus aggregated goals/cards totals.
 *
 * Real observed row shape (7 columns in fixed order):
 *   0: date   1: framework/competition   2: match (two team-name-text spans)
 *   3: result   4: goals scored (may be empty = 0)
 *   5: cards (span.card-yellow / card-red if present)
 *   6: substitutions (span.change-up "entered" / span.change-down "left")
 */
function parseGamesFragment(fragmentHtml) {
  const $$ = cheerio.load('<div id="root">' + fragmentHtml + '</div>');
  const rows = $$('#root > a.table_row');

  const games = [];
  const goals = { league: 0, cup: 0, toto: 0, total: 0 };
  const cards = { yellowLeague: 0, yellowToto: 0, red: 0, total: 0 };

  rows.each((_, row) => {
    const $row = $$(row);
    const cols = $row.find('> div.table_col');
    if (!cols.length) return;

    const date = stripSrOnlyLabel($$, cols.eq(0));
    const framework = stripSrOnlyLabel($$, cols.eq(1));
    const matchDiv = cols.eq(2);
    const teams = matchDiv
      .find('.team-name-text')
      .map((__, el) => cleanText($$(el).text()))
      .get()
      .join(' ');
    const match = teams || stripSrOnlyLabel($$, matchDiv);
    const result = stripSrOnlyLabel($$, cols.eq(3));
    const goalsText = stripSrOnlyLabel($$, cols.eq(4));
    const goalsScored = goalsText ? parseInt(goalsText, 10) || 0 : 0;

    const cardsDiv = cols.eq(5);
    const cardsDivText = cardsDiv.text();
    const isYellow = /card-yellow/.test(cardsDiv.html() || '') || /צהוב/.test(cardsDivText);
    const isRed = /card-red/.test(cardsDiv.html() || '') || /אדום/.test(cardsDivText);

    const subsDiv = cols.eq(6);
    const changeUpEl = subsDiv.find('.change-up');
    const changeDownEl = subsDiv.find('.change-down');
    const subInMinuteRaw = changeUpEl.length ? stripSrOnlyLabel($$, changeUpEl) : '';
    const subOutMinuteRaw = changeDownEl.length ? stripSrOnlyLabel($$, changeDownEl) : '';
    const subInMinute = subInMinuteRaw ? parseInt(subInMinuteRaw, 10) : null;
    const subOutMinute = subOutMinuteRaw ? parseInt(subOutMinuteRaw, 10) : null;

    const category = categorizeFramework(framework);

    goals.total += goalsScored;
    if (category === 'cup') goals.cup += goalsScored;
    else if (category === 'toto') goals.toto += goalsScored;
    else goals.league += goalsScored;

    if (isYellow) {
      cards.total += 1;
      if (category === 'toto') cards.yellowToto += 1;
      else cards.yellowLeague += 1;
    }
    if (isRed) {
      cards.total += 1;
      cards.red += 1;
    }

    games.push({
      date,
      framework,
      match,
      result,
      goals: goalsScored,
      cards: isYellow ? 'צהוב' : isRed ? 'אדום' : '',
      subInMinute: Number.isFinite(subInMinute) ? subInMinute : null,
      subOutMinute: Number.isFinite(subOutMinute) ? subOutMinute : null,
    });
  });

  return { games, goals, cards };
}

const STANDARD_GAME_LENGTH = 90;

function minutesPlayedForGame(game) {
  const { subInMinute, subOutMinute } = game;
  if (subInMinute !== null && subOutMinute !== null) {
    return Math.max(0, subOutMinute - subInMinute);
  }
  if (subInMinute !== null) {
    return Math.max(0, STANDARD_GAME_LENGTH - Math.min(subInMinute, STANDARD_GAME_LENGTH));
  }
  if (subOutMinute !== null) {
    return Math.min(subOutMinute, STANDARD_GAME_LENGTH);
  }
  return STANDARD_GAME_LENGTH; // no sub info recorded = played the full match
}

function parseGameDate(dateStr) {
  const m = String(dateStr || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d));
}

/**
 * Minutes-played summary: average per game, total minutes this season, the
 * most recent game's minutes, and how many games were played start-to-finish.
 */
function computeGameMinutesStats(games) {
  if (!games || !games.length) {
    return {
      average_minutes_per_game: null,
      total_season_minutes: 0,
      last_game_minutes: null,
      last_game_details: null,
      total_games: 0,
      full_games: 0,
    };
  }

  let totalMinutes = 0;
  let fullGames = 0;
  let lastGame = null;
  let lastGameDate = null;

  games.forEach((game) => {
    const minutes = minutesPlayedForGame(game);
    totalMinutes += minutes;
    if (game.subInMinute === null && game.subOutMinute === null) fullGames += 1;

    const gameDate = parseGameDate(game.date);
    if (!lastGameDate || (gameDate && gameDate >= lastGameDate)) {
      lastGameDate = gameDate;
      lastGame = { ...game, minutes };
    }
  });

  return {
    average_minutes_per_game: Math.round((totalMinutes / games.length) * 10) / 10,
    total_season_minutes: totalMinutes,
    last_game_minutes: lastGame ? lastGame.minutes : null,
    last_game_details: lastGame ? `${lastGame.date} - ${lastGame.match}` : null,
    total_games: games.length,
    full_games: fullGames,
  };
}

async function fetchPlayerGamesFragment(playerId, seasonId) {
  const url = new URL(GAMES_ENDPOINT);
  url.searchParams.set('player_id', playerId);
  if (seasonId) url.searchParams.set('season_id', seasonId);

  const res = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; YonatanMaimonStats/1.0)',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`GetPlayerGames נכשל (סטטוס ${res.status})`);
  const json = await res.json();
  return json && json.d ? json.d : '';
}

async function scrapePlayer(playerId, seasonId) {
  const key = cacheKey(playerId, seasonId);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data;
  }

  const url = new URL(BASE_URL);
  url.searchParams.set('player_id', playerId);
  if (seasonId) url.searchParams.set('season_id', seasonId);

  const res = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; YonatanMaimonStats/1.0)',
      'Accept-Language': 'he-IL,he;q=0.9',
    },
  });

  if (!res.ok) {
    throw new Error(`שגיאה בשליפת נתוני השחקן מההתאחדות (סטטוס ${res.status})`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  const name = cleanText($('h1').first().text()) || null;
  const photo = $('img[src*="GetImage.ashx"]').first().attr('src') || null;

  let birthDate = null;
  let citizenship = null;
  $('li').each((_, el) => {
    const text = cleanText($(el).text());
    if (!birthDate && /תאריך לידה/.test(text)) {
      birthDate = text.replace(/.*תאריך לידה:?/, '').trim();
    }
    if (!citizenship && /אזרחות/.test(text)) {
      citizenship = text.replace(/.*אזרחות:?/, '').trim();
    }
  });

  let team = null;
  let league = null;
  $('h2,h3').each((_, el) => {
    if (team) return;
    const text = cleanText($(el).text());
    const m = text.match(/נתוני השחקן בקבוצה:\s*(.+?)\s*\((.+?)\)\s*$/);
    if (m) {
      team = m[1].trim();
      league = m[2].trim();
    }
  });

  const roster = [];
  const rosterHeading = findHeadingEl($, 'שחקני הקבוצה');
  if (rosterHeading) {
    let node = rosterHeading;
    const $container = $(node).nextAll('ul').first().length
      ? $(node).nextAll('ul').first()
      : $(node).parent().find('a[href*="player_id="]').parent();
    const $links = $container.find('a[href*="player_id="]').length
      ? $container.find('a[href*="player_id="]')
      : $('a[href*="player_id="]');
    $links.each((_, a) => {
      const href = $(a).attr('href') || '';
      const idMatch = href.match(/player_id=(\d+)/);
      const linkName = cleanText($(a).text());
      if (idMatch && linkName) {
        roster.push({ name: linkName, playerId: idMatch[1] });
      }
    });
  }

  const seasons = extractSeasons($);
  const resolvedSeasonId =
    seasonId || (seasons.find((s) => s.selected) || {}).value || (seasons[0] || {}).value || null;

  // Goals/cards/games all come from the real AJAX endpoint the site itself
  // uses (found via the browser's Network tab) — the static page HTML never
  // contains this data.
  let games = [];
  let goals = { league: null, cup: null, toto: null, total: null };
  let cards = { yellowLeague: null, yellowToto: null, red: null, total: null };
  let gameMinutes = null;
  let gamesEndpointError = null;

  try {
    const fragment = await fetchPlayerGamesFragment(playerId, resolvedSeasonId);
    const parsed = parseGamesFragment(fragment);
    games = parsed.games;
    goals = parsed.goals;
    cards = parsed.cards;
    gameMinutes = computeGameMinutesStats(games);
  } catch (err) {
    gamesEndpointError = err.message;
  }

  const data = {
    playerId,
    seasonId: resolvedSeasonId,
    name,
    photo,
    birthDate,
    citizenship,
    team,
    league,
    goals,
    cards,
    games,
    gameMinutes,
    roster: roster.filter((r, i, arr) => arr.findIndex((x) => x.playerId === r.playerId) === i),
    seasons,
    fetchedAt: new Date().toISOString(),
    _debug: {
      foundRosterHeading: !!rosterHeading,
      resolvedSeasonId,
      gamesEndpointError,
      gamesFound: games.length,
    },
  };

  cache.set(key, { at: Date.now(), data });
  return data;
}

module.exports = { scrapePlayer };
