function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function avg(values) {
  const clean = values.filter((v) => v !== null && v !== undefined);
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

function sum(values) {
  const clean = values.filter((v) => v !== null && v !== undefined);
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0);
}

function round(v, digits = 1) {
  if (v === null || v === undefined) return null;
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

/**
 * Builds the aggregated "summary" object the front end renders:
 * metric cards, quality/analysis cards, recommendations, counts, latest image.
 */
function buildSummary(entries) {
  const csvCount = entries.filter((e) => e.type === 'csv').length;
  const imageCount = entries.filter((e) => e.type === 'image').length;

  const statEntries = entries.filter((e) => e.type === 'csv' || e.type === 'manual');

  const latestImageEntry = entries
    .filter((e) => e.type === 'image')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

  const metrics = [];
  const analysis = [];
  const recommendations = [];

  if (statEntries.length) {
    const totalDistanceAvg = avg(statEntries.map((e) => num(e.total_distance)));
    const totalDistanceSum = sum(statEntries.map((e) => num(e.total_distance)));
    const topSpeedBest = statEntries.reduce((best, e) => {
      const v = num(e.top_speed);
      return v !== null && (best === null || v > best) ? v : best;
    }, null);
    const sprintsAvg = avg(statEntries.map((e) => num(e.sprints)));
    const hidAvg = avg(statEntries.map((e) => num(e.hid)));
    const distancePerMinAvg = avg(statEntries.map((e) => num(e.distance_per_min)));

    metrics.push({
      label: 'Total Distance (ממוצע)',
      value: totalDistanceAvg !== null ? round(totalDistanceAvg, 0) : '—',
      description: `מבוסס על ${statEntries.length} העלאות · סה"כ מצטבר: ${totalDistanceSum !== null ? round(totalDistanceSum, 0) : '—'}`,
    });
    metrics.push({
      label: 'Top Speed (שיא)',
      value: topSpeedBest !== null ? round(topSpeedBest, 1) : '—',
      description: 'המהירות הגבוהה ביותר שנרשמה בכל ההעלאות',
    });
    metrics.push({
      label: 'Sprints (ממוצע)',
      value: sprintsAvg !== null ? round(sprintsAvg, 1) : '—',
      description: 'מספר ספרינטים ממוצע מעל 25 קמ"ש',
    });
    metrics.push({
      label: 'HID (ממוצע)',
      value: hidAvg !== null ? round(hidAvg, 0) : '—',
      description: 'מרחק ריצה בעצימות גבוהה, ממוצע להעלאה',
    });

    analysis.push({
      title: 'עומס ריצה כולל',
      value: totalDistanceAvg !== null ? `${round(totalDistanceAvg, 0)} מ׳` : '—',
      status: totalDistanceAvg && totalDistanceAvg > 9000 ? 'תקין' : 'לבדיקה',
      lines: [
        'ממוצע המרחק הכולל שנרשם על פני כל ההעלאות שנוספו.',
        totalDistanceAvg && totalDistanceAvg < 9000
          ? 'הממוצע נמוך יחסית למשחק מלא — כדאי לבדוק אם חלק מהמשחקים היו חלקיים.'
          : 'הממוצע תואם עומס משחק מלא סביר.',
      ],
    });

    analysis.push({
      title: 'עצימות ריצה (Distance/min)',
      value: distancePerMinAvg !== null ? `${round(distancePerMinAvg, 1)}` : '—',
      status: distancePerMinAvg && distancePerMinAvg >= 90 ? 'תקין' : 'לבדיקה',
      lines: ['מרחק ממוצע לדקת משחק, מדד טוב לעצימות הכללית של השחקן.'],
    });

    if (sprintsAvg !== null && sprintsAvg < 2) {
      recommendations.push('מספר הספרינטים הממוצע נמוך יחסית — כדאי לבדוק עומס אימונים ומוטיבציה לפני משחקים.');
    }
    if (totalDistanceAvg !== null && totalDistanceAvg < 8000) {
      recommendations.push('המרחק הכולל הממוצע נמוך — ייתכן שחלק מהדקות במשחק לא נספרו, כדאי לוודא שהקבצים המלאים מועלים.');
    }
    if (!recommendations.length) {
      recommendations.push('הנתונים שנאספו נראים בטווח סביר. המשיכי להעלות באופן שבועי כדי לעקוב אחרי מגמות.');
    }
  }

  return {
    csvCount,
    imageCount,
    metrics,
    analysis,
    recommendations,
    latestImage: latestImageEntry
      ? { id: latestImageEntry.id, url: latestImageEntry.image_url, fileName: latestImageEntry.file_name }
      : null,
  };
}

module.exports = { buildSummary };
