/**
 * Options Analyzer Module
 * Options chain fetching, Greeks calculation, max pain, and unusual activity detection
 */

import yahooFinance, { withTimeout } from '../utils/yahooClient.js';
import { mapSymbol } from '../utils/symbolMapper.js';
import { calculateAllGreeks } from '../utils/blackScholes.js';
import { fetchOHLC, ttlFor } from './marketData.js';
import { config } from '../config.js';
import cache from '../utils/cache.js';
import { fetchUpstoxOptionChain, isUpstoxConfigured, normalizeUnderlying } from '../utils/upstoxClient.js';

/**
 * Calculate annualized historical volatility
 * @param {number[]} prices - Array of historical prices
 * @returns {number} Annualized volatility
 */
function calculateHistoricalVolatility(prices) {
  if (prices.length < 2) return 0.3; // Default 30%

  // Calculate daily returns
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i] / prices[i - 1]));
  }

  // Calculate standard deviation
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
  const dailyVolatility = Math.sqrt(variance);

  // Annualize (assuming 252 trading days)
  return dailyVolatility * Math.sqrt(252);
}

/**
 * Build one option leg with Black-Scholes Greeks
 */
function buildLeg(raw, spotPrice, timeToExpiry, fallbackVol, type) {
  const iv = raw.iv > 0 ? raw.iv : fallbackVol;
  const greeks = calculateAllGreeks(spotPrice, raw.strike, timeToExpiry, config.riskFreeRate, iv, type);

  return {
    strike: raw.strike,
    lastPrice: raw.lastPrice || 0,
    bid: raw.bid || 0,
    ask: raw.ask || 0,
    volume: raw.volume || 0,
    openInterest: raw.openInterest || 0,
    impliedVolatility: iv,
    inTheMoney: type === 'call' ? raw.strike < spotPrice : raw.strike > spotPrice,
    contractSymbol: raw.contractSymbol,
    ...greeks,
  };
}

/**
 * NSE options via Upstox (requires UPSTOX_ACCESS_TOKEN)
 */
async function loadFromUpstox(symbol, expiry) {
  const chain = await fetchUpstoxOptionChain(symbol, expiry);
  if (chain.rows.length === 0) {
    throw new Error(`Upstox returned an empty chain for ${chain.underlying} ${chain.expiryDate}`);
  }

  const leg = (row, side) => {
    const opt = row[side] || {};
    const md = opt.market_data || {};
    return {
      strike: row.strike_price,
      lastPrice: md.ltp,
      bid: md.bid_price,
      ask: md.ask_price,
      volume: md.volume,
      openInterest: md.oi,
      iv: (opt.option_greeks?.iv || 0) / 100, // Upstox reports IV in percent
      contractSymbol: opt.instrument_key,
    };
  };

  return {
    source: 'upstox',
    spotPrice: chain.rows[0].underlying_spot_price,
    expiryDate: chain.expiryDate,
    availableExpiries: chain.availableExpiries,
    lotSize: chain.lotSize,
    calls: chain.rows.map(r => leg(r, 'call_options')),
    puts: chain.rows.map(r => leg(r, 'put_options')),
  };
}

/**
 * Yahoo options (works for US tickers; Yahoo carries no NSE/BSE options)
 */
async function loadFromYahoo(symbol, expiry) {
  const yahooSymbol = mapSymbol(symbol);
  const data = await withTimeout(
    yahooFinance.options(yahooSymbol, expiry ? { date: new Date(expiry) } : {}),
    config.timeouts.yahoo,
    'Yahoo options'
  );
  const chain = data?.options?.[0];

  if (!chain || (chain.calls.length === 0 && chain.puts.length === 0)) {
    throw new Error(
      `No options data for ${symbol}. Yahoo Finance does not carry NSE/BSE options - ` +
      'set UPSTOX_ACCESS_TOKEN in .env to enable NSE option chains (see README).'
    );
  }

  const leg = (o) => ({
    strike: o.strike,
    lastPrice: o.lastPrice,
    bid: o.bid,
    ask: o.ask,
    volume: o.volume,
    openInterest: o.openInterest,
    iv: o.impliedVolatility,
    contractSymbol: o.contractSymbol,
  });

  return {
    source: 'yahoo',
    spotPrice: data.quote?.regularMarketPrice,
    expiryDate: new Date(chain.expirationDate).toISOString().split('T')[0],
    availableExpiries: (data.expirationDates || []).slice(0, 6).map(d => new Date(d).toISOString().split('T')[0]),
    lotSize: null,
    calls: chain.calls.map(leg),
    puts: chain.puts.map(leg),
  };
}

