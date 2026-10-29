/**
 * Portfolio Manager Module
 * Virtual trading portfolio with SQLite persistence, P&L tracking, and risk management
 */

import initSqlJs from 'sql.js';
import { dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { fetchLivePrice } from './marketData.js';
import { config } from '../config.js';

// Initialize database
let db;
let SQL;

/**
 * Lightweight wrapper to make sql.js work like better-sqlite3
 */
class DatabaseWrapper {
  constructor(sqlDb) {
    this.db = sqlDb;
  }

  prepare(sql) {
    const self = this;
    return {
      run(...params) {
        self.db.run(sql, params);
        const lastId = self.db.exec("SELECT last_insert_rowid() as id")[0]?.values[0]?.[0];
        return { lastInsertRowid: lastId };
      },
      get(...params) {
        const result = self.db.exec(sql, params);
        if (result.length === 0) return undefined;
        const row = result[0];
        if (row.values.length === 0) return undefined;
        const obj = {};
        row.columns.forEach((col, idx) => {
          obj[col] = row.values[0][idx];
        });
        return obj;
      },
      all(...params) {
        const result = self.db.exec(sql, params);
        if (result.length === 0) return [];
        const row = result[0];
        return row.values.map(values => {
          const obj = {};
          row.columns.forEach((col, idx) => {
            obj[col] = values[idx];
          });
          return obj;
        });
      }
    };
  }

  exec(sql) {
    this.db.exec(sql);
  }

  export() {
    return this.db.export();
  }
}

/**
 * Initialize SQLite database (memoized: concurrent callers share one init)
 */
let initPromise = null;
export function initializeDatabase() {
  if (!initPromise) {
    initPromise = openDatabase().catch((error) => {
      initPromise = null; // allow retry
      throw error;
    });
  }
  return initPromise;
}

async function openDatabase() {
  try {
    // Ensure data directory exists
    const dataDir = dirname(config.dbPath);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    // Initialize sql.js
    if (!SQL) {
      SQL = await initSqlJs();
    }

    // Load existing database or create new one
    let sqlDb;
    if (existsSync(config.dbPath)) {
      const buffer = readFileSync(config.dbPath);
      sqlDb = new SQL.Database(buffer);
    } else {
      sqlDb = new SQL.Database();
    }

    db = new DatabaseWrapper(sqlDb);

    // Create tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        qty INTEGER NOT NULL,
        avg_price REAL NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
        stop_loss REAL,
        target REAL,
        status TEXT DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'CLOSED')),
        entry_timestamp TEXT NOT NULL,
        exit_timestamp TEXT,
        exit_price REAL,
        pnl REAL,
        pnl_pct REAL
      );

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER,
        symbol TEXT NOT NULL,
        qty INTEGER NOT NULL,
        price REAL NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
        trade_type TEXT NOT NULL CHECK(trade_type IN ('ENTRY', 'EXIT', 'STOPLOSS', 'TARGET')),
        timestamp TEXT NOT NULL,
        FOREIGN KEY (position_id) REFERENCES positions(id)
      );

      CREATE TABLE IF NOT EXISTS cash_balance (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        balance REAL NOT NULL,
        last_updated TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol);
      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
    `);

    // Initialize cash balance if not exists
    const balanceRow = db.prepare('SELECT balance FROM cash_balance WHERE id = 1').get();
    if (!balanceRow) {
      db.prepare('INSERT INTO cash_balance (id, balance, last_updated) VALUES (1, ?, ?)').run(
        config.initialCashBalance,
        new Date().toISOString()
      );
      // Save after initialization
      saveDatabase();
    }

    console.error('✓ Database initialized successfully');
    return db;
  } catch (error) {
    console.error('Error initializing database:', error.message);
    throw error;
  }
}

/**
 * Save database to disk
 */
function saveDatabase() {
  if (db && db.db) {
    try {
      const data = db.export();
      writeFileSync(config.dbPath, data);
    } catch (error) {
      console.error('Error saving database:', error.message);
    }
  }
}

/**
 * Get current cash balance
 */
export async function getCashBalance() {
  if (!db) await initializeDatabase();
  
  const row = db.prepare('SELECT balance, last_updated FROM cash_balance WHERE id = 1').get();
  return {
    balance: row.balance,
    lastUpdated: row.last_updated,
    currency: 'INR',
  };
}

/**
 * Update cash balance
 */
async function updateCashBalance(newBalance) {
  if (!db) await initializeDatabase();
  
  db.prepare('UPDATE cash_balance SET balance = ?, last_updated = ? WHERE id = 1').run(
    newBalance,
    new Date().toISOString()
  );
  saveDatabase();
}

/**
 * Place a virtual trade
 * @param {Object} params - Trade parameters
 * @returns {Object} Trade confirmation
 */
export async function placeVirtualTrade(params) {
  if (!db) await initializeDatabase();
  
  try {
    const { symbol, qty, side, stop_loss = null, target = null } = params;

    // Validate inputs
    if (!symbol || !qty || !side) {
      throw new Error('Missing required parameters: symbol, qty, side');
    }

    if (!Number.isInteger(qty) || qty <= 0) {
      throw new Error('Quantity must be a positive whole number');
    }

    if (!['BUY', 'SELL'].includes(side.toUpperCase())) {
      throw new Error('Side must be BUY or SELL');
    }

    // Fetch current price
    const priceData = await fetchLivePrice(symbol);
    const currentPrice = priceData.price;

    if (!currentPrice || currentPrice <= 0) {
      throw new Error(`Invalid price for ${symbol}`);
    }

    // Calculate trade value
    const tradeValue = currentPrice * qty;
    const cashBalance = await getCashBalance();

    // Check if sufficient balance for BUY
    if (side.toUpperCase() === 'BUY' && tradeValue > cashBalance.balance) {
      throw new Error(`Insufficient balance. Required: ₹${tradeValue.toFixed(2)}, Available: ₹${cashBalance.balance.toFixed(2)}`);
    }

    // Begin transaction
    const insertPosition = db.prepare(`
      INSERT INTO positions (symbol, qty, avg_price, side, stop_loss, target, entry_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertTrade = db.prepare(`
      INSERT INTO trades (position_id, symbol, qty, price, side, trade_type, timestamp)
      VALUES (?, ?, ?, ?, ?, 'ENTRY', ?)
    `);

    const timestamp = new Date().toISOString();
    
    const insertResult = insertPosition.run(
      symbol,
      qty,
      currentPrice,
      side.toUpperCase(),
      stop_loss,
      target,
      timestamp
    );

    const positionId = insertResult.lastInsertRowid;

    insertTrade.run(
      positionId,
      symbol,
      qty,
      currentPrice,
      side.toUpperCase(),
      timestamp
    );

    // Update cash balance
    let newBalance;
    if (side.toUpperCase() === 'BUY') {
      newBalance = cashBalance.balance - tradeValue;
    } else {
      newBalance = cashBalance.balance + tradeValue;
    }
    await updateCashBalance(newBalance);

    return {
      success: true,
      positionId: positionId,
      symbol: symbol,
      qty: qty,
      side: side.toUpperCase(),
      entryPrice: currentPrice,
      tradeValue: tradeValue,
      stopLoss: stop_loss,
      target: target,
      cashBalance: newBalance,
      timestamp: timestamp,
      message: `${side.toUpperCase()} order executed: ${qty} shares of ${symbol} at ₹${currentPrice.toFixed(2)}`
    };
  } catch (error) {
    console.error('Error placing virtual trade:', error.message);
    throw new Error(`Failed to place trade: ${error.message}`);
  }
}

