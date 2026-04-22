// netlify/functions/docs-list.js
// PURPOSE: Return the docs library for the Docs Library app.
//
// GET query params (all optional):
//   app         — filter by related_app (e.g. 'Dropshipments')
//   audience    — filter by audience (e.g. 'operator')
//   search      — full-text search on title + description + tags
//   include_unpublished — 'true' to show drafts (default false)
//
// Response:
// {
//   total,
//   grouped_by_app: {
//     Dropshipments: [{...doc}, ...],
//     Billing:       [{...doc}, ...],
//     Portal:        [...],
//     Dashboard:     [...],
//     Other:         [...]
//   },
//   all: [...]   // flat list, same data
// }

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

const APP_ORDER = ['Dropshipments', 'Billing', 'Portal', 'Dashboard', 'Other'];

function sbHeaders() {
  return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
}

async function sbSelect(table, query = '') {
  const r = await fetch(`${SB_URL}/rest/v1/${table}${query}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`sbSelect ${table}: ${await r.text()}`);
  return r.json();
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const p = event.queryStringParameters || {};
  const filters = [];

  if (!p.include_unpublished || p.include_unpublished !== 'true') {
    filters.push('published=eq.true');
  }
  if (p.app) {
    filters.push(`related_app=eq.${encodeURIComponent(p.app)}`);
  }
  if (p.audience) {
    filters.push(`audience=eq.${encodeURIComponent(p.audience)}`);
  }

  // Basic text search across title, description, tags (OR combination)
  if (p.search) {
    const q = p.search.toLowerCase().trim();
    // PostgREST: or= syntax with ilike
    const orClause = [
      `title.ilike.*${q}*`,
      `description.ilike.*${q}*`
    ].join(',');
    filters.push(`or=(${orClause})`);
  }

  const query = filters.length
    ? `?${filters.join('&')}&select=*&order=related_app.asc,updated_at.desc&limit=200`
    : '?select=*&order=related_app.asc,updated_at.desc&limit=200';

  try {
    const rows = await sbSelect('docs', query);

    // Group by related_app with a stable app order
    const grouped = {};
    for (const app of APP_ORDER) grouped[app] = [];

    for (const r of rows) {
      const app = APP_ORDER.includes(r.related_app) ? r.related_app : 'Other';
      grouped[app].push(r);
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        total: rows.length,
        grouped_by_app: grouped,
        all: rows,
        updated_at: new Date().toISOString()
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