/**
 * Fetch options chain for a symbol
 * @param {string} symbol - Stock symbol
 * @param {string} expiry - Expiry date (optional, YYYY-MM-DD format)
 * @returns {Promise<Object>} Options chain data
 */
export async function fetchOptionsChain(symbol, expiry = null) {
  try {
    const cacheKey = `options:${normalizeUnderlying(symbol)}:${expiry || 'nearest'}`;

    return await cache.getOrSet(cacheKey, () => ttlFor('optionsChain'), async () => {
      // Chain and history (for HV fallback) in parallel
      const [chain, ohlcData] = await Promise.all([
        isUpstoxConfigured() ? loadFromUpstox(symbol, expiry) : loadFromYahoo(symbol, expiry),
        fetchOHLC(symbol, '1mo', '1d').catch(() => null),
      ]);

      const closes = ohlcData ? ohlcData.map(d => d.close) : [];
      const historicalVol = calculateHistoricalVolatility(closes);
      const spotPrice = chain.spotPrice || closes[closes.length - 1];

      // NSE options expire at 15:30 IST on expiry day
      const expiryTime = new Date(`${chain.expiryDate}T15:30:00+05:30`);
      const timeToExpiry = Math.max((expiryTime - Date.now()) / (1000 * 60 * 60 * 24 * 365), 1 / (365 * 24));

      const calls = chain.calls.map(c => buildLeg(c, spotPrice, timeToExpiry, historicalVol, 'call'));
      const puts = chain.puts.map(p => buildLeg(p, spotPrice, timeToExpiry, historicalVol, 'put'));

      return {
        symbol: symbol,
        source: chain.source,
        spotPrice: spotPrice,
        expiryDate: chain.expiryDate,
        availableExpiries: chain.availableExpiries,
        lotSize: chain.lotSize,
        daysToExpiry: Math.round(timeToExpiry * 365),
        historicalVolatility: historicalVol,
        calls: calls,
        puts: puts,
        callsCount: calls.length,
        putsCount: puts.length,
        timestamp: new Date().toISOString(),
      };
    });
  } catch (error) {
    console.error(`Error fetching options chain for ${symbol}:`, error.message);
    throw new Error(`Failed to fetch options chain: ${error.message}`);
  }
}

/**
 * Keep only the N strikes on each side of ATM.
 * A full NIFTY chain is ~100+ strikes x 2 legs; returning all of it bloats the
 * LLM context and response time without adding much signal.
 * @param {Object} chain - Output of fetchOptionsChain
 * @param {number} strikesEachSide - Strikes to keep above and below spot
 */
export function trimChainAroundATM(chain, strikesEachSide = 10) {
  const strikes = [...new Set([...chain.calls, ...chain.puts].map(o => o.strike))].sort((a, b) => a - b);
  if (strikes.length <= strikesEachSide * 2 + 1) return chain;

  let atm = 0;
  strikes.forEach((s, i) => {
    if (Math.abs(s - chain.spotPrice) < Math.abs(strikes[atm] - chain.spotPrice)) atm = i;
  });
  const lo = strikes[Math.max(0, atm - strikesEachSide)];
  const hi = strikes[Math.min(strikes.length - 1, atm + strikesEachSide)];
  const inRange = o => o.strike >= lo && o.strike <= hi;

  return {
    ...chain,
    calls: chain.calls.filter(inRange),
    puts: chain.puts.filter(inRange),
    strikeWindow: { atmStrike: strikes[atm], from: lo, to: hi, totalStrikes: strikes.length },
  };
}

/**
 * Calculate Greeks for a specific option
 * @param {Object} params - Parameters for Greeks calculation
 * @returns {Object} Greeks values
 */
