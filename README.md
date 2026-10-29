# IndiaQuant MCP Server

**Production-ready Model Context Protocol (MCP) server providing Claude Desktop with comprehensive Indian stock market intelligence and virtual trading capabilities using only free APIs.**

[![MCP](https://img.shields.io/badge/MCP-1.0-blue)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Claude Desktop (Client)                      │
└────────────────────────────┬────────────────────────────────────┘
                             │ MCP Protocol (stdio)
┌────────────────────────────▼────────────────────────────────────┐
│                   IndiaQuant MCP Server                          │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  10 MCP Tools: Live Prices • Options • Signals • Portfolio │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────┬───────────┬──────────┬───────────┬────────────────────┘
          │           │          │           │
    ┌─────▼─────┐ ┌──▼────┐ ┌───▼────┐ ┌────▼─────┐
    │ Market    │ │Signal │ │Options │ │Portfolio │
    │ Data      │ │Gen    │ │Analyzer│ │Manager   │
    └─────┬─────┘ └──┬────┘ └───┬────┘ └────┬─────┘
          │          │          │           │
    ┌─────▼──────────▼──────────▼───────────▼─────┐
    │          External Data Sources               │
    │  • Yahoo Finance 2 (prices, OHLC, options)  │
    │  • NewsAPI.org (sentiment - 100/day)        │
    │  • Alpha Vantage (macro data - 25/day)      │
    └──────────────────────────────────────────────┘
          │
    ┌─────▼─────────────────────────────────────────┐
    │  Local Storage                                │
    │  • SQLite (portfolio.db) - Virtual trades     │
    │  • In-memory TTL cache (30s - 30min)         │
    └───────────────────────────────────────────────┘
```

---

## ✨ Features

### 📊 **Market Data**
- Real-time prices for NSE/BSE stocks and indices (NIFTY, BANKNIFTY)
- Historical OHLC data with customizable periods (1d to 5y)
- 52-week high/low, volume, market cap
- Market hours detection with IST timezone support

### 📈 **Technical Analysis**
- **Indicators**: RSI (14), MACD (12/26/9), Bollinger Bands (20,2)
- **Pattern Detection**: Double Top/Bottom, Head & Shoulders
- **Signal Fusion**: Multi-indicator weighted scoring system
- Confidence levels (0-100) with detailed reasoning

### 📰 **Sentiment Analysis**
- NewsAPI integration with keyword-based scoring
- Bullish/bearish classification (-1 to +1 scale)
- Top 3 headlines with source attribution
- 30-minute cache to optimize API usage

### 📉 **Options Analytics**
- Full options chain with CE/PE strikes
- **Pure JS Black-Scholes**: Delta, Gamma, Theta, Vega, Rho
- Max Pain calculation for expiry positioning
- Unusual activity detection (volume > 3x average)
- Implied volatility and put-call ratios

### 💼 **Virtual Portfolio**
- Paper trading with ₹10,00,000 starting capital
- SQLite-based persistent storage
- Automatic stop-loss & target execution
- Position-wise P&L tracking with risk scoring
- Trade history and performance analytics

### 🔍 **Market Scanner**
- Sector heatmap (8 major sectors)
- Technical filters: oversold, overbought, breakouts
- 52-week high/low proximity scanning
- High volume detection
- Nifty 50 constituent screening

---

## 🚀 Quick Start

### Prerequisites
- **Node.js** 18+ 
- **npm** or **yarn**
- **Claude Desktop** app

### 1. Installation

```bash
cd indiaquant-mcp
npm install
```

### 2. Configuration

Create a `.env` file from the template:

```bash
cp .env.example .env
```

All keys are optional. Prices, signals, scanner, heatmap, sentiment (Google News RSS) and the
virtual portfolio work with no keys at all.

```env
# NSE options chain (get_options_chain, detect_unusual_activity)
# Yahoo Finance has no NSE/BSE options data, so these two tools need Upstox (free):
# https://account.upstox.com/developer/apps
UPSTOX_ACCESS_TOKEN=

# Fallback news source only: https://newsapi.org/register
NEWSAPI_KEY=
RISK_FREE_RATE=0.065
```

Requires Node.js 22+. Run `npm run bench` to call every tool through the real MCP stdio
transport and print cold/cached latency.

### 3. Test the Server

```bash
npm start
```

You should see:
```
✓ Database initialized successfully
✓ IndiaQuant MCP Server is running
✓ All 10 tools registered and ready
✓ Yahoo session warmed
```

### 4. Add to Claude Desktop

Edit your Claude Desktop configuration file:

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`  
**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Linux**: `~/.config/Claude/claude_desktop_config.json`

Add this configuration:

```json
{
  "mcpServers": {
    "indiaquant": {
      "command": "node",
      "args": [
        "C:\\Users\\Vaibhav Shivhare\\Desktop\\susbspace\\indiaquant-mcp\\src\\index.js"
      ],
      "env": {
        "UPSTOX_ACCESS_TOKEN": "your_upstox_token_here"
      }
    }
  }
}
```

**Important**: Use absolute path to `index.js` in the `args` field.

### 5. Restart Claude Desktop

Close and reopen Claude Desktop. You should see a 🔌 icon indicating the MCP server is connected.

---

## 🛠️ Available Tools

### 1. `get_live_price`
**Get real-time stock prices**

```json
{
  "symbol": "RELIANCE"
}
```

**Returns**: Price, change %, volume, 52W high/low, market status

**Example**:
```
"What's the current price of TCS?"
"Show me NIFTY 50 with volume data"
```

---

### 2. `get_options_chain`
**Fetch complete options chain with Greeks**

```json
{
  "symbol": "NIFTY",
  "expiry": "2026-03-26"  // Optional
}
```

**Returns**: Call/Put strikes, OI, volume, IV, Delta, Gamma, Theta, Vega, max pain

**Example**:
```
"Get BANKNIFTY options chain for nearest expiry"
"Show me Reliance options with Greeks"
```

---

### 3. `analyze_sentiment`
**Analyze news sentiment for a stock**

```json
{
  "symbol": "INFY"
}
```

**Returns**: Sentiment score (-1 to +1), classification, top 3 headlines

**Example**:
```
"What's the news sentiment for Infosys?"
"Is there positive news about HDFC Bank?"
```

---

### 4. `generate_signal`
**Generate BUY/SELL/HOLD signal with multi-indicator fusion**

```json
{
  "symbol": "TCS",
  "timeframe": "3mo"  // 1mo, 3mo, 6mo, 1y
}
```

**Returns**: Signal, confidence (0-100), indicator breakdown, reasoning

**Weighting**: RSI (25%), MACD (25%), Bollinger (20%), Patterns (15%), Sentiment (15%)

**Example**:
```
"Should I buy or sell Reliance based on technicals?"
"Generate a trading signal for Asian Paints"
```

---

### 5. `get_portfolio_pnl`
**Get virtual portfolio P&L summary**

```json
{}
```

**Returns**: Open positions, unrealized P&L, risk score, cash balance, auto-closed positions

**Example**:
```
"Show my portfolio performance"
"What's my current P&L?"
```

---

### 6. `place_virtual_trade`
**Execute virtual trades (paper trading)**

```json
{
  "symbol": "TCS",
  "qty": 10,
  "side": "BUY",
  "stop_loss": 3900,  // Optional
  "target": 4200      // Optional
}
```

**Returns**: Order confirmation, position ID, updated balance

**Example**:
```
"Buy 50 shares of Infosys with stop loss at 1400"
"Sell 100 shares of HDFC Bank"
```

---

### 7. `calculate_greeks`
**Calculate option Greeks using Black-Scholes**

```json
{
  "spot": 22000,
  "strike": 22500,
  "expiry_date": "2026-03-26",
  "volatility": 0.18,
  "option_type": "CE"
}
```

**Returns**: Delta, Gamma, Theta, Vega, Rho (pure JS implementation)

**Example**:
```
"Calculate Greeks for NIFTY 22500 CE expiring on March 26"
"What's the delta of a 22000 PE with 20% IV?"
```

---

### 8. `detect_unusual_activity`
**Detect unusual options trading activity**

```json
{
  "symbol": "RELIANCE"
}
```

**Returns**: High volume strikes, volume/OI ratios, put-call volume ratio, interpretation

**Example**:
```
"Is there unusual options activity in HDFC Bank?"
"Show me big option trades in NIFTY"
```

---

### 9. `scan_market`
**Scan Nifty 50 with technical filters**

```json
{
  "filter": "oversold",  // oversold, overbought, macd_crossover, near_52w_high, near_52w_low, breakout, breakdown
  "value": 30            // Optional threshold
}
```

**Returns**: Matching stocks with indicator values and reasons

**Example**:
```
"Find oversold stocks in Nifty 50"
"Show me stocks near 52-week high"
"Which stocks had MACD crossover today?"
```

---

### 10. `get_sector_heatmap`
**Get sector performance heatmap**

```json
{}
```

**Returns**: 8 sector indices with % change, top gainer/loser, market breadth

**Sectors**: IT, Banking, Pharma, Auto, FMCG, Metal, Realty, Energy

**Example**:
```
"Which sector is performing best today?"
"Show me the sector heatmap"
```

---

## 🏛️ Design Decisions

### Why Yahoo Finance 2?
- ✅ **Free & reliable** for Indian markets (NSE/BSE)
- ✅ Real-time prices without API keys
- ✅ Historical data up to 5 years
- ✅ Options chain data with OI & IV
- ❌ Rate limits via request throttling (handled internally)

### Why Pure JS Black-Scholes?
- ✅ No external financial libraries (TA-Lib, quantlib)
- ✅ Full control over calculations
- ✅ Educational transparency
- ✅ Cross-platform compatibility
- ✅ Implements Abramowitz & Stegun approximation for normalCDF

### Why SQLite?
- ✅ Zero-config embedded database
- ✅ Persistent virtual portfolio across restarts
- ✅ ACID compliance for trade integrity
- ✅ WAL mode for concurrent reads
- ❌ Single-user constraint (not an issue for personal use)

### Caching Strategy
| Data Type       | TTL     | Rationale                              |
|-----------------|---------|----------------------------------------|
| Live Prices     | 30s     | Balance freshness vs API limits        |
| OHLC Data       | 5 min   | Historical data changes infrequently   |
| Options Chain   | 1 min   | OI/volume updates during market hours  |
| News Sentiment  | 30 min  | Headlines don't change rapidly         |
| Company Info    | 24 hrs  | Static data (sector, industry)         |

---

## ⚠️ Known Limitations

1. **NewsAPI Free Tier**: 100 requests/day (shared across all sentiment queries)
2. **Alpha Vantage**: 25 requests/day (currently unused, reserved for macro data)
3. **Market Hours**: Off-hours data shows last traded price with a note
4. **Yahoo Finance Quirks**: 
   - Some stocks may have delayed data
   - Options chain may not be available for all stocks
   - Rare cases of missing fields (handled gracefully)
5. **Options Greeks**: Calculated with historical volatility if IV unavailable
6. **Pattern Detection**: Simplified algorithms (not as robust as TradingView)
7. **Virtual Trading**: 
   - No brokerage fees/slippage simulation
   - No short selling margin requirements
   - Stop-loss checks on P&L query (not real-time monitoring)

---

## 🧪 Testing

### Manual Testing
```bash
# Start server
npm start

# In another terminal, send MCP request
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node src/index.js
```

### Test Individual Modules
```bash
node
> import { fetchLivePrice } from './src/modules/marketData.js'
> await fetchLivePrice('RELIANCE')
```

---

## 📁 Project Structure

```
indiaquant-mcp/
├── src/
│   ├── index.js              # MCP server entry point (10 tools)
│   ├── config.js             # Configuration & constants
│   ├── modules/
│   │   ├── marketData.js     # Yahoo Finance integration
│   │   ├── signalGenerator.js # Technical indicators & sentiment
│   │   ├── optionsAnalyzer.js # Options chain & Greeks
│   │   ├── portfolioManager.js# SQLite virtual portfolio
│   │   └── marketScanner.js  # Sector scan & filters
│   └── utils/
│       ├── blackScholes.js   # Pure JS Black-Scholes
│       ├── cache.js          # TTL in-memory cache
│       └── symbolMapper.js   # NSE/BSE symbol formatting
├── data/
│   └── portfolio.db          # SQLite database (auto-created)
├── package.json
├── .env.example
└── README.md
```

---

## 🔐 Security

- **API Keys**: Stored in `.env` (never commit to Git)
- **SQL Injection**: Prevented via prepared statements
- **Input Validation**: All tool inputs validated before execution
- **Error Handling**: Errors logged to stderr, never expose internals
- **Rate Limiting**: Request throttling for external APIs

---

## 🤝 Contributing

Contributions welcome! Areas for improvement:

- [ ] Add more chart patterns (triangles, flags, wedges)
- [ ] Implement volume profile analysis
- [ ] Add FII/DII data integration
- [ ] Support for futures analytics
- [ ] Real-time WebSocket price updates
- [ ] Multi-currency support (USD stocks)

---

## 📄 License

MIT License - see LICENSE file for details

---

## 🙏 Acknowledgments

- **MCP Protocol**: Anthropic for the Model Context Protocol standard
- **Yahoo Finance 2**: gadicc for the excellent Node.js library
- **Technical Indicators**: anandanand84 for the technicalindicators package
- **Black-Scholes**: Based on Abramowitz & Stegun (1964) approximations

---

## 📞 Support

For issues or questions:
1. Check the Known Limitations section above
2. Review MCP logs in Claude Desktop dev console (Help → View Logs)
3. Verify API keys in `.env` file
4. Ensure Node.js version is 18+

---

## 🎯 Example Conversation with Claude

```
You: "What's the current price of Reliance Industries?"
Claude: [Uses get_live_price tool]
        RELIANCE is trading at ₹2,847.50 (+1.24%)
        52W High: ₹3,024.90 | 52W Low: ₹2,220.00
        Market is OPEN

You: "Should I buy it? Give me a technical analysis."
Claude: [Uses generate_signal tool]
        Signal: BUY with 72% confidence
        
        Reasoning:
        • RSI at 45.23 (neutral, room to move up)
        • MACD shows bullish crossover
        • Price near lower Bollinger Band (potential bounce)
        • News sentiment: Bullish (0.65)
        • Detected pattern: Double Bottom (bullish reversal)

You: "Okay, buy 50 shares with stop loss at 2800 and target 2950"
Claude: [Uses place_virtual_trade tool]
        ✓ BUY executed: 50 shares of RELIANCE at ₹2,847.50
        Total: ₹1,42,375
        Cash Balance: ₹8,57,625
        Position ID: 1 (with auto SL/target)

You: "Show me the sector heatmap"
Claude: [Uses get_sector_heatmap tool]
        Top Gainer: NIFTY IT (+2.34%)
        Top Loser: NIFTY METAL (-1.87%)
        Market Breadth: 5 gainers, 3 losers (A/D Ratio: 1.67)
```

---

## 🚀 Roadmap

**v1.1** (Planned)
- [ ] Candlestick pattern recognition
- [ ] Fibonacci retracement levels
- [ ] Support/resistance detection

**v1.2** (Future)
- [ ] Multi-timeframe analysis
- [ ] Backtesting engine
- [ ] Portfolio optimization

---

**Built with ❤️ for Indian stock market traders**

*Last Updated: March 2026*