/**
 * Get portfolio P&L and positions
 * @returns {Promise<Object>} Portfolio summary with P&L
 */
export async function getPortfolioPnL() {
  if (!db) await initializeDatabase();
  
  try {
    // Get all open positions
    const positions = db.prepare('SELECT * FROM positions WHERE status = ?').all('OPEN');
    
    if (positions.length === 0) {
      const cashBalance = await getCashBalance();
      return {
        openPositions: [],
        totalPositions: 0,
        totalInvestment: 0,
        currentValue: 0,
        unrealizedPnL: 0,
        unrealizedPnLPct: 0,
        cashBalance: cashBalance.balance,
        totalPortfolioValue: cashBalance.balance,
        riskScore: 0,
        timestamp: new Date().toISOString(),
      };
    }

    // Fetch current prices for all positions (one batched request via quoteCombine).
    // A failed lookup marks that position stale instead of failing the whole portfolio.
    const priceResults = await Promise.allSettled(positions.map(pos => fetchLivePrice(pos.symbol)));

    // Calculate P&L for each position and check stop loss / target
    const positionDetails = [];
    let totalInvestment = 0;
    let currentValue = 0; // net market value: longs minus shorts
    let totalUnrealizedPnL = 0;

    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      const priceOk = priceResults[i].status === 'fulfilled';
      const currentPrice = priceOk ? priceResults[i].value.price : pos.avg_price;

      const investment = pos.avg_price * pos.qty;
      const value = currentPrice * pos.qty;
      const pnl = pos.side === 'BUY' ? (value - investment) : (investment - value);
      const pnlPct = (pnl / investment) * 100;

      // Check if stop loss or target hit
      let shouldClose = false;
      let closeReason = null;

      if (pos.side === 'BUY') {
        if (pos.stop_loss && currentPrice <= pos.stop_loss) {
          shouldClose = true;
          closeReason = 'STOPLOSS';
        } else if (pos.target && currentPrice >= pos.target) {
          shouldClose = true;
          closeReason = 'TARGET';
        }
      } else {
        // SELL position
        if (pos.stop_loss && currentPrice >= pos.stop_loss) {
          shouldClose = true;
          closeReason = 'STOPLOSS';
        } else if (pos.target && currentPrice <= pos.target) {
          shouldClose = true;
          closeReason = 'TARGET';
        }
      }

      // Never auto-close on a stale (fallback) price
      if (!priceOk) {
        shouldClose = false;
        closeReason = null;
      }

      // Auto-close position if stop loss or target hit. Its proceeds move into
      // cash, so it must not also be counted in the open totals below.
      if (shouldClose) {
        await closePosition(pos.id, currentPrice, closeReason);
      } else {
        totalInvestment += investment;
        currentValue += pos.side === 'BUY' ? value : -value;
        totalUnrealizedPnL += pnl;
      }

      positionDetails.push({
        positionId: pos.id,
        symbol: pos.symbol,
        qty: pos.qty,
        side: pos.side,
        avgPrice: pos.avg_price,
        currentPrice: currentPrice,
        investment: investment,
        currentValue: value,
        unrealizedPnL: pnl,
        unrealizedPnLPct: pnlPct,
        stopLoss: pos.stop_loss,
        target: pos.target,
        entryDate: pos.entry_timestamp,
        daysHeld: Math.floor((Date.now() - new Date(pos.entry_timestamp)) / (1000 * 60 * 60 * 24)),
        status: shouldClose ? 'CLOSED' : 'OPEN',
        closeReason: closeReason,
        ...(priceOk ? {} : { priceError: priceResults[i].reason.message }),
      });
    }

    // Calculate risk score based on concentration of the positions still open
    const openPositions = positionDetails.filter(p => p.status === 'OPEN');
    const maxPosition = openPositions.length > 0 ? Math.max(...openPositions.map(p => p.investment)) : 0;
    const concentration = totalInvestment > 0 ? (maxPosition / totalInvestment) * 100 : 0;

    // Risk score: 0-100 (higher = riskier)
    // Based on concentration and number of positions
    const diversificationScore = openPositions.length > 0 ? Math.max(0, 100 - (openPositions.length * 10)) : 0;
    const concentrationScore = concentration;
    const riskScore = Math.min(100, (diversificationScore + concentrationScore) / 2);

    const cashBalance = await getCashBalance();
    const totalPortfolioValue = cashBalance.balance + currentValue;

    return {
      openPositions: openPositions,
      closedPositions: positionDetails.filter(p => p.status === 'CLOSED'),
      totalPositions: openPositions.length,
      totalInvestment: totalInvestment,
      currentValue: currentValue,
      unrealizedPnL: totalUnrealizedPnL,
      unrealizedPnLPct: totalInvestment > 0 ? (totalUnrealizedPnL / totalInvestment) * 100 : 0,
      cashBalance: cashBalance.balance,
      totalPortfolioValue: totalPortfolioValue,
      riskScore: riskScore,
      riskLevel: riskScore < 30 ? 'LOW' : riskScore < 60 ? 'MEDIUM' : 'HIGH',
      concentration: concentration.toFixed(2),
      diversification: openPositions.length >= 5 ? 'GOOD' : openPositions.length >= 3 ? 'MODERATE' : 'POOR',
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Error getting portfolio P&L:', error.message);
    throw new Error(`Failed to get portfolio P&L: ${error.message}`);
  }
}

