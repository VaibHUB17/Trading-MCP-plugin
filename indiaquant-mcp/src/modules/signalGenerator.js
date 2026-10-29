/**
 * Signal Generator Module
 * Technical analysis, pattern detection, sentiment analysis, and signal fusion
 */

import { RSI, MACD, BollingerBands } from 'technicalindicators';
import axios from 'axios';
import { fetchOHLC, fetchLivePrice, ttlFor } from './marketData.js';
import { config, sentimentKeywords } from '../config.js';
import cache from '../utils/cache.js';

/**
 * Compute RSI (Relative Strength Index)
 * @param {number[]} closes - Array of closing prices
 * @param {number} period - RSI period (default 14)
 * @returns {number[]} RSI values
 */
export function computeRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) {
    throw new Error(`Need at least ${period + 1} data points for RSI calculation`);
  }

  const rsiInput = {
    values: closes,
    period: period,
  };

  return RSI.calculate(rsiInput);
}

/**
 * Compute MACD (Moving Average Convergence Divergence)
 * @param {number[]} closes - Array of closing prices
 * @returns {Object[]} Array of { MACD, signal, histogram }
 */
export function computeMACD(closes) {
  if (!closes || closes.length < 26) {
    throw new Error('Need at least 26 data points for MACD calculation');
  }

  const macdInput = {
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  };

  return MACD.calculate(macdInput);
}

/**
 * Compute Bollinger Bands
 * @param {number[]} closes - Array of closing prices
 * @param {number} period - Period (default 20)
 * @param {number} stdDev - Standard deviations (default 2)
 * @returns {Object[]} Array of { upper, middle, lower, pb }
 */
export function computeBollingerBands(closes, period = 20, stdDev = 2) {
  if (!closes || closes.length < period) {
    throw new Error(`Need at least ${period} data points for Bollinger Bands`);
  }

  const bbInput = {
    period: period,
    values: closes,
    stdDev: stdDev,
  };

  const bbResult = BollingerBands.calculate(bbInput);
  
  // Calculate %B (position within bands)
  return bbResult.map((band, idx) => {
    const close = closes[closes.length - bbResult.length + idx];
    const pb = band.upper !== band.lower 
      ? (close - band.lower) / (band.upper - band.lower) 
      : 0.5;
    
    return {
      upper: band.upper,
      middle: band.middle,
      lower: band.lower,
      pb: pb, // %B indicator
    };
  });
}

/**
 * Detect chart patterns
 * @param {Array} ohlcData - OHLC data
 * @returns {Object} Detected patterns
 */
export function detectPatterns(ohlcData) {
  if (!ohlcData || ohlcData.length < 20) {
    return { patterns: [], confidence: 0 };
  }

  const patterns = [];
  const closes = ohlcData.map(d => d.close);
  const highs = ohlcData.map(d => d.high);
  const lows = ohlcData.map(d => d.low);

  // Find local peaks and troughs
  const peaks = findPeaks(highs);
  const troughs = findTroughs(lows);

  // Double Top Detection
  if (peaks.length >= 2) {
    const lastTwoPeaks = peaks.slice(-2);
    const [peak1, peak2] = lastTwoPeaks;
    const priceDiff = Math.abs(highs[peak1] - highs[peak2]) / highs[peak1];
    
    if (priceDiff < 0.03 && peak2 > peak1) { // Within 3% and second peak is recent
      patterns.push({
        name: 'Double Top',
        type: 'bearish',
        confidence: 70,
        description: 'Two peaks at similar price levels suggesting reversal'
      });
    }
  }

  // Double Bottom Detection
  if (troughs.length >= 2) {
    const lastTwoTroughs = troughs.slice(-2);
    const [trough1, trough2] = lastTwoTroughs;
    const priceDiff = Math.abs(lows[trough1] - lows[trough2]) / lows[trough1];
    
    if (priceDiff < 0.03 && trough2 > trough1) {
      patterns.push({
        name: 'Double Bottom',
        type: 'bullish',
        confidence: 70,
        description: 'Two troughs at similar price levels suggesting reversal'
      });
    }
  }

  // Head and Shoulders Detection (simplified)
  if (peaks.length >= 3) {
    const lastThreePeaks = peaks.slice(-3);
    const [left, head, right] = lastThreePeaks.map(i => highs[i]);
    
    if (head > left && head > right && Math.abs(left - right) / left < 0.05) {
      patterns.push({
        name: 'Head and Shoulders',
        type: 'bearish',
        confidence: 75,
        description: 'Classic reversal pattern with head higher than shoulders'
      });
    }
  }

  // Inverse Head and Shoulders
  if (troughs.length >= 3) {
    const lastThreeTroughs = troughs.slice(-3);
    const [left, head, right] = lastThreeTroughs.map(i => lows[i]);
    
    if (head < left && head < right && Math.abs(left - right) / left < 0.05) {
      patterns.push({
        name: 'Inverse Head and Shoulders',
        type: 'bullish',
        confidence: 75,
        description: 'Classic bullish reversal pattern'
      });
    }
  }

  // Recent trend detection
  const recentCloses = closes.slice(-10);
  const trend = recentCloses[recentCloses.length - 1] > recentCloses[0] ? 'bullish' : 'bearish';
  const trendStrength = Math.abs(recentCloses[recentCloses.length - 1] - recentCloses[0]) / recentCloses[0] * 100;

  return {
    patterns: patterns,
    trend: trend,
    trendStrength: trendStrength,
    confidence: patterns.length > 0 ? Math.max(...patterns.map(p => p.confidence)) : 0
  };
}

