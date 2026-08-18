// netlify/functions/client-docs.js
// FR-Logistics — client-facing collateral stored in the public `client-docs`
// bucket (decks and guides linked from the onboarding welcome email instead of
// being attached, so onboarding.html stays small and a deck can be updated
// without redeploying the app).
//
//   GET  ?action=list                 -> { files:[{slug,path,url,size,updated_at,present}] }
//   POST { slug, base64, filename }   -> { ok, slug, url, size }
//
// Only the fixed slugs below can be written. That keeps the public URLs stable
// (the onboarding email hardcodes them) and stops the bucket from turning into
// a dumping ground. Uploading the same slug again overwrites it — that IS the
// update path for a new deck revision.
//
// Uses SUPABASE_URL + SUPABASE_SERVICE_KEY only. No new environment variables.

const ALLOWED_ORIGINS = [
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
  'https://apps.fr-logistics.net',
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const BUCKET = 'client-docs';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// slug -> { path, mime, label }  — the contract shared with onboarding.html
const CATALOG = {
  dropship_es: { path: 'collateral/dropshipments-service-es.pptx', mime: PPTX,
                 label: 'DropShipments Service (ES)' },
  dropship_en: { path: 'collateral/dropshipments-service-en.pptx', mime: PPTX,
                 label: 'DropShipments Service (EN)' },
  ecopack_es:  { path: 'collateral/ecopack-plus-es.pptx', mime: PPTX,
                 label: 'EcoPack+ (ES)' },
  ecopack_en:  { path: 'collateral/ecopack-plus-en.pptx', mime: PPTX,
                 label: 'EcoPack+ (EN)' },
  fba_es:      { path: 'collateral/fba-inbound-guide-es.pdf', mime: 'application/pdf',
                 label: 'Guia de envios FBA (ES)' },
  fba_en:      { path: 'collateral/fba-inbound-guide-en.pdf', mime: 'application/pdf',
                 label: 'FBA inbound guide (EN)' },
};

const MAX_BYTES = 20 * 1024 * 1024;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function publicUrl(path) {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  // ── LIST ──────────────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    try {
      const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prefix: 'collateral', limit: 100, sortBy: { column: 'name', order: 'asc' } }),
      });
      const objects = res.ok ? await res.json() : [];
      const byName = {};
      (Array.isArray(objects) ? objects : []).forEach((o) => { byName[o.name] = o; });

      const files = Object.entries(CATALOG).map(([slug, def]) => {
        const name = def.path.replace(/^collateral\//, '');
        const o = byName[name];
        return {
          slug,
          label: def.label,
          path: def.path,
          url: publicUrl(def.path),
          present: !!o,
          size: o && o.metadata ? o.metadata.size : null,
          updated_at: o ? o.updated_at : null,
        };
      });
      return { statusCode: 200, headers, body: JSON.stringify({ files }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'List failed', detail: String(err) }) };
    }
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── UPLOAD ────────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const slug = String(body.slug || '').trim();
  const def = CATALOG[slug];
  if (!def) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Unknown slug', allowed: Object.keys(CATALOG) }),
    };
  }
  if (!body.base64) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing base64' }) };
  }

  let bytes;
  try { bytes = Buffer.from(String(body.base64), 'base64'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad base64' }) }; }

  if (!bytes.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Empty file' }) };
  }
  if (bytes.length > MAX_BYTES) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: 'File too large', max: MAX_BYTES }) };
  }

  // Both PPTX and PDF have unmistakable magic bytes. A mismatch here almost
  // always means the wrong file got picked, and a broken deck published under
  // a stable URL is worse than a failed upload.
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;          // PK.. (pptx/docx)
  const isPdf = bytes.slice(0, 5).toString('latin1') === '%PDF-';
  const wantsZip = def.mime === PPTX;
  if ((wantsZip && !isZip) || (!wantsZip && !isPdf)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: 'FILE_TYPE_MISMATCH',
        detail: `Slug ${slug} expects ${wantsZip ? 'a .pptx' : 'a .pdf'} file`,
      }),
    };
  }

  try {
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${def.path}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': def.mime,
        'x-upsert': 'true',
        'Cache-Control': '3600',
      },
      body: bytes,
    });
    if (!up.ok) {
      const detail = await up.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Upload failed', status: up.status, detail }) };
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, slug, path: def.path, url: publicUrl(def.path), size: bytes.length }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error', detail: String(err) }) };
  }
};