export async function calculateGreeks(params) {
  try {
    const {
      spot,
      strike,
      expiry_date,
      volatility,
      option_type,
      risk_free_rate = config.riskFreeRate
    } = params;

    // Validate inputs
    if (!spot || !strike || !expiry_date || !volatility || !option_type) {
      throw new Error('Missing required parameters for Greeks calculation');
    }

    // Calculate time to expiry
    const expiryDate = new Date(expiry_date);
    const now = new Date();
    const timeToExpiry = (expiryDate - now) / (1000 * 60 * 60 * 24 * 365);

    if (timeToExpiry < 0) {
      throw new Error('Expiry date is in the past');
    }

    // Calculate Greeks
    const greeks = calculateAllGreeks(
      spot,
      strike,
      timeToExpiry,
      risk_free_rate,
      volatility,
      option_type
    );

    return {
      spot: spot,
      strike: strike,
      expiryDate: expiry_date,
      daysToExpiry: Math.round(timeToExpiry * 365),
      volatility: volatility,
      optionType: option_type,
      riskFreeRate: risk_free_rate,
      greeks: greeks,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Error calculating Greeks:', error.message);
    throw new Error(`Failed to calculate Greeks: ${error.message}`);
  }
}

/**
 * Calculate max pain point for options expiry
 * Max pain is the strike price where option writers (sellers) lose the least money
 * @param {Object} optionsChain - Options chain data
 * @returns {Object} Max pain analysis
 */
export function calculateMaxPain(optionsChain) {
  try {
    const { calls, puts, spotPrice } = optionsChain;

    if (!calls || !puts || calls.length === 0 || puts.length === 0) {
      throw new Error('Invalid options chain data');
    }

    // Get all unique strike prices
    const strikes = [...new Set([
      ...calls.map(c => c.strike),
      ...puts.map(p => p.strike)
    ])].sort((a, b) => a - b);

    // Calculate total pain for each strike
    const painByStrike = strikes.map(strike => {
      let totalPain = 0;

      // Calculate pain from call options
      calls.forEach(call => {
        if (strike > call.strike) {
          // Calls are ITM, writers lose money
          totalPain += (strike - call.strike) * call.openInterest;
        }
      });

      // Calculate pain from put options
      puts.forEach(put => {
        if (strike < put.strike) {
          // Puts are ITM, writers lose money
          totalPain += (put.strike - strike) * put.openInterest;
        }
      });

      return {
        strike: strike,
        totalPain: totalPain,
      };
    });

    // Find strike with minimum pain
    const maxPainPoint = painByStrike.reduce((min, current) => 
      current.totalPain < min.totalPain ? current : min
    );

    // Calculate Put-Call Ratio
    const totalCallOI = calls.reduce((sum, c) => sum + c.openInterest, 0);
    const totalPutOI = puts.reduce((sum, p) => sum + p.openInterest, 0);
    const putCallRatio = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

    // Find strikes with highest OI
    const topCallOI = [...calls].sort((a, b) => b.openInterest - a.openInterest).slice(0, 5);
    const topPutOI = [...puts].sort((a, b) => b.openInterest - a.openInterest).slice(0, 5);

    return {
      symbol: optionsChain.symbol,
      spotPrice: spotPrice,
      maxPainStrike: maxPainPoint.strike,
      maxPainValue: maxPainPoint.totalPain,
      distanceFromSpot: ((maxPainPoint.strike - spotPrice) / spotPrice * 100).toFixed(2),
      putCallRatio: putCallRatio.toFixed(2),
      totalCallOI: totalCallOI,
      totalPutOI: totalPutOI,
      interpretation: maxPainPoint.strike > spotPrice 
        ? 'Price may move up towards max pain'
        : maxPainPoint.strike < spotPrice
        ? 'Price may move down towards max pain'
        : 'Price is at max pain point',
      topCallStrikes: topCallOI.map(c => ({ strike: c.strike, oi: c.openInterest })),
      topPutStrikes: topPutOI.map(p => ({ strike: p.strike, oi: p.openInterest })),
      expiryDate: optionsChain.expiryDate,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Error calculating max pain:', error.message);
    throw new Error(`Failed to calculate max pain: ${error.message}`);
  }
}

/**
 * Detect unusual options activity
 * @param {string} symbol - Stock symbol
 * @returns {Promise<Object>} Unusual activity analysis
 */
export async function detectUnusualActivity(symbol) {
  try {
    // Fetch current options chain
    const optionsChain = await fetchOptionsChain(symbol);
    
    // Calculate average volume and OI from the chain
    const allOptions = [...optionsChain.calls, ...optionsChain.puts];
    
    if (allOptions.length === 0) {
      throw new Error('No options data available');
    }

    // Calculate statistics
    const avgVolume = allOptions.reduce((sum, opt) => sum + opt.volume, 0) / allOptions.length;
    const avgOI = allOptions.reduce((sum, opt) => sum + opt.openInterest, 0) / allOptions.length;

    // Find unusual activity (volume > 3x average or OI change significant)
    const unusualCalls = optionsChain.calls.filter(call => {
      const volumeRatio = avgVolume > 0 ? call.volume / avgVolume : 0;
      const volumeOIRatio = call.openInterest > 0 ? call.volume / call.openInterest : 0;
      
      return volumeRatio > 3 || volumeOIRatio > 0.5; // High volume relative to OI
    }).sort((a, b) => b.volume - a.volume).slice(0, 10);

    const unusualPuts = optionsChain.puts.filter(put => {
      const volumeRatio = avgVolume > 0 ? put.volume / avgVolume : 0;
      const volumeOIRatio = put.openInterest > 0 ? put.volume / put.openInterest : 0;
      
      return volumeRatio > 3 || volumeOIRatio > 0.5;
    }).sort((a, b) => b.volume - a.volume).slice(0, 10);

    // Total volumes
    const totalCallVolume = optionsChain.calls.reduce((sum, c) => sum + c.volume, 0);
    const totalPutVolume = optionsChain.puts.reduce((sum, p) => sum + p.volume, 0);

    // Calculate volume-weighted average strike (0 when there was no volume, e.g. pre-open)
    const callVolumeStrike = totalCallVolume > 0
      ? optionsChain.calls.reduce((sum, c) => sum + c.strike * c.volume, 0) / totalCallVolume
      : 0;
    const putVolumeStrike = totalPutVolume > 0
      ? optionsChain.puts.reduce((sum, p) => sum + p.strike * p.volume, 0) / totalPutVolume
      : 0;
    const volumeRatio = totalCallVolume > 0 ? totalPutVolume / totalCallVolume : 0;

    return {
      symbol: symbol,
      spotPrice: optionsChain.spotPrice,
      expiryDate: optionsChain.expiryDate,
      summary: {
        totalCallVolume: totalCallVolume,
        totalPutVolume: totalPutVolume,
        putCallVolumeRatio: volumeRatio.toFixed(2),
        averageVolume: Math.round(avgVolume),
        averageOI: Math.round(avgOI),
      },
      interpretation: volumeRatio > 1.5 
        ? 'Bearish: High put volume suggests hedging or bearish bets'
        : volumeRatio < 0.67
        ? 'Bullish: High call volume suggests bullish positioning'
        : 'Neutral: Balanced call and put activity',
      unusualCalls: unusualCalls.map(c => ({
        strike: c.strike,
        volume: c.volume,
        openInterest: c.openInterest,
        volumeToOI: (c.volume / Math.max(c.openInterest, 1)).toFixed(2),
        impliedVolatility: c.impliedVolatility.toFixed(4),
        delta: c.delta.toFixed(4),
      })),
      unusualPuts: unusualPuts.map(p => ({
        strike: p.strike,
        volume: p.volume,
        openInterest: p.openInterest,
        volumeToOI: (p.volume / Math.max(p.openInterest, 1)).toFixed(2),
        impliedVolatility: p.impliedVolatility.toFixed(4),
        delta: p.delta.toFixed(4),
      })),
      volumeWeightedStrikes: {
        calls: callVolumeStrike.toFixed(2),
        puts: putVolumeStrike.toFixed(2),
      },
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error(`Error detecting unusual activity for ${symbol}:`, error.message);
    throw new Error(`Failed to detect unusual activity: ${error.message}`);
  }
}