/**
 * Find peaks in price data
 */
function findPeaks(data, window = 5) {
  const peaks = [];
  for (let i = window; i < data.length - window; i++) {
    let isPeak = true;
    for (let j = 1; j <= window; j++) {
      if (data[i] <= data[i - j] || data[i] <= data[i + j]) {
        isPeak = false;
        break;
      }
    }
    if (isPeak) peaks.push(i);
  }
  return peaks;
}

/**
 * Find troughs in price data
 */
function findTroughs(data, window = 5) {
  const troughs = [];
  for (let i = window; i < data.length - window; i++) {
    let isTrough = true;
    for (let j = 1; j <= window; j++) {
      if (data[i] >= data[i - j] || data[i] >= data[i + j]) {
        isTrough = false;
        break;
      }
    }
    if (isTrough) troughs.push(i);
  }
  return troughs;
}

/**
 * Keyword sentiment score for a piece of text.
 * Whole-word matching, so "up" does not match "update" and "cut" does not match "execute".
 */
const bullishRe = new RegExp(`\b(${sentimentKeywords.bullish.join('|')})\b`, 'g');
const bearishRe = new RegExp(`\b(${sentimentKeywords.bearish.join('|')})\b`, 'g');

function scoreText(text) {
  const lower = text.toLowerCase();
  return (lower.match(bullishRe) || []).length - (lower.match(bearishRe) || []).length;
}

