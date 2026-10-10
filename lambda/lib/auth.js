'use strict';

const crypto = require('node:crypto');

// Secret key for encrypting credentials inside the OAuth token.
// Can be overridden via env var ACCOUNT_LINKING_SECRET.
const SECRET_SEED = process.env.ACCOUNT_LINKING_SECRET || 'abs-alexa-secure-token-encryption-seed-2026';
const CIPHER_KEY = crypto.createHash('sha256').update(SECRET_SEED).digest();

/**
 * Encrypts user credentials ({ baseUrl, apiKey, userId }) into an opaque, secure token.
 */
function encryptCredentials(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', CIPHER_KEY, iv);
  const plaintext = JSON.stringify({ ...data, ts: Date.now() });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(12) + tag(16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

/**
 * Decrypts an opaque token back into credentials { baseUrl, apiKey, userId }.
 */
function decryptCredentials(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const buf = Buffer.from(token, 'base64url');
    if (buf.length < 28) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', CIPHER_KEY, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (err) {
    console.warn('Failed to decrypt account linking token:', err.message);
    return null;
  }
}

/**
 * Validates connection against a remote Audiobookshelf server.
 */
async function verifyAbsConnection(baseUrl, apiKey) {
  const cleanUrl = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    throw new Error('Die Server-URL muss mit https:// oder http:// beginnen.');
  }

  const res = await fetch(`${cleanUrl}/api/me`, {
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('Ungültiger API-Key oder fehlende Berechtigung.');
    }
    throw new Error(`Server antwortete mit Fehler-Status: ${res.status}`);
  }

  const user = await res.json().catch(() => ({}));
  return {
    username: user.username || 'Audiobookshelf User',
    userId: user.id || 'unknown',
  };
}

/**
 * Generates modern, mobile-friendly HTML login page for Alexa Account Linking.
 */
