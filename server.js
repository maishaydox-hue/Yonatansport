require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const { supabase } = require('./lib/supabase');
const { parseMaimonRowFromCsv, toNumberOrNull } = require('./lib/csvParse');
const { buildSummary } = require('./lib/aggregate');
const { scrapePlayer } = require('./lib/scrape');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // images as base64 can be sizeable
app.use(express.static(path.join(__dirname, 'public')));

const DEFAULT_PLAYER_ID = process.env.PLAYER_ID || '218770';
const IMAGE_BUCKET = 'weekly-images';

function sendError(res, status, message, extra) {
  res.status(status).json({ error: message, ...(extra || {}) });
}

// ---------- Federation player data (main screen) ----------

app.get('/api/player-info', async (req, res) => {
  try {
    const playerId = req.query.player_id || DEFAULT_PLAYER_ID;
    const seasonId = req.query.season_id || null;
    const data = await scrapePlayer(playerId, seasonId);
    res.json(data);
  } catch (err) {
    console.error('scrape error:', err);
    sendError(res, 502, err.message || 'שגיאה בשליפת נתונים מההתאחדות');
  }
});

// ---------- Weekly stats: list + summary ----------

async function fetchAllEntries() {
  const { data, error } = await supabase
    .from('weekly_entries')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

app.get('/api/weekly-stats', async (req, res) => {
  try {
    const entries = await fetchAllEntries();
    res.json({ summary: buildSummary(entries) });
  } catch (err) {
    console.error('fetch summary error:', err);
    sendError(res, 500, 'שגיאה בטעינת הנתונים: ' + err.message);
  }
});

app.get('/api/entries', async (req, res) => {
  try {
    const entries = await fetchAllEntries();
    res.json({ entries });
  } catch (err) {
    console.error('fetch entries error:', err);
    sendError(res, 500, 'שגיאה בטעינת רשימת ההעלאות: ' + err.message);
  }
});

app.delete('/api/weekly-stats', async (req, res) => {
  try {
    // Delete all rows. Also best-effort clear the storage bucket.
    const { data: entries } = await supabase.from('weekly_entries').select('id,image_path');
    const { error } = await supabase.from('weekly_entries').delete().not('id', 'is', null);
    if (error) throw new Error(error.message);

    const paths = (entries || []).map((e) => e.image_path).filter(Boolean);
    if (paths.length) {
      await supabase.storage.from(IMAGE_BUCKET).remove(paths);
    }

    res.json({ summary: buildSummary([]) });
  } catch (err) {
    console.error('clear all error:', err);
    sendError(res, 500, 'שגיאה בניקוי הנתונים: ' + err.message);
  }
});

app.delete('/api/weekly-stats/latest', async (req, res) => {
  try {
    const { data: latest, error: fetchErr } = await supabase
      .from('weekly_entries')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);
    if (!latest) {
      const entries = await fetchAllEntries();
      return res.json({ summary: buildSummary(entries) });
    }

    const { error: delErr } = await supabase.from('weekly_entries').delete().eq('id', latest.id);
    if (delErr) throw new Error(delErr.message);

    if (latest.image_path) {
      await supabase.storage.from(IMAGE_BUCKET).remove([latest.image_path]);
    }

    const entries = await fetchAllEntries();
    res.json({ summary: buildSummary(entries) });
  } catch (err) {
    console.error('delete latest error:', err);
    sendError(res, 500, 'שגיאה במחיקת ההעלאה האחרונה: ' + err.message);
  }
});

// ---------- Individual entry control: edit / delete by id ----------

app.put('/api/entries/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const values = req.body && req.body.values ? req.body.values : req.body;
    const update = {
      top_speed: toNumberOrNull(values.topSpeed),
      sprints: toNumberOrNull(values.sprints),
      hid: toNumberOrNull(values.hid),
      very_fast_run: toNumberOrNull(values.veryFastRun),
      fast_run: toNumberOrNull(values.fastRun),
      distance_per_min: toNumberOrNull(values.distancePerMin),
      total_distance: toNumberOrNull(values.totalDistance),
      time_value: values.time ? String(values.time).trim() : null,
    };

    if (update.total_distance === null) {
      return sendError(res, 400, 'Total Distance הוא שדה חובה.');
    }

    const { error } = await supabase.from('weekly_entries').update(update).eq('id', id);
    if (error) throw new Error(error.message);

    const entries = await fetchAllEntries();
    res.json({ summary: buildSummary(entries), entries });
  } catch (err) {
    console.error('edit entry error:', err);
    sendError(res, 500, 'שגיאה בעדכון ההעלאה: ' + err.message);
  }
});