function decodeEntities(str) {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/**
 * Build a news search query: company name is far more precise than tickers like "LT" or "ITC"
 */
async function buildNewsQuery(symbol) {
  try {
    const { name } = await fetchLivePrice(symbol);
    if (name) {
      const cleaned = name.replace(/\b(limited|ltd\.?)\s*$/i, '').trim();
      return `"${cleaned}" stock`;
    }
  } catch {
    // Fall through to the raw symbol
  }
  return `"${symbol}" stock NSE`;
}

/**
 * Primary news source: Google News RSS (no API key, India edition, ~300-800ms)
 */
async function fetchGoogleNews(query) {
  const url = 'https://news.google.com/rss/search?' + new URLSearchParams({
    q: `${query} when:7d`,
    hl: 'en-IN',
    gl: 'IN',
    ceid: 'IN:en',
  });
  const response = await axios.get(url, { timeout: config.timeouts.news, responseType: 'text' });
  const items = [...response.data.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 15);

  return items.map(([, item]) => {
    const tag = (name) => decodeEntities(item.match(new RegExp(`<${name}[^>]*>([\s\S]*?)</${name}>`))?.[1] || '');
    const source = tag('source');
    // Google appends " - Source" to every title
    const title = source && tag('title').endsWith(` - ${source}`)
      ? tag('title').slice(0, -(source.length + 3))
      : tag('title');
    return {
      title,
      description: null,
      url: tag('link'),
      publishedAt: tag('pubDate') ? new Date(tag('pubDate')).toISOString() : null,
      source,
    };
  });
}

/**
 * Fallback news source: NewsAPI (needs NEWSAPI_KEY; free tier is 100 req/day)
 */
async function fetchNewsApi(query) {
  const response = await axios.get('https://newsapi.org/v2/everything', {
    params: {
      q: query,
      language: 'en',
      sortBy: 'publishedAt',
      pageSize: 15,
      apiKey: config.newsApiKey,
    },
    timeout: config.timeouts.news,
  });

  return (response.data.articles || []).map(article => ({
    title: article.title,
    description: article.description,
    url: article.url,
    publishedAt: article.publishedAt,
    source: article.source?.name,
  }));
}

/**
 * Fetch and score news sentiment
 * @param {string} symbol - Stock symbol
 * @returns {Promise<Object>} Sentiment analysis result
 */
export async function fetchNewsSentiment(symbol) {
  const key = String(symbol).toUpperCase();
  try {
    return await cache.getOrSet(`sentiment:${key}`, () => ttlFor('newsSentiment'), async () => {
      const query = await buildNewsQuery(key);

      let articles;
      let source = 'google-news';
      try {
        articles = await fetchGoogleNews(query);
      } catch (error) {
        if (!config.newsApiKey) throw error;
        console.error(`Google News failed (${error.message}), falling back to NewsAPI`);
        source = 'newsapi';
        articles = await fetchNewsApi(query);
      }

      // Analyze sentiment
      let totalScore = 0;
      const scoredArticles = articles.map(article => {
        const score = scoreText(`${article.title} ${article.description || ''}`);
        totalScore += score;
        return {
          ...article,
          score: score,
          sentiment: score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral'
        };
      });

      // Normalize score to -1 to 1 range
      const avgScore = articles.length > 0 ? totalScore / articles.length : 0;
      const normalizedScore = Math.max(-1, Math.min(1, avgScore / 3));

      return {
        symbol: key,
        query: query,
        source: source,
        score: normalizedScore,
        sentiment: normalizedScore > 0.2 ? 'bullish' : normalizedScore < -0.2 ? 'bearish' : 'neutral',
        articlesAnalyzed: articles.length,
        topArticles: scoredArticles.slice(0, 5).map(({ description, ...a }) => (description ? { ...a, description } : a)),
        timestamp: new Date().toISOString(),
      };
    });
  } catch (error) {
    console.error(`Error fetching news sentiment for ${symbol}:`, error.message);

    // Return neutral sentiment on error (not cached, so the next call retries)
    return {
      symbol: key,
      score: 0,
      sentiment: 'neutral',
      articlesAnalyzed: 0,
      topArticles: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Generate trading signal by fusing multiple indicators
 * @param {string} symbol - Stock symbol
 * @param {string} timeframe - Time period (1mo, 3mo, 6mo, 1y)
 * @returns {Promise<Object>} Trading signal with confidence
 */
export async function generateSignal(symbol, timeframe = '3mo') {
  try {
    // MACD(12,26,9) needs ~35 daily bars; 1mo only has ~21, so fetch at least 3mo
    const dataPeriod = timeframe === '1mo' ? '3mo' : timeframe;

    // Fetch price, OHLC and news in parallel (sentiment never throws)
    const [priceData, ohlcData, sentiment] = await Promise.all([
      fetchLivePrice(symbol),
      fetchOHLC(symbol, dataPeriod, '1d'),
      fetchNewsSentiment(symbol)
    ]);

    const closes = ohlcData.map(d => d.close);
    const highs = ohlcData.map(d => d.high);
    const lows = ohlcData.map(d => d.low);

    // Calculate indicators
    const rsi = computeRSI(closes);
    const macd = computeMACD(closes);
    const bollinger = computeBollingerBands(closes);
    const patterns = detectPatterns(ohlcData);

    // Get latest values
    const currentRSI = rsi[rsi.length - 1];
    const currentMACD = macd[macd.length - 1];
    const currentBB = bollinger[bollinger.length - 1];
    const currentPrice = priceData.price;

    // Scoring system (0-100 for each indicator)
    let scores = {
      rsi: 50,
      macd: 50,
      bollinger: 50,
      pattern: 50,
      sentiment: 50,
    };

    let reasoning = [];

    // RSI Analysis (Weight: 25%)
    if (currentRSI < 30) {
      scores.rsi = 75;
      reasoning.push(`RSI at ${currentRSI.toFixed(2)} indicates oversold conditions`);
    } else if (currentRSI > 70) {
      scores.rsi = 25;
      reasoning.push(`RSI at ${currentRSI.toFixed(2)} indicates overbought conditions`);
    } else {
      scores.rsi = 50 + (50 - currentRSI) / 2;
      reasoning.push(`RSI at ${currentRSI.toFixed(2)} is neutral`);
    }

    // MACD Analysis (Weight: 25%)
    if (currentMACD.MACD > currentMACD.signal && currentMACD.histogram > 0) {
      scores.macd = 75;
      reasoning.push('MACD shows bullish momentum with positive histogram');
    } else if (currentMACD.MACD < currentMACD.signal && currentMACD.histogram < 0) {
      scores.macd = 25;
      reasoning.push('MACD shows bearish momentum with negative histogram');
    } else {
      scores.macd = 50;
      reasoning.push('MACD signals are neutral');
    }

    // Bollinger Bands Analysis (Weight: 20%)
    if (currentBB.pb < 0.2) {
      scores.bollinger = 75;
      reasoning.push('Price near lower Bollinger Band, potential bounce');
    } else if (currentBB.pb > 0.8) {
      scores.bollinger = 25;
      reasoning.push('Price near upper Bollinger Band, potential pullback');
    } else {
      scores.bollinger = 50;
      reasoning.push('Price within normal Bollinger Band range');
    }

    // Pattern Analysis (Weight: 15%)
    if (patterns.patterns.length > 0) {
      const bullishPatterns = patterns.patterns.filter(p => p.type === 'bullish');
      const bearishPatterns = patterns.patterns.filter(p => p.type === 'bearish');
      
      if (bullishPatterns.length > bearishPatterns.length) {
        scores.pattern = 70;
        reasoning.push(`Detected ${bullishPatterns.map(p => p.name).join(', ')}`);
      } else if (bearishPatterns.length > bullishPatterns.length) {
        scores.pattern = 30;
        reasoning.push(`Detected ${bearishPatterns.map(p => p.name).join(', ')}`);
      } else {
        scores.pattern = 50;
      }
    } else {
      scores.pattern = 50;
      reasoning.push('No significant chart patterns detected');
    }

    // Sentiment Analysis (Weight: 15%)
    if (sentiment.score > 0.2) {
      scores.sentiment = 70;
      reasoning.push(`News sentiment is ${sentiment.sentiment} (${sentiment.score.toFixed(2)})`);
    } else if (sentiment.score < -0.2) {
      scores.sentiment = 30;
      reasoning.push(`News sentiment is ${sentiment.sentiment} (${sentiment.score.toFixed(2)})`);
    } else {
      scores.sentiment = 50;
      reasoning.push('News sentiment is neutral');
    }

    // Calculate weighted final score
    const weights = {
      rsi: 0.25,
      macd: 0.25,
      bollinger: 0.20,
      pattern: 0.15,
      sentiment: 0.15,
    };

    const finalScore = 
      scores.rsi * weights.rsi +
      scores.macd * weights.macd +
      scores.bollinger * weights.bollinger +
      scores.pattern * weights.pattern +
      scores.sentiment * weights.sentiment;

    // Determine signal
    let signal, confidence;
    if (finalScore >= 60) {
      signal = 'BUY';
      confidence = finalScore;
    } else if (finalScore <= 40) {
      signal = 'SELL';
      confidence = 100 - finalScore;
    } else {
      signal = 'HOLD';
      confidence = 50;
    }

    return {
      symbol: symbol,
      signal: signal,
      confidence: Math.round(confidence),
      currentPrice: currentPrice,
      indicators: {
        rsi: {
          value: currentRSI,
          signal: scores.rsi > 60 ? 'bullish' : scores.rsi < 40 ? 'bearish' : 'neutral',
        },
        macd: {
          value: currentMACD.MACD,
          signal: currentMACD.signal,
          histogram: currentMACD.histogram,
          trend: scores.macd > 60 ? 'bullish' : scores.macd < 40 ? 'bearish' : 'neutral',
        },
        bollinger: {
          upper: currentBB.upper,
          middle: currentBB.middle,
          lower: currentBB.lower,
          percentB: currentBB.pb,
          position: scores.bollinger > 60 ? 'near lower' : scores.bollinger < 40 ? 'near upper' : 'middle',
        },
        patterns: patterns.patterns,
        sentiment: {
          score: sentiment.score,
          sentiment: sentiment.sentiment,
          articlesAnalyzed: sentiment.articlesAnalyzed,
        },
      },
      reasoning: reasoning,
      timeframe: timeframe,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error(`Error generating signal for ${symbol}:`, error.message);
    throw new Error(`Failed to generate signal: ${error.message}`);
  }
}
