#!/usr/bin/env node

/**
 * IndiaQuant MCP Server
 * Production-ready MCP server for Indian stock market intelligence
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Import modules
import { fetchLivePrice } from './modules/marketData.js';
import { fetchNewsSentiment, generateSignal } from './modules/signalGenerator.js';
import {
  fetchOptionsChain,
  calculateGreeks,
  detectUnusualActivity,
  calculateMaxPain,
  trimChainAroundATM
} from './modules/optionsAnalyzer.js';
import {
  placeVirtualTrade,
  getPortfolioPnL
} from './modules/portfolioManager.js';
import { getSectorHeatmap, scanMarket } from './modules/marketScanner.js';
import { warmUp } from './utils/yahooClient.js';
import cache from './utils/cache.js';
import express from "express";

/**
 * MCP Tool Definitions
 */
const TOOLS = [
  {
    name: 'get_live_price',
    description: 'Get real-time stock price data for Indian stocks. Supports NSE/BSE stocks and indices like NIFTY, BANKNIFTY. Returns price, change, volume, 52-week high/low, and market status.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Stock symbol (e.g., RELIANCE, TCS, INFY) or index (NIFTY, BANKNIFTY)',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_options_chain',
    description: 'Fetch options chain with Greeks (Delta, Gamma, Theta, Vega) for calls and puts around the ATM strike. Includes strike prices, open interest, volume, implied volatility, calculated Black-Scholes Greeks, and max pain over the full chain. NSE options require UPSTOX_ACCESS_TOKEN.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Stock symbol (e.g., RELIANCE, NIFTY)',
        },
        expiry: {
          type: 'string',
          description: 'Optional expiry date in YYYY-MM-DD format. If not provided, nearest expiry is used.',
        },
        strike_range: {
          type: 'number',
          description: 'Strikes to return on each side of ATM (default 10). Max pain always uses the full chain.',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'analyze_sentiment',
    description: 'Analyze news sentiment for a stock using NewsAPI. Processes recent headlines and descriptions using keyword analysis to determine bullish/bearish/neutral sentiment with score from -1 to +1.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Stock symbol to analyze sentiment for',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'generate_signal',
    description: 'Generate comprehensive BUY/SELL/HOLD signal by fusing multiple technical indicators (RSI, MACD, Bollinger Bands), chart patterns, and news sentiment. Returns signal with confidence level (0-100) and detailed reasoning.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Stock symbol to analyze',
        },
        timeframe: {
          type: 'string',
          description: 'Analysis timeframe: 1mo, 3mo (default), 6mo, 1y',
          enum: ['1mo', '3mo', '6mo', '1y'],
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_portfolio_pnl',
    description: 'Get complete virtual portfolio summary with P&L for all open positions, unrealized gains/losses, risk score, cash balance, and auto-execution of stop-loss/target orders. Includes position-wise breakdown.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'place_virtual_trade',
    description: 'Execute a virtual trade (paper trading) with automatic position tracking, P&L calculation, and optional stop-loss/target levels. Deducts/credits virtual cash balance. Starting balance: ₹10,00,000.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Stock symbol to trade',
        },
        qty: {
          type: 'number',
          description: 'Quantity of shares',
        },
        side: {
          type: 'string',
          description: 'BUY or SELL',
          enum: ['BUY', 'SELL'],
        },
        stop_loss: {
          type: 'number',
          description: 'Optional stop-loss price',
        },
        target: {
          type: 'number',
          description: 'Optional target price',
        },
      },
      required: ['symbol', 'qty', 'side'],
    },
  },
  {
    name: 'calculate_greeks',
    description: 'Calculate option Greeks (Delta, Gamma, Theta, Vega, Rho) using pure JavaScript Black-Scholes implementation. Requires spot price, strike, expiry date, and volatility.',
    inputSchema: {
      type: 'object',
      properties: {
        spot: {
          type: 'number',
          description: 'Current spot price',
        },
        strike: {
          type: 'number',
          description: 'Strike price',
        },
        expiry_date: {
          type: 'string',
          description: 'Expiry date in YYYY-MM-DD format',
        },
        volatility: {
          type: 'number',
          description: 'Annualized volatility (e.g., 0.25 for 25%)',
        },
        option_type: {
          type: 'string',
          description: 'CE (Call) or PE (Put)',
          enum: ['CE', 'PE', 'call', 'put'],
        },
        risk_free_rate: {
          type: 'number',
          description: 'Risk-free rate (default: 0.065 for 6.5%)',
        },
      },
      required: ['spot', 'strike', 'expiry_date', 'volatility', 'option_type'],
    },
  },
  {
    name: 'detect_unusual_activity',
    description: 'Detect unusual options activity by analyzing volume and open interest patterns. Identifies strikes with volume > 3x average or high volume-to-OI ratio, suggesting institutional activity or large positions.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Stock symbol to analyze',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'scan_market',
    description: 'Scan Nifty 50 stocks based on technical filters. Available filters: oversold (RSI<30), overbought (RSI>70), macd_crossover, near_52w_high, near_52w_low, high_volume, breakout, breakdown.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'Filter type',
          enum: ['oversold', 'overbought', 'macd_crossover', 'near_52w_high', 'near_52w_low', 'high_volume', 'breakout', 'breakdown'],
        },
        value: {
          type: 'number',
          description: 'Optional threshold value (e.g., 30 for oversold RSI threshold)',
        },
      },
      required: ['filter'],
    },
  },
  {
    name: 'get_sector_heatmap',
    description: 'Get performance heatmap of major Indian sectors (IT, Banking, Pharma, Auto, FMCG, Metal, Realty, Energy). Shows % change, market breadth, advance-decline ratio, and identifies top gainer/loser sectors.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

/**
 * Tool execution handler
 */
async function handleToolCall(name, args) {
  try {
    switch (name) {
      case 'get_live_price':
        return await fetchLivePrice(args.symbol);

      case 'get_options_chain': {
        const chainData = await fetchOptionsChain(args.symbol, args.expiry);
        // Max pain needs every strike; the response only carries strikes near ATM
        const maxPain = calculateMaxPain(chainData);
        return { ...trimChainAroundATM(chainData, args.strike_range || 10), maxPain };
      }

      case 'analyze_sentiment':
        return await fetchNewsSentiment(args.symbol);

      case 'generate_signal':
        return await generateSignal(args.symbol, args.timeframe || '3mo');

      case 'get_portfolio_pnl':
        return await getPortfolioPnL();

      case 'place_virtual_trade':
        return await placeVirtualTrade(args);

      case 'calculate_greeks':
        return await calculateGreeks(args);

      case 'detect_unusual_activity':
        return await detectUnusualActivity(args.symbol);

      case 'scan_market':
        return await scanMarket(args.filter, args.value);

      case 'get_sector_heatmap':
        return await getSectorHeatmap();

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    console.error(`Error in tool ${name}:`, error);
    return {
      error: true,
      message: error.message,
      tool: name,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Per-tool latency stats (exposed on /health)
 */
const toolStats = {};
function recordLatency(name, ms, ok) {
  const s = (toolStats[name] ||= { calls: 0, errors: 0, totalMs: 0, maxMs: 0 });
  s.calls++;
  if (!ok) s.errors++;
  s.totalMs += ms;
  s.maxMs = Math.max(s.maxMs, ms);
}

/**
 * Optional HTTP health endpoint (for hosting platforms that require a port).
 * All logging goes to stderr: stdout is reserved for the MCP stdio protocol.
 */
function startHttpServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.get("/", (req, res) => {
    res.send("IndiaQuant MCP Server Running 🚀");
  });

  app.get("/health", (req, res) => {
    const tools = Object.fromEntries(Object.entries(toolStats).map(([name, s]) => [
      name,
      { calls: s.calls, errors: s.errors, avgMs: Math.round(s.totalMs / s.calls), maxMs: s.maxMs },
    ]));
    res.json({ status: "ok", uptimeSec: Math.round(process.uptime()), cache: cache.getStats(), tools });
  });

  const httpServer = app.listen(PORT, () => {
    console.error(`HTTP health server on port ${PORT}`);
  });

  // A busy port (e.g. a second MCP client instance) must not kill the MCP server
  httpServer.on("error", (error) => {
    console.error(`HTTP server disabled (${error.code || error.message}); MCP stdio is unaffected`);
  });
}

/**
 * Main server initialization
 */
async function main() {
  console.error('Starting IndiaQuant MCP Server...');

  const server = new Server(
    {
      name: 'indiaquant-mcp',
      version: '1.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOLS,
    };
  });

  // Register tool execution handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const started = Date.now();
    const result = await handleToolCall(name, args || {});
    const elapsed = Date.now() - started;
    const isError = Boolean(result && result.error === true);

    recordLatency(name, elapsed, !isError);
    console.error(`Tool ${name} ${isError ? 'failed' : 'ok'} in ${elapsed}ms`);

    return {
      content: [
        {
          type: 'text',
          // Compact JSON: pretty-printing adds ~30% tokens to every response
          text: JSON.stringify(result),
        },
      ],
      isError,
    };
  });

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('✓ IndiaQuant MCP Server is running');
  console.error(`✓ All ${TOOLS.length} tools registered and ready`);

  startHttpServer();

  // Pre-establish the Yahoo session in the background so the first tool call is fast
  warmUp();
}

// Error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

// A stray rejected promise (e.g. a timed-out upstream call) should be logged, not crash the server
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

// Start the server
main().catch((error) => {
  console.error('Fatal error starting server:', error);
  process.exit(1);
});
