/**
 * Market Data Module
 * Fetches live prices and historical OHLC data using yahoo-finance2
 *
 * Latency strategy:
 *  - Live prices go through quoteCombine(): concurrent lookups (heatmap, scanner,
 *    portfolio) are merged into a single batched HTTP request.
 *  - If the quote endpoint fails (crumb/429), fall back to the chart endpoint,
 *    which needs no crumb.
 *  - Every fetch is cached with a market-hours-aware TTL and coalesced in-flight.
 */

import yahooFinance, { withTimeout } from '../utils/yahooClient.js';
import { mapSymbol, isValidSymbol } from '../utils/symbolMapper.js';
import cache from '../utils/cache.js';
import { config } from '../config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Check if market is currently open (IST timezone)
 */
export function isMarketOpen() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
  const istTime = new Date(now.getTime() + istOffset);

  const day = istTime.getUTCDay();
  const hour = istTime.getUTCHours();
  const minute = istTime.getUTCMinutes();

  // Weekend check (Saturday=6, Sunday=0)
  if (day === 0 || day === 6) return false;

  // Market hours: 9:15 AM to 3:30 PM IST
  const currentMinutes = hour * 60 + minute;
  const marketStart = config.marketHours.start.hour * 60 + config.marketHours.start.minute;
  const marketEnd = config.marketHours.end.hour * 60 + config.marketHours.end.minute;

  return currentMinutes >= marketStart && currentMinutes <= marketEnd;
}

/**
 * Resolve a cache TTL (seconds) for the current market state
 * @param {string} kind - Key of config.cacheTTL
 */
export function ttlFor(kind) {
  const ttl = config.cacheTTL[kind];
  return isMarketOpen() ? ttl.open : ttl.closed;
}

/**
 * Primary source: batched quote endpoint
 */
async function loadQuote(yahooSymbol) {
  const q = await withTimeout(
    yahooFinance.quoteCombine(yahooSymbol),
    config.timeouts.yahoo,
    'Yahoo quote'
  );
  if (!q || q.regularMarketPrice == null) {
    throw new Error('empty quote');
  }

  const price = q.regularMarketPrice;
  return {
    name: q.longName || q.shortName || null,
    price,
    change: q.regularMarketChange || 0,
    changePct: q.regularMarketChangePercent || 0,
    volume: q.regularMarketVolume || 0,
    high: q.regularMarketDayHigh || price,
    low: q.regularMarketDayLow || price,
    open: q.regularMarketOpen || price,
    previousClose: q.regularMarketPreviousClose || price,
    marketCap: q.marketCap || 0,
    fiftyTwoWeekHigh: q.fiftyTwoWeekHigh || 0,
    fiftyTwoWeekLow: q.fiftyTwoWeekLow || 0,
    currency: q.currency || 'INR',
    source: 'yahoo-quote',
  };
}

/**
 * Fallback source: chart endpoint (no crumb required)
 */
async function loadQuoteFromChart(yahooSymbol) {
  const chart = await withTimeout(
    yahooFinance.chart(yahooSymbol, { period1: new Date(Date.now() - 7 * DAY_MS), interval: '1d' }),
    config.timeouts.yahoo,
    'Yahoo chart'
  );
  const meta = chart.meta;
  if (!meta || meta.regularMarketPrice == null) {
    throw new Error('empty chart');
  }

  const bars = (chart.quotes || []).filter(b => b.close != null);
  const price = meta.regularMarketPrice;
  const previousClose = bars.length >= 2 ? bars[bars.length - 2].close : (meta.chartPreviousClose || price);
  const change = price - previousClose;
  const lastBar = bars[bars.length - 1] || {};

  return {
    name: meta.longName || meta.shortName || null,
    price,
    change,
    changePct: previousClose ? (change / previousClose) * 100 : 0,
    volume: meta.regularMarketVolume || lastBar.volume || 0,
    high: meta.regularMarketDayHigh || lastBar.high || price,
    low: meta.regularMarketDayLow || lastBar.low || price,
    open: lastBar.open || price,
    previousClose,
    marketCap: 0,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || 0,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow || 0,
    currency: meta.currency || 'INR',
    source: 'yahoo-chart',
  };
}

/**
 * Fetch live price for a symbol
 * @param {string} symbol - Stock symbol (e.g., RELIANCE, TCS)
 * @returns {Promise<Object>} Price data (changePct is in percent, e.g. 1.25 = +1.25%)
 */