app.delete('/api/entries/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: entry, error: fetchErr } = await supabase
      .from('weekly_entries')
      .select('image_path')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);

    const { error } = await supabase.from('weekly_entries').delete().eq('id', id);
    if (error) throw new Error(error.message);

    if (entry && entry.image_path) {
      await supabase.storage.from(IMAGE_BUCKET).remove([entry.image_path]);
    }

    const entries = await fetchAllEntries();
    res.json({ summary: buildSummary(entries), entries });
  } catch (err) {
    console.error('delete entry error:', err);
    sendError(res, 500, 'שגיאה במחיקת ההעלאה: ' + err.message);
  }
});

// ---------- Upload: csv / image / manual ----------

app.post('/api/weekly-stats/upload', async (req, res) => {
  try {
    const { type } = req.body || {};

    if (type === 'csv') {
      const { fileName, text } = req.body;
      const result = parseMaimonRowFromCsv(text);
      if (!result.ok) {
        return sendError(res, 400, result.error, {
          rowsChecked: result.rowsChecked,
          headers: result.headers,
        });
      }

      const { stats } = result;
      const { error } = await supabase.from('weekly_entries').insert({
        type: 'csv',
        file_name: fileName || null,
        top_speed: stats.topSpeed,
        sprints: stats.sprints,
        hid: stats.hid,
        very_fast_run: stats.veryFastRun,
        fast_run: stats.fastRun,
        distance_per_min: stats.distancePerMin,
        total_distance: stats.totalDistance,
        time_value: stats.time || null,
        raw_source: text,
      });
      if (error) throw new Error(error.message);

      const entries = await fetchAllEntries();
      return res.json({ summary: buildSummary(entries) });
    }

    if (type === 'image') {
      const { fileName, dataUrl } = req.body;
      if (!dataUrl || !dataUrl.startsWith('data:')) {
        return sendError(res, 400, 'תמונה לא תקינה התקבלה.');
      }

      const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
      if (!match) {
        return sendError(res, 400, 'לא ניתן היה לפענח את קובץ התמונה.');
      }
      const [, mime, base64] = match;
      const buffer = Buffer.from(base64, 'base64');
      const ext = (mime.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '');
      const storagePath = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;

      const { error: uploadErr } = await supabase.storage
        .from(IMAGE_BUCKET)
        .upload(storagePath, buffer, { contentType: mime, upsert: false });
      if (uploadErr) throw new Error(uploadErr.message);

      const { data: publicUrlData } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(storagePath);

      const { data: inserted, error: insertErr } = await supabase
        .from('weekly_entries')
        .insert({
          type: 'image',
          file_name: fileName || null,
          image_path: storagePath,
          image_url: publicUrlData ? publicUrlData.publicUrl : null,
        })
        .select()
        .single();
      if (insertErr) throw new Error(insertErr.message);

      const entries = await fetchAllEntries();
      const summary = buildSummary(entries);
      summary.latestImage = { id: inserted.id, url: inserted.image_url, fileName: inserted.file_name };
      return res.json({ summary });
    }

    if (type === 'manual') {
      const { values, relatedImageId } = req.body;
      if (!values || !String(values.totalDistance || '').trim()) {
        return sendError(res, 400, 'חסר Total Distance.');
      }

      const { error } = await supabase.from('weekly_entries').insert({
        type: 'manual',
        top_speed: toNumberOrNull(values.topSpeed),
        sprints: toNumberOrNull(values.sprints),
        hid: toNumberOrNull(values.hid),
        very_fast_run: toNumberOrNull(values.veryFastRun),
        fast_run: toNumberOrNull(values.fastRun),
        distance_per_min: toNumberOrNull(values.distancePerMin),
        total_distance: toNumberOrNull(values.totalDistance),
        time_value: values.time ? String(values.time).trim() : null,
        related_image_id: relatedImageId || null,
      });
      if (error) throw new Error(error.message);

      const entries = await fetchAllEntries();
      return res.json({ summary: buildSummary(entries) });
    }

    return sendError(res, 400, 'סוג העלאה לא מוכר.');
  } catch (err) {
    console.error('upload error:', err);
    sendError(res, 500, 'שגיאה בהעלאת הנתונים: ' + err.message);
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
