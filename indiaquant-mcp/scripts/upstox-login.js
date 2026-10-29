#!/usr/bin/env node
/**
 * Upstox daily login helper.
 * Opens the Upstox login URL, captures the redirect on localhost, exchanges the
 * code for an access token and writes UPSTOX_ACCESS_TOKEN into .env.
 *
 * Needs in .env: UPSTOX_API_KEY, UPSTOX_API_SECRET, UPSTOX_REDIRECT_URI
 * (redirect must exactly match the app's Redirect URL, e.g. http://127.0.0.1:5000/callback)
 *
 *   npm run upstox-login
 */

import http from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import axios from 'axios';
import dotenv from 'dotenv';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
dotenv.config({ path: envPath });

const { UPSTOX_API_KEY: apiKey, UPSTOX_API_SECRET: apiSecret, UPSTOX_REDIRECT_URI: redirectUri } = process.env;
if (!apiKey || !apiSecret || !redirectUri) {
  console.error('Set UPSTOX_API_KEY, UPSTOX_API_SECRET and UPSTOX_REDIRECT_URI in .env first.');
  process.exit(1);
}

const redirect = new URL(redirectUri);
if (!['localhost', '127.0.0.1'].includes(redirect.hostname)) {
  console.error('UPSTOX_REDIRECT_URI must point to localhost/127.0.0.1 for this script.');
  process.exit(1);
}

const loginUrl = 'https://api.upstox.com/v2/login/authorization/dialog?' + new URLSearchParams({
  response_type: 'code',
  client_id: apiKey,
  redirect_uri: redirectUri,
});

function saveToken(token) {
  let env = readFileSync(envPath, 'utf8');
  env = /^UPSTOX_ACCESS_TOKEN=.*$/m.test(env)
    ? env.replace(/^UPSTOX_ACCESS_TOKEN=.*$/m, `UPSTOX_ACCESS_TOKEN=${token}`)
    : `${env.trimEnd()}\nUPSTOX_ACCESS_TOKEN=${token}\n`;
  writeFileSync(envPath, env);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== redirect.pathname) {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('No code in redirect.');
    return;
  }

  try {
    const { data } = await axios.post(
      'https://api.upstox.com/v2/login/authorization/token',
      new URLSearchParams({
        code,
        client_id: apiKey,
        client_secret: apiSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      { headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    saveToken(data.access_token);
    res.end('Upstox token saved to .env. You can close this tab and restart the MCP server.');
    console.log('✓ UPSTOX_ACCESS_TOKEN saved to .env (valid until ~3:30 AM IST tomorrow)');
  } catch (error) {
    const detail = error.response?.data?.errors?.[0]?.message || error.message;
    res.writeHead(500).end(`Token exchange failed: ${detail}`);
    console.error('Token exchange failed:', detail);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(Number(redirect.port) || 80, redirect.hostname, () => {
  console.log(`Log in to Upstox in the browser window (or open this URL):\n${loginUrl}\n`);
  const opener = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${opener} "${loginUrl}"`);
});
