/**
 * Market Scanner Module
 * Sector heatmap and market scanning with technical filters
 */

import { fetchLivePrice, fetchOHLC, fetchMultiplePrices } from './marketData.js';
import { computeRSI, computeMACD, computeBollingerBands } from './signalGenerator.js';
import { config } from '../config.js';

/**
 * Get sector heatmap showing performance of major sectors
 * @returns {Promise<Object>} Sector performance heatmap
 */
export async function getSectorHeatmap() {
  try {
    console.error('Fetching sector heatmap...');

    // NIFTY + all sectors are requested together; quoteCombine merges them into one HTTP call
    const niftyPromise = fetchLivePrice('NIFTY');

    const sectorPromises = config.sectorIndices.map(async (sector) => {
      try {
        // fetchLivePrice enforces its own upstream timeout
        const priceData = await fetchLivePrice(sector.symbol);

        return {
          name: sector.name,
          symbol: sector.symbol,
          price: priceData.price,
          change: priceData.change,
          changePct: priceData.changePct,
          volume: priceData.volume,
        };
      } catch (error) {
        console.error(`Error fetching ${sector.name}: ${error.message}`);
        // Return zero change instead of failing
        return {
          name: sector.name,
          symbol: sector.symbol,
          error: error.message,
          changePct: 0,
          price: 0,
          change: 0,
        };
      }
    });

    const sectorData = await Promise.all(sectorPromises);
    
    // Continue with existing logic...
    const sortedSectors = sectorData
      .filter(s => !s.error || s.changePct !== undefined)  // Show even if timeout
      .sort((a, b) => b.changePct - a.changePct);
    
    // Calculate market breadth
    const gainers = sortedSectors.filter(s => s.changePct > 0).length;
    const losers = sortedSectors.filter(s => s.changePct < 0).length;
    const unchanged = sortedSectors.filter(s => s.changePct === 0).length;

    // NIFTY 50 for market context (already in flight)
    const niftyData = await niftyPromise;

    return {
      sectors: sortedSectors,
      marketBreadth: {
        gainers: gainers,
        losers: losers,
        unchanged: unchanged,
        advanceDeclineRatio: losers > 0 ? (gainers / losers).toFixed(2) : gainers,
      },
      marketContext: {
        index: 'NIFTY 50',
        price: niftyData.price,
        change: niftyData.change,
        changePct: niftyData.changePct,
      },
      topGainer: sortedSectors[0],
      topLoser: sortedSectors[sortedSectors.length - 1],
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Error getting sector heatmap:', error.message);
    throw new Error(`Failed to get sector heatmap: ${error.message}`);
  }
}

/**
 * Scan market based on technical criteria
 * @param {string} filter - Filter type
 * @param {number} value - Optional value for filter
 * @returns {Promise<Object>} Scan results
 */
export async function scanMarket(filter, value = null) {
  try {
    console.error(`Scanning market with filter: ${filter}...`);
    
    const validFilters = [
      'oversold', 'overbought', 'macd_crossover', 
      'near_52w_high', 'near_52w_low', 'high_volume',
      'breakout', 'breakdown'
    ];

    if (!validFilters.includes(filter)) {
      throw new Error(`Invalid filter. Valid filters: ${validFilters.join(', ')}`);
    }

    // Get stocks to scan (Nifty 50)
    const stocksToScan = config.nifty50Stocks;

    // Indicator filters and high_volume need daily OHLC; 52w filters only need the quote
    const needsOHLC = filter !== 'near_52w_high' && filter !== 'near_52w_low';
    const failedSymbols = [];

    // Scan all symbols at once: quotes are merged into one batched request by
    // quoteCombine and charts are throttled by the shared Yahoo queue (no fixed sleeps)
    const scanPromises = stocksToScan.map(async (symbol) => {
      try {
        // Quote and chart are fetched in parallel
        const [priceData, ohlcData] = await Promise.all([
          fetchLivePrice(symbol),
          needsOHLC ? fetchOHLC(symbol, '3mo', '1d') : null,
        ]);

        // Common filters that need OHLC data
        if (['oversold', 'overbought', 'macd_crossover', 'breakout', 'breakdown'].includes(filter)) {
          const closes = ohlcData.map(d => d.close);

          let matches = false;
          let reason = '';
          let indicatorValue = null;

          switch (filter) {
            case 'oversold':
              const rsi = computeRSI(closes);
              const currentRSI = rsi[rsi.length - 1];
              indicatorValue = currentRSI;
              const threshold = value || 30;
              if (currentRSI < threshold) {
                matches = true;
                reason = `RSI ${currentRSI.toFixed(2)} below ${threshold}`;
              }
              break;

            case 'overbought':
              const rsiOB = computeRSI(closes);
              const currentRSIOB = rsiOB[rsiOB.length - 1];
              indicatorValue = currentRSIOB;
              const thresholdOB = value || 70;
              if (currentRSIOB > thresholdOB) {
                matches = true;
                reason = `RSI ${currentRSIOB.toFixed(2)} above ${thresholdOB}`;
              }
              break;

            case 'macd_crossover':
              const macd = computeMACD(closes);
              const current = macd[macd.length - 1];
              const previous = macd[macd.length - 2];
              
              // Bullish crossover: MACD crosses above signal
              if (previous.MACD < previous.signal && current.MACD > current.signal) {
                matches = true;
                reason = 'Bullish MACD crossover';
                indicatorValue = current.MACD;
              }
              break;

            case 'breakout':
              const bb = computeBollingerBands(closes);
              const currentBB = bb[bb.length - 1];
              const currentPrice = priceData.price;
              
              if (currentPrice > currentBB.upper) {
                matches = true;
                reason = `Price (${currentPrice.toFixed(2)}) above upper Bollinger Band (${currentBB.upper.toFixed(2)})`;
                indicatorValue = currentPrice;
              }
              break;

            case 'breakdown':
              const bbBreakdown = computeBollingerBands(closes);
              const currentBBBreakdown = bbBreakdown[bbBreakdown.length - 1];
              const currentPriceBreakdown = priceData.price;
              
              if (currentPriceBreakdown < currentBBBreakdown.lower) {
                matches = true;
                reason = `Price (${currentPriceBreakdown.toFixed(2)}) below lower Bollinger Band (${currentBBBreakdown.lower.toFixed(2)})`;
                indicatorValue = currentPriceBreakdown;
              }
              break;
          }

          if (matches) {
            return {
              symbol: symbol,
              price: priceData.price,
              change: priceData.change,
              changePct: priceData.changePct,
              volume: priceData.volume,
              indicatorValue: indicatorValue,
              reason: reason,
              timestamp: priceData.timestamp,
            };
          }
        }
        // Filters based on price data only
        else if (filter === 'near_52w_high') {
          const threshold = value || 5; // Within 5% by default
          const distanceFromHigh = ((priceData.fiftyTwoWeekHigh - priceData.price) / priceData.fiftyTwoWeekHigh) * 100;
          
          if (distanceFromHigh <= threshold && distanceFromHigh >= 0) {
            return {
              symbol: symbol,
              price: priceData.price,
              change: priceData.change,
              changePct: priceData.changePct,
              fiftyTwoWeekHigh: priceData.fiftyTwoWeekHigh,
              distanceFromHigh: distanceFromHigh.toFixed(2),
              reason: `Within ${distanceFromHigh.toFixed(2)}% of 52-week high`,
              timestamp: priceData.timestamp,
            };
          }
        }
        else if (filter === 'near_52w_low') {
          const threshold = value || 5; // Within 5% by default
          const distanceFromLow = ((priceData.price - priceData.fiftyTwoWeekLow) / priceData.fiftyTwoWeekLow) * 100;
          
          if (distanceFromLow <= threshold && distanceFromLow >= 0) {
            return {
              symbol: symbol,
              price: priceData.price,
              change: priceData.change,
              changePct: priceData.changePct,
              fiftyTwoWeekLow: priceData.fiftyTwoWeekLow,
              distanceFromLow: distanceFromLow.toFixed(2),
              reason: `Within ${distanceFromLow.toFixed(2)}% of 52-week low`,
              timestamp: priceData.timestamp,
            };
          }
        }
        else if (filter === 'high_volume') {
          // Average volume over the last 20 sessions
          const volumes = ohlcData.slice(-20).map(d => d.volume);
          const avgVolume = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
          const volumeRatio = priceData.volume / avgVolume;
          const threshold = value || 2; // 2x average by default
          
          if (volumeRatio >= threshold) {
            return {
              symbol: symbol,
              price: priceData.price,
              change: priceData.change,
              changePct: priceData.changePct,
              volume: priceData.volume,
              avgVolume: Math.round(avgVolume),
              volumeRatio: volumeRatio.toFixed(2),
              reason: `Volume ${volumeRatio.toFixed(2)}x above average`,
              timestamp: priceData.timestamp,
            };
          }
        }

        return null;
      } catch (error) {
        failedSymbols.push(symbol);
        console.error(`Error scanning ${symbol}:`, error.message);
        return null;
      }
    });

    const results = (await Promise.all(scanPromises)).filter(r => r !== null);

    // Sort by relevance
    let sortedResults;
    if (filter === 'oversold') {
      sortedResults = results.sort((a, b) => a.indicatorValue - b.indicatorValue);
    } else if (filter === 'overbought') {
      sortedResults = results.sort((a, b) => b.indicatorValue - a.indicatorValue);
    } else if (filter === 'high_volume') {
      sortedResults = results.sort((a, b) => b.volumeRatio - a.volumeRatio);
    } else {
      sortedResults = results;
    }

    return {
      filter: filter,
      filterValue: value,
      totalScanned: stocksToScan.length,
      failed: failedSymbols,
      matchesFound: results.length,
      results: sortedResults,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Error scanning market:', error.message);
    throw new Error(`Failed to scan market: ${error.message}`);
  }
}

/**
 * Get top gainers and losers
 * @param {number} limit - Number of stocks to return
 * @returns {Promise<Object>} Top gainers and losers
 */
export async function getTopMovers(limit = 10) {
  try {
    console.error('Fetching top movers...');
    
    const stockPrices = await fetchMultiplePrices(config.nifty50Stocks);
    
    const validPrices = Object.entries(stockPrices)
      .filter(([_, data]) => !data.error)
      .map(([symbol, data]) => ({
        symbol: symbol,
        price: data.price,
        change: data.change,
        changePct: data.changePct,
        volume: data.volume,
      }));

    const gainers = validPrices
      .filter(s => s.changePct > 0)
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, limit);

    const losers = validPrices
      .filter(s => s.changePct < 0)
      .sort((a, b) => a.changePct - b.changePct)
      .slice(0, limit);

    return {
      gainers: gainers,
      losers: losers,
      totalAnalyzed: validPrices.length,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Error getting top movers:', error.message);
    throw new Error(`Failed to get top movers: ${error.message}`);
  }
}