function renderAuthPage({ redirectUri, state, clientId, responseType, errorMessage = '', values = {} }) {
  const sanitize = (s) => (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Audiobookshelf — Alexa Konto verknüpfen</title>
  <style>
    :root {
      --bg: #141416;
      --card-bg: #1f2024;
      --accent: #d4a359;
      --accent-hover: #b8863b;
      --text: #f0f0f2;
      --text-muted: #9a9aa2;
      --border: #2e3038;
      --error: #ff5252;
      --radius: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body {
      background: var(--bg);
      color: var(--text);
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 16px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      width: 100%;
      max-width: 440px;
      padding: 32px 24px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.4);
    }
    .header {
      text-align: center;
      margin-bottom: 24px;
    }
    .logo {
      width: 80px;
      height: 80px;
      margin: 0 auto 16px;
      display: block;
      border-radius: 50%;
      box-shadow: 0 4px 16px rgba(212, 163, 89, 0.3);
    }
    h1 {
      font-size: 22px;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 8px;
    }
    p.subtitle {
      font-size: 14px;
      color: var(--text-muted);
      line-height: 1.4;
    }
    .error-banner {
      background: rgba(255, 82, 82, 0.15);
      border: 1px solid var(--error);
      color: #ff8a80;
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 13px;
      line-height: 1.4;
    }
    .form-group {
      margin-bottom: 18px;
      text-align: left;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 6px;
      color: var(--text);
    }
    input[type="text"], input[type="password"], input[type="url"] {
      width: 100%;
      padding: 12px 14px;
      background: #121316;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus {
      border-color: var(--accent);
    }
    .hint {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 5px;
      line-height: 1.3;
    }
    button {
      width: 100%;
      padding: 14px;
      background: var(--accent);
      color: #141416;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      margin-top: 8px;
      transition: background 0.2s;
    }
    button:hover, button:active {
      background: var(--accent-hover);
    }
    .footer {
      text-align: center;
      margin-top: 24px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .footer a {
      color: var(--accent);
      text-decoration: none;
    }
    .footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <img src="https://raw.githubusercontent.com/elpatron68/audiobookshelf-alexa/main/skill-package/assets/images/icon_512.png" alt="Audiobookshelf Logo" class="logo">
      <h1>Konto verknüpfen</h1>
      <p class="subtitle">Verbinde deinen persönlichen Audiobookshelf-Server mit Alexa, um deine Hörbücher und Podcasts abzuspielen.</p>
    </div>

    ${errorMessage ? `<div class="error-banner">${sanitize(errorMessage)}</div>` : ''}

    <form method="POST" action="/auth">
      <input type="hidden" name="redirect_uri" value="${sanitize(redirectUri)}">
      <input type="hidden" name="state" value="${sanitize(state)}">
      <input type="hidden" name="client_id" value="${sanitize(clientId)}">
      <input type="hidden" name="response_type" value="${sanitize(responseType)}">

      <div class="form-group">
        <label for="server_url">Audiobookshelf Server-Adresse</label>
        <input type="url" id="server_url" name="server_url" placeholder="https://abs.beispiel.de" required value="${sanitize(values.serverUrl)}">
        <div class="hint">Die vollständige HTTPS-Adresse deines Audiobookshelf-Servers.</div>
      </div>

      <div class="form-group">
        <label for="api_key">API-Schlüssel (API-Key)</label>
        <input type="password" id="api_key" name="api_key" placeholder="eyJhbGciOi..." required value="${sanitize(values.apiKey)}">
        <div class="hint">Erstelle einen API-Key im Audiobookshelf Web-Interface unter: <em>Einstellungen &rarr; Benutzer &rarr; API-Schlüssel</em>.</div>
      </div>

      <button type="submit">Mit Alexa verbinden</button>
    </form>

    <div class="footer">
      <a href="/privacy" target="_blank">Datenschutz</a> &bull; <a href="/terms" target="_blank">Nutzungsbedingungen</a>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Handles incoming HTTP requests to Lambda Function URL.
 */
async function handleHttpRequest(event) {
  const method = (event.requestContext?.http?.method || event.httpMethod || 'GET').toUpperCase();
  const rawPath = event.rawPath || event.path || '/';
  const query = event.queryStringParameters || {};

  // 1. Health check
  if (rawPath === '/health') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ok', service: 'audiobookshelf-alexa-auth' }),
    };
  }

  // 2. Privacy Policy
  if (rawPath === '/privacy') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Datenschutzerklärung</title><style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333;}</style></head><body><h1>Datenschutzerklärung</h1><p>Dieser Alexa-Skill dient der privaten Wiedergabe von Hörbüchern und Podcasts von deinem persönlichen Audiobookshelf-Server.</p><h2>Datenverarbeitung</h2><p>Die von dir eingegebene Server-URL und der API-Key werden verschlüsselt in dem von Amazon bereitgestellten Authentifizierungs-Token gespeichert. Es werden keine Passwörter oder Medien auf unseren Servern zwischengespeichert oder an Dritte weitergegeben.</p></body></html>`,
    };
  }

  // 3. Terms of Service
  if (rawPath === '/terms') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nutzungsbedingungen</title><style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333;}</style></head><body><h1>Nutzungsbedingungen</h1><p>Der Audiobookshelf Alexa Skill wird ohne Gewährleistung bereitgestellt. Die Nutzung erfolgt auf eigenes Risiko zur Verbindung mit deinem selbst gehosteten Audiobookshelf-Server.</p></body></html>`,
    };
  }

  // 4. GET /auth or GET / (Display Account Linking page)
  if (method === 'GET' && (rawPath === '/auth' || rawPath === '/')) {
    const html = renderAuthPage({
      redirectUri: query.redirect_uri || '',
      state: query.state || '',
      clientId: query.client_id || '',
      responseType: query.response_type || 'code',
      values: {},
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: html,
    };
  }

  // 5. POST /auth (Process user submission)
  if (method === 'POST' && (rawPath === '/auth' || rawPath === '/')) {
    let body = event.body || '';
    if (event.isBase64Encoded) {
      body = Buffer.from(body, 'base64').toString('utf8');
    }
    const params = new URLSearchParams(body);
    const serverUrl = (params.get('server_url') || '').trim();
    const apiKey = (params.get('api_key') || '').trim();
    const redirectUri = params.get('redirect_uri') || query.redirect_uri || '';
    const state = params.get('state') || query.state || '';
    const clientId = params.get('client_id') || query.client_id || '';
    const responseType = params.get('response_type') || query.response_type || 'code';

    if (!serverUrl || !apiKey) {
      const html = renderAuthPage({
        redirectUri, state, clientId, responseType,
        errorMessage: 'Bitte gib sowohl die Server-Adresse als auch deinen API-Key ein.',
        values: { serverUrl, apiKey },
      });
      return { statusCode: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html };
    }

    try {
      const userInfo = await verifyAbsConnection(serverUrl, apiKey);
      const token = encryptCredentials({
        baseUrl: serverUrl.replace(/\/+$/, ''),
        apiKey,
        username: userInfo.username,
        userId: userInfo.userId,
      });

      if (!redirectUri) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: `<div style="font-family:sans-serif;padding:40px;text-align:center;"><h2>Verbindung erfolgreich!</h2><p>Du kannst dieses Fenster jetzt schließen und zu Alexa zurückkehren.</p></div>`,
        };
      }

      // Check whether redirect expects Auth Code (query param) or Token (hash)
      if (responseType === 'token') {
        const dest = `${redirectUri}#access_token=${encodeURIComponent(token)}&token_type=Bearer&state=${encodeURIComponent(state)}`;
        return {
          statusCode: 302,
          headers: { Location: dest },
          body: '',
        };
      } else {
        // Standard Auth Code Grant: pass code to Alexa redirect_uri
        const dest = `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}code=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`;
        return {
          statusCode: 302,
          headers: { Location: dest },
          body: '',
        };
      }
    } catch (err) {
      const html = renderAuthPage({
        redirectUri, state, clientId, responseType,
        errorMessage: `Verbindungstest fehlgeschlagen: ${err.message}`,
        values: { serverUrl, apiKey },
      });
      return { statusCode: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html };
    }
  }

  // 6. POST /token (Exchange authorization code or refresh token for Alexa)
  if (method === 'POST' && rawPath === '/token') {
    let body = event.body || '';
    if (event.isBase64Encoded) {
      body = Buffer.from(body, 'base64').toString('utf8');
    }
    const params = new URLSearchParams(body);
    const grantType = params.get('grant_type') || 'authorization_code';
    const code = params.get('code') || params.get('refresh_token');

    if (!code) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'invalid_request', error_description: 'Missing code or refresh_token' }),
      };
    }

    const creds = decryptCredentials(code);
    if (!creds || !creds.baseUrl || !creds.apiKey) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid or corrupted authorization code' }),
      };
    }

    // Return the token (lasts 10 years / 315360000s)
    const tokenResponse = {
      access_token: code,
      token_type: 'Bearer',
      expires_in: 315360000,
      refresh_token: code,
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
      body: JSON.stringify(tokenResponse),
    };
  }

  return {
    statusCode: 404,
    headers: { 'Content-Type': 'text/plain' },
    body: 'Not Found',
  };
}

module.exports = {
  encryptCredentials,
  decryptCredentials,
  verifyAbsConnection,
  handleHttpRequest,
  renderAuthPage,
};
