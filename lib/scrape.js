const cheerio = require('cheerio');

const BASE_URL = 'https://www.football.org.il/players/player/';

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

function tableAfterHeading($, headingEl) {
  if (!headingEl) return null;
  // Look for the nearest following <table> in document order after this heading.
  let node = headingEl;
  for (let i = 0; i < 40 && node; i++) {
    node = $(node).next().length ? $(node).next()[0] : (node.parent ? $(node).parent().next()[0] : null);
    if (!node) break;
    const $node = $(node);
    if ($node.is('table')) return $node;
    const nested = $node.find('table').first();
    if (nested.length) return nested;
  }
  return null;
}

function parseSimpleTable($, $table) {
  if (!$table || !$table.length) return [];
  const rows = [];
  $table.find('tbody tr').each((_, tr) => {
    const cells = [];
    $(tr)
      .find('td,th')
      .each((__, td) => cells.push(cleanText($(td).text())));
    if (cells.length) rows.push(cells);
  });
  if (!rows.length) {
    // Fallback: no explicit tbody, just grab all rows.
    $table.find('tr').each((_, tr) => {
      const cells = [];
      $(tr)
        .find('td,th')
        .each((__, td) => cells.push(cleanText($(td).text())));
      if (cells.length) rows.push(cells);
    });
  }
  return rows;
}

function rowsToFrameworkMap(rows) {
  const map = {};
  rows.forEach((cells) => {
    if (cells.length >= 2) {
      const [label, value] = cells;
      map[label] = value;
    }
  });
  return map;
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

  const goalsHeading = findHeadingEl($, 'שערים');
  const goalsTable = tableAfterHeading($, goalsHeading);
  const goalsRows = parseSimpleTable($, goalsTable);
  const goalsMap = rowsToFrameworkMap(goalsRows);

  const cardsHeading = findHeadingEl($, 'כרטיסים');
  const cardsTable = tableAfterHeading($, cardsHeading);
  const cardsRows = parseSimpleTable($, cardsTable);
  const cardsMap = rowsToFrameworkMap(cardsRows);

  const gamesHeading = findHeadingEl($, 'משחקים בעונה');
  const gamesTable = tableAfterHeading($, gamesHeading);
  const gamesRows = parseSimpleTable($, gamesTable);

  const roster = [];
  const rosterHeading = findHeadingEl($, 'שחקני הקבוצה');
  if (rosterHeading) {
    let node = rosterHeading;
    // Roster links usually sit in a <ul> shortly after the heading.
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

  const data = {
    playerId,
    seasonId: seasonId || null,
    name,
    photo,
    birthDate,
    citizenship,
    team,
    league,
    goals: {
      league: goalsMap['ליגה'] || null,
      cup: goalsMap['גביע המדינה'] || null,
      toto: goalsMap['גביע הטוטו/גביע הליגה'] || goalsMap['גביע הטוטו'] || null,
      total: goalsMap['הכל'] || null,
    },
    cards: {
      yellowLeague: cardsMap['צהוב - ליגה/גביע המדינה'] || null,
      yellowToto: cardsMap['צהוב - גביע הטוטו/גביע הליגה'] || null,
      red: cardsMap['אדום'] || null,
      total: cardsMap['הכל'] || null,
    },
    games: gamesRows,
    roster: roster.filter((r, i, arr) => arr.findIndex((x) => x.playerId === r.playerId) === i),
    fetchedAt: new Date().toISOString(),
    // Debug aid: if any of the above came back null/empty after a real deploy,
    // this shows what the scraper actually found so selectors can be adjusted.
    _debug: {
      foundGoalsTable: !!goalsTable,
      foundCardsTable: !!cardsTable,
      foundGamesTable: !!gamesTable,
      foundRosterHeading: !!rosterHeading,
      goalsRowsSample: goalsRows.slice(0, 5),
      cardsRowsSample: cardsRows.slice(0, 5),
    },
  };

  cache.set(key, { at: Date.now(), data });
  return data;
}

module.exports = { scrapePlayer };
