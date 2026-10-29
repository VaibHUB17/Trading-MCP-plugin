/**
 * Shared yahoo-finance2 client
 * One instance = one cookie/crumb session reused by every module.
 */

import YahooFinance from 'yahoo-finance2';
import { config } from '../config.js';

// MCP uses stdout for protocol messages, so every library log must go to stderr
const stderrLogger = {
  info: (...args) => console.error(...args),
  warn: (...args) => console.error(...args),
  error: (...args) => console.error(...args),
  debug: () => {},
  dir: (...args) => console.error(...args),
};

const yahooFinance = new YahooFinance({
  logger: stderrLogger,
  suppressNotices: ['yahooSurvey'],
  queue: { concurrency: config.yahooConcurrency },
  // Concurrent quoteCombine() calls within this window become one batch HTTP request
  quoteCombine: { debounceTime: 25 },
  versionCheck: false,
});

/**
 * Race a promise against a timeout
 */
export function withTimeout(promise, ms, label = 'request') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Warm the Yahoo cookie + crumb handshake (~800ms) so the first tool call doesn't pay it
 */
export async function warmUp() {
  try {
    await yahooFinance.quote('^NSEI');
    console.error('✓ Yahoo session warmed');
  } catch (error) {
    console.error('Yahoo warm-up failed (will retry lazily):', error.message);
  }
}

export default yahooFinance;