export async function fetchLivePrice(symbol) {
  try {
    if (!isValidSymbol(symbol)) {
      throw new Error(`Invalid symbol: ${symbol}`);
    }

    const yahooSymbol = mapSymbol(symbol);

    const data = await cache.getOrSet(`price:${yahooSymbol}`, () => ttlFor('livePrice'), async () => {
      let quote;
      try {
        quote = await loadQuote(yahooSymbol);
      } catch (error) {
        console.error(`Quote failed for ${yahooSymbol} (${error.message}), falling back to chart`);
        quote = await loadQuoteFromChart(yahooSymbol);
      }
      return { ...quote, fetchedAt: new Date().toISOString() };
    });

    const marketOpen = isMarketOpen();
    const result = {
      symbol: symbol,
      yahooSymbol: yahooSymbol,
      ...data,
      timestamp: data.fetchedAt,
      marketOpen,
    };
    delete result.fetchedAt;

    // If market is closed, add a note
    if (!marketOpen) {
      result.note = 'Market is closed. Showing last traded price.';
    }

    return result;
  } catch (error) {
    console.error(`Error fetching live price for ${symbol}:`, error.message);
    throw new Error(`Failed to fetch price for ${symbol}: ${error.message}`);
  }
}

/**
 * Fetch historical OHLC data
 * @param {string} symbol - Stock symbol
 * @param {string} period - Time period (1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, max)
 * @param {string} interval - Data interval (1m, 5m, 15m, 1h, 1d, 1wk, 1mo)
 * @returns {Promise<Array>} Array of OHLC data
 */
export async function fetchOHLC(symbol, period = '1mo', interval = '1d') {
  try {
    if (!isValidSymbol(symbol)) {
      throw new Error(`Invalid symbol: ${symbol}`);
    }

    const yahooSymbol = mapSymbol(symbol);
    const cacheKey = `ohlc:${yahooSymbol}:${period}:${interval}`;

    return await cache.getOrSet(cacheKey, () => ttlFor('ohlc'), async () => {
      const result = await withTimeout(
        yahooFinance.chart(yahooSymbol, {
          period1: getPeriodStartDate(period),
          interval: interval,
        }),
        config.timeouts.yahoo,
        'Yahoo chart'
      );

      if (!result || !result.quotes || result.quotes.length === 0) {
        throw new Error(`No historical data available for ${symbol}`);
      }

      // Format the data
      const ohlcData = result.quotes
        .filter(q => q.open && q.high && q.low && q.close) // Filter out incomplete data
        .map(quote => ({
          date: quote.date ? new Date(quote.date).toISOString() : null,
          timestamp: quote.date ? Math.floor(new Date(quote.date).getTime() / 1000) : null,
          open: quote.open,
          high: quote.high,
          low: quote.low,
          close: quote.close,
          volume: quote.volume || 0,
        }));

      if (ohlcData.length === 0) {
        throw new Error(`No valid OHLC data for ${symbol}`);
      }

      return ohlcData;
    });
  } catch (error) {
    console.error(`Error fetching OHLC for ${symbol}:`, error.message);
    throw new Error(`Failed to fetch OHLC data for ${symbol}: ${error.message}`);
  }
}

/**
 * Get period start date based on period string
 */
function getPeriodStartDate(period) {
  const periodMap = {
    '1d': 1,
    '5d': 5,
    '1mo': 30,
    '3mo': 90,
    '6mo': 180,
    '1y': 365,
    '2y': 730,
    '5y': 1825,
    'max': 3650,
  };

  const days = periodMap[period] || 30;
  return new Date(Date.now() - days * DAY_MS);
}

/**
 * Fetch multiple symbols at once (merged into one batched request by quoteCombine)
 * @param {string[]} symbols - Array of symbols
 * @returns {Promise<Object>} Object with symbol as key and price data as value
 */
export async function fetchMultiplePrices(symbols) {
  const settled = await Promise.allSettled(symbols.map(s => fetchLivePrice(s)));
  const results = {};
  settled.forEach((r, i) => {
    results[symbols[i]] = r.status === 'fulfilled'
      ? r.value
      : { error: true, message: r.reason.message };
  });
  return results;
}

/**
 * Get basic company info
 * @param {string} symbol - Stock symbol
 * @returns {Promise<Object>} Company information
 */
export async function fetchCompanyInfo(symbol) {
  try {
    const yahooSymbol = mapSymbol(symbol);

    return await cache.getOrSet(`info:${yahooSymbol}`, () => ttlFor('companyInfo'), async () => {
      const quote = await withTimeout(
        yahooFinance.quoteSummary(yahooSymbol, { modules: ['price', 'assetProfile'] }),
        config.timeouts.yahoo,
        'Yahoo quoteSummary'
      );

      return {
        symbol: symbol,
        name: quote.price?.longName || quote.price?.shortName || symbol,
        sector: quote.assetProfile?.sector || 'N/A',
        industry: quote.assetProfile?.industry || 'N/A',
        marketCap: quote.price?.marketCap || 0,
        currency: quote.price?.currency || 'INR',
      };
    });
  } catch (error) {
    console.error(`Error fetching company info for ${symbol}:`, error.message);
    return {
      symbol: symbol,
      name: symbol,
      sector: 'N/A',
      industry: 'N/A',
      error: error.message
    };
  }
}
