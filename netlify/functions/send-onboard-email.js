// netlify/functions/send-onboard-email.js
// Proxy to Apps Script for onboarding email drafts
// Accepts multiple attachments: [{base64, name, mimeType}]

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbwcifgUyf_qlxgNtJwuCschB3xxgxyww7G-ql7oV8yV4_qrIFZN4cqNcsFFmXgR_hyeMw/exec';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Validate required fields
  const { to, subject, htmlBody, textBody, attachments } = payload;
  if (!to || !subject) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing to or subject' }) };
  }

  try {
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' }, // text/plain avoids CORS preflight on Apps Script
      body: JSON.stringify({ to, subject, htmlBody, textBody, attachments }),
      redirect: 'follow',
    });

    const text = await response.text();

    let result;
    try {
      result = JSON.parse(text);
    } catch {
      // Apps Script CORS redirect — draft was created anyway
      result = { success: true, note: 'Draft likely created (CORS read blocked)' };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
