const Papa = require('papaparse');

// Keyword patterns used to fuzzy-match column headers, since real-world CSV
// exports from stat providers rarely use exactly the same header text twice.
const FIELD_PATTERNS = {
  playerName: /player|name|שם|שחקן/i,
  topSpeed: /top\s*speed|max\s*speed|מהירות/i,
  sprints: /sprint.*25|n[°o]\s*sprint|ספרינט/i,
  hid: /hid|19\.?8/i,
  veryFastRun: /distance.*>\s*25|very\s*fast/i,
  fastRun: /distance.*20.*25|fast\s*run/i,
  distancePerMin: /distance\s*\/\s*min|dist.*min/i,
  totalDistance: /total\s*distance|מרחק\s*כולל/i,
  time: /^time$|זמן/i,
};

function normalizeHeader(h) {
  return String(h || '').trim();
}

function toNumberOrNull(value) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).trim().replace(',', '.');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parses raw CSV text, finds the row belonging to Maimon (Player column
 * containing "Maimon" or "מימון"), and returns a normalized stats object.
 *
 * Never throws. Always returns { ok, stats?, error?, rowsChecked, headers }
 * so the API layer can give the front end a real, specific message instead
 * of a bare null/undefined blowing up somewhere downstream.
 */
function parseMaimonRowFromCsv(csvText) {
  if (!csvText || typeof csvText !== 'string' || !csvText.trim()) {
    return { ok: false, error: 'קובץ ה-CSV ריק או שלא התקבל תוכן.', rowsChecked: 0, headers: [] };
  }

  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });

  if (parsed.errors && parsed.errors.length) {
    // PapaParse reports things like inconsistent column counts; not always fatal,
    // so we only bail out if there is no usable data at all.
    if (!parsed.data || !parsed.data.length) {
      return {
        ok: false,
        error: 'לא הצלחתי לפענח את קובץ ה-CSV (מבנה לא תקין).',
        rowsChecked: 0,
        headers: parsed.meta ? parsed.meta.fields || [] : [],
      };
    }
  }

  const headers = (parsed.meta && parsed.meta.fields) || [];
  if (!headers.length) {
    return { ok: false, error: 'לא נמצאו כותרות עמודות בקובץ ה-CSV.', rowsChecked: 0, headers: [] };
  }

  // Build a map from logical field -> actual header name found in this file.
  const headerMap = {};
  for (const [field, pattern] of Object.entries(FIELD_PATTERNS)) {
    const match = headers.find((h) => pattern.test(normalizeHeader(h)));
    if (match) headerMap[field] = match;
  }

  if (!headerMap.playerName) {
    return {
      ok: false,
      error: 'לא נמצאה עמודת שחקן (Player) בקובץ. ודאי שיש עמודה עם שם השחקן.',
      rowsChecked: parsed.data.length,
      headers,
    };
  }

  const rows = parsed.data;
  const maimonRow = rows.find((row) => {
    const value = row[headerMap.playerName];
    return typeof value === 'string' && /maimon|מימון/i.test(value);
  });

  if (!maimonRow) {
    return {
      ok: false,
      error: 'לא נמצאה שורה של מימון בקובץ. בדקי שהשם באנגלית (Maimon) או בעברית (מימון) מופיע בעמודת השחקן.',
      rowsChecked: rows.length,
      headers,
    };
  }

  const stats = {
    topSpeed: headerMap.topSpeed ? toNumberOrNull(maimonRow[headerMap.topSpeed]) : null,
    sprints: headerMap.sprints ? toNumberOrNull(maimonRow[headerMap.sprints]) : null,
    hid: headerMap.hid ? toNumberOrNull(maimonRow[headerMap.hid]) : null,
    veryFastRun: headerMap.veryFastRun ? toNumberOrNull(maimonRow[headerMap.veryFastRun]) : null,
    fastRun: headerMap.fastRun ? toNumberOrNull(maimonRow[headerMap.fastRun]) : null,
    distancePerMin: headerMap.distancePerMin ? toNumberOrNull(maimonRow[headerMap.distancePerMin]) : null,
    totalDistance: headerMap.totalDistance ? toNumberOrNull(maimonRow[headerMap.totalDistance]) : null,
    time: headerMap.time ? String(maimonRow[headerMap.time] || '').trim() : '',
  };

  if (stats.totalDistance === null) {
    return {
      ok: false,
      error: 'נמצאה שורת מימון, אבל לא זוהתה בה עמודת Total Distance עם ערך מספרי תקין.',
      rowsChecked: rows.length,
      headers,
      partialStats: stats,
    };
  }

  return { ok: true, stats, rowsChecked: rows.length, headers, matchedHeaders: headerMap };
}

module.exports = { parseMaimonRowFromCsv, toNumberOrNull };