/**
 * Close a position
 * @param {number} positionId - Position ID
 * @param {number} exitPrice - Exit price
 * @param {string} tradeType - Trade type (EXIT, STOPLOSS, TARGET)
 */
async function closePosition(positionId, exitPrice, tradeType = 'EXIT') {
  if (!db) await initializeDatabase();
  
  try {
    // Get position details
    const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId);
    
    if (!position) {
      throw new Error(`Position ${positionId} not found`);
    }

    if (position.status === 'CLOSED') {
      throw new Error(`Position ${positionId} is already closed`);
    }

    // Calculate P&L
    const investment = position.avg_price * position.qty;
    const exitValue = exitPrice * position.qty;
    const pnl = position.side === 'BUY' ? (exitValue - investment) : (investment - exitValue);
    const pnlPct = (pnl / investment) * 100;

    // Update position
    db.prepare(`
      UPDATE positions 
      SET status = 'CLOSED', 
          exit_timestamp = ?, 
          exit_price = ?,
          pnl = ?,
          pnl_pct = ?
      WHERE id = ?
    `).run(new Date().toISOString(), exitPrice, pnl, pnlPct, positionId);

    // Record trade
    db.prepare(`
      INSERT INTO trades (position_id, symbol, qty, price, side, trade_type, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      positionId,
      position.symbol,
      position.qty,
      exitPrice,
      position.side === 'BUY' ? 'SELL' : 'BUY',
      tradeType,
      new Date().toISOString()
    );

    // Update cash balance
    const cashBalance = await getCashBalance();
    const newBalance = position.side === 'BUY' 
      ? cashBalance.balance + exitValue 
      : cashBalance.balance - exitValue;
    await updateCashBalance(newBalance);

    console.error(`✓ Position ${positionId} closed with P&L: ₹${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`);
  } catch (error) {
    console.error('Error closing position:', error.message);
    throw error;
  }
}

/**
 * Get trade history
 * @param {number} limit - Number of recent trades to fetch
 * @returns {Array} Trade history
 */
export async function getTradeHistory(limit = 50) {
  if (!db) await initializeDatabase();
  
  const trades = db.prepare(`
    SELECT t.*, p.pnl, p.pnl_pct
    FROM trades t
    LEFT JOIN positions p ON t.position_id = p.id
    ORDER BY t.timestamp DESC
    LIMIT ?
  `).all(limit);

  return trades;
}

/**
 * Get closed positions summary
 * @returns {Object} Summary of closed positions
 */
export async function getClosedPositionsSummary() {
  if (!db) await initializeDatabase();
  
  const closedPositions = db.prepare('SELECT * FROM positions WHERE status = ?').all('CLOSED');
  
  if (closedPositions.length === 0) {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalPnL: 0,
      avgPnL: 0,
      maxGain: 0,
      maxLoss: 0,
    };
  }

  const totalPnL = closedPositions.reduce((sum, pos) => sum + pos.pnl, 0);
  const winningTrades = closedPositions.filter(pos => pos.pnl > 0).length;
  const losingTrades = closedPositions.filter(pos => pos.pnl < 0).length;
  const maxGain = Math.max(...closedPositions.map(pos => pos.pnl));
  const maxLoss = Math.min(...closedPositions.map(pos => pos.pnl));

  return {
    totalTrades: closedPositions.length,
    winningTrades: winningTrades,
    losingTrades: losingTrades,
    winRate: (winningTrades / closedPositions.length * 100).toFixed(2),
    totalPnL: totalPnL,
    avgPnL: totalPnL / closedPositions.length,
    maxGain: maxGain,
    maxLoss: maxLoss,
  };
}

// Initialize database on module load
initializeDatabase().catch(err => console.error('Failed to initialize database:', err));
