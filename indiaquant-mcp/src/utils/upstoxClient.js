/**
 * Upstox client - NSE options chain (Yahoo has no Indian options data)
 *
 * Needs UPSTOX_ACCESS_TOKEN (free Upstox account + API app). Tokens expire daily
 * around 3:30 AM IST and must be regenerated.
 * Docs: https://upstox.com/developer/api-documentation/get-pc-option-chain
 */

import axios from 'axios';
import { gunzipSync } from 'zlib';
import cache from './cache.js';
import { config } from '../config.js';

const API_BASE = 'https://api.upstox.com/v2';
const MASTER_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Yahoo/plain aliases -> NSE F&O underlying symbol
const UNDERLYING_ALIASES = {
  '^NSEI': 'NIFTY',
  NIFTY50: 'NIFTY',
  '^NSEBANK': 'BANKNIFTY',
  NIFTYBANK: 'BANKNIFTY',
};

export function isUpstoxConfigured() {
  return Boolean(config.upstoxAccessToken);
}

function toIstDate(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function normalizeUnderlying(symbol) {
  const plain = String(symbol).toUpperCase().trim().replace(/\.(NS|BO)$/, '');
  return UNDERLYING_ALIASES[plain] || plain;
}

/**
 * Download the public instrument master (~1.9MB gz) and index option underlyings.
 * Cached for 12h; only the compact index is kept in memory.
 * @returns {Promise<Map<string, {underlyingKey: string, lotSize: number, expiries: string[]}>>}
 */
async function loadOptionUnderlyings() {
  const ttl = config.cacheTTL.instrumentMaster.open;
  return cache.getOrSet('upstox:optionUnderlyings', ttl, async () => {
    const started = Date.now();
    const response = await axios.get(MASTER_URL, {
      responseType: 'arraybuffer',
      timeout: config.timeouts.instrumentMaster,
    });
    const rows = JSON.parse(gunzipSync(Buffer.from(response.data)).toString('utf8'));

    const index = new Map();
    for (const row of rows) {
      if (row.segment !== 'NSE_FO' || (row.instrument_type !== 'CE' && row.instrument_type !== 'PE')) continue;
      let entry = index.get(row.underlying_symbol);
      if (!entry) {
        entry = { underlyingKey: row.underlying_key, lotSize: row.lot_size, expiries: new Set() };
        index.set(row.underlying_symbol, entry);
      }
      entry.expiries.add(toIstDate(row.expiry));
    }
    for (const entry of index.values()) {
      entry.expiries = [...entry.expiries].sort();
    }

    console.error(`✓ Upstox instrument master loaded: ${index.size} option underlyings in ${Date.now() - started}ms`);
    return index;
  });
}

/**
 * Fetch raw option chain rows from Upstox
 * @param {string} symbol - e.g. NIFTY, BANKNIFTY, RELIANCE
 * @param {string|null} expiry - YYYY-MM-DD, nearest if omitted
 */
export async function fetchUpstoxOptionChain(symbol, expiry = null) {
  const underlying = normalizeUnderlying(symbol);
  const index = await loadOptionUnderlyings();
  const entry = index.get(underlying);
  if (!entry) {
    throw new Error(`${underlying} has no NSE options (not an F&O underlying)`);
  }

  const today = toIstDate(Date.now());
  const expiryDate = expiry || entry.expiries.find(d => d >= today);
  if (!expiryDate || !entry.expiries.includes(expiryDate)) {
    throw new Error(`Invalid expiry ${expiry}. Available: ${entry.expiries.filter(d => d >= today).slice(0, 6).join(', ')}`);
  }

  try {
    const response = await axios.get(`${API_BASE}/option/chain`, {
      params: { instrument_key: entry.underlyingKey, expiry_date: expiryDate },
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.upstoxAccessToken}`,
      },
      timeout: config.timeouts.upstox,
    });

    return {
      underlying,
      lotSize: entry.lotSize,
      expiryDate,
      availableExpiries: entry.expiries.filter(d => d >= today).slice(0, 6),
      rows: response.data?.data || [],
    };
  } catch (error) {
    if (error.response?.status === 401) {
      throw new Error('Upstox access token is invalid or expired (tokens expire daily ~3:30 AM IST). Generate a new one and update UPSTOX_ACCESS_TOKEN in .env');
    }
    const detail = error.response?.data?.errors?.[0]?.message;
    throw new Error(`Upstox option chain failed: ${detail || error.message}`);
  }
}
