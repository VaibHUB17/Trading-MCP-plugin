# IndiaQuant MCP – Testing Guide

How to check that every tool works, what each one should return, and how long it should take.

> **About the numbers below:** sample values come from the test run on **30 Oct 2026** (market closed,
> last close of 29 Oct). Prices change every day, so check the *shape* of each result
> (fields present, no errors, sensible values) rather than exact numbers.

---

## 1. Automated check (run this first)

```bash
cd indiaquant-mcp
npm run bench
```

This starts the real server over MCP stdio, calls every tool twice (first call = live API, second = cache)
and prints a table. It uses a throwaway database, so your virtual portfolio is not touched.

**Expected result (30 Oct 2026 run):**

| Tool | First call | Cached | Sample result |
|---|---|---|---|
| get_live_price RELIANCE | 80–1100 ms | 1–2 ms | 1167.4 (0.81%) via yahoo-quote |
| get_live_price NIFTY | ~80 ms | 1–2 ms | 22936.75 (1.05%) |
| analyze_sentiment TCS | 0.7–1.1 s | 2 ms | neutral 0.00 from 15 articles (google-news) |
| generate_signal INFY 3mo | ~0.7 s | 2–5 ms | HOLD @ 50% RSI=55.1 |
| generate_signal HDFCBANK 1mo | ~0.7 s | 2 ms | HOLD @ 50% RSI=39.2 |
| get_sector_heatmap | ~0.16 s | 1 ms | top=NIFTY REALTY 2.75% errors=0 |
| scan_market oversold (RSI<40) | 1.0–1.2 s | 3–4 ms | 18 matches, failed=[] |
| scan_market near_52w_high (10%) | ~1 ms* | 2–3 ms | 9 matches, failed=[] |
| calculate_greeks | <5 ms | <5 ms | delta=0.477 |
| get_options_chain NIFTY | — | — | needs Upstox token (see section 4) |
| detect_unusual_activity NIFTY | — | — | needs Upstox token |
| place_virtual_trade | <10 ms | — | BUY order executed: 10 shares of SBIN |
| get_portfolio_pnl | <5 ms | 1–2 ms | positions=1 value=1000000 |

\* Fast because the quotes were already cached by the previous scan.

**Something is wrong if:** a first call takes more than ~3 s, `failed=[...]` lists symbols,
`get_sector_heatmap` shows `errors` greater than 0, or a row shows `✗ ERROR` (other than the two options tools while there's no Upstox token).

---

## 2. Manual test prompts for Claude Desktop

Claude adds its own thinking time, so expect **3–10 s per reply** on top of the tool time.
The first time Claude uses a tool it asks for permission: click **Allow**.
When the market is closed (before 9:15 or after 15:30 IST, and on weekends) results include
*"Market is closed. Showing last traded price."* This is expected.

### Market data

| # | Prompt | Expected output | Tool time |
|---|---|---|---|
| 1 | `Use indiaquant to get the live price of RELIANCE and NIFTY.` | Price, change, %change, day high/low, volume, 52-week high/low. Sample: RELIANCE ₹1,167.40 (+0.81%), NIFTY 22,936.75 (+1.05%) | 0.1–0.7 s (first call after start ~1 s) |
| 2 | `Show me the Indian sector heatmap. Which sector is leading and which is lagging?` | 8 sectors (IT, Bank, Pharma, Auto, FMCG, Metal, Realty, Energy) sorted by %change, gainers/losers count, NIFTY as context. Sample top gainer: NIFTY REALTY +2.75% | 0.15–0.3 s |

### Analysis

| # | Prompt | Expected output | Tool time |
|---|---|---|---|
| 3 | `Analyze the news sentiment for TCS.` | bullish/bearish/neutral, score from -1 to +1, ~15 articles from Google News, top 5 headlines with links | 0.7–1.2 s |
| 4 | `Generate a trading signal for INFY on the 3 month timeframe and explain the reasoning.` | BUY/SELL/HOLD + confidence %, RSI, MACD, Bollinger Bands, patterns, sentiment, list of reasons. Sample: HOLD @ 50%, RSI ≈ 55.1 | ~0.7 s |
| 5 | `Generate a signal for HDFCBANK on 1mo.` | Works (used to error before the fix). Sample: HOLD, RSI ≈ 39.2 | ~0.7 s |
| 6 | `Scan the Nifty 50 for oversold stocks with RSI below 40.` | List sorted from lowest RSI, each with price, RSI and reason; `failed` empty. Sample: 18 matches | 1–1.2 s for all 50 stocks |
| 7 | `Which Nifty 50 stocks are within 10% of their 52-week high?` | List with distance from the high. Sample: 9 matches | 0.1–1 s |

Other scan filters to try: `overbought`, `macd_crossover`, `high_volume`, `breakout`, `breakdown`, `near_52w_low`.

### Options

| # | Prompt | Expected output | Tool time |
|---|---|---|---|
| 8 | `Calculate the Greeks for a NIFTY 24200 call, spot 24000, expiry 2026-11-24, volatility 14%.` | delta ≈ 0.48, plus gamma, theta (per day), vega, rho. Works without Upstox. Use a future expiry date | < 5 ms |
| 9 | `Get the NIFTY options chain with max pain.` | **Without Upstox token:** clear error "Yahoo Finance does not carry NSE/BSE options – set UPSTOX_ACCESS_TOKEN". **With token:** ~21 strikes around the current price with Greeks/OI/volume, max pain, put-call ratio, top OI strikes, available expiries | First call of the day 1–1.5 s, then 0.3–0.6 s |
| 10 | `Detect unusual options activity in NIFTY.` | Same token requirement. With token: strikes with unusual volume, put/call volume ratio, interpretation | Same as above |

### Virtual portfolio (paper trading, starts with ₹10,00,000)

| # | Prompt | Expected output | Tool time |
|---|---|---|---|
| 11 | `Buy 10 shares of SBIN with a stop loss of 940 and a target of 1050.` | "BUY order executed: 10 shares of SBIN at ₹…", trade value, new cash balance (sample: ₹971.90 → value ≈ ₹9,719, cash ≈ ₹9,90,281) | < 10 ms |
| 12 | `Show my portfolio P&L.` | Open positions, unrealised P&L (₹0 while market is closed), total value ≈ ₹10,00,000, risk level (HIGH with a single stock) | 5–200 ms |

Trades are saved in `indiaquant-mcp/data/portfolio.db`. Delete that file to reset to ₹10 lakh.

### One prompt that uses several tools

```
Check NIFTY's price, show the sector heatmap, find oversold Nifty 50 stocks,
and give me a trading signal for the most oversold one.
```

Expected: Claude calls 4 tools one after another and gives a combined answer.
Total about **15–30 s**, mostly Claude's own thinking; the tools themselves take about 3 s.

---

## 3. Health and latency monitor

While Claude Desktop is open, visit **http://localhost:3917/health**. It shows:

- `cache` – entries, hits, misses, `hitRate` (it should rise as you repeat questions)
- `tools` – calls, errors, `avgMs` and `maxMs` for each tool

A reply that feels slow while `avgMs` is low means the time is Claude's thinking, not the server.

---

## 4. Daily Upstox token (options tools only)

The Upstox token expires every day around **3:30 AM IST**. Once your Upstox account is approved:

```bash
cd indiaquant-mcp
npm run upstox-login
```

Log in to Upstox in the browser that opens until the page says **"Upstox token saved to .env"**, then fully restart Claude Desktop.

| Error | Meaning / fix |
|---|---|
| `No segments for these users are active` | Upstox account not approved yet, or Equity segment inactive. Wait for approval, or activate it in the Upstox app under Profile → Segments |
| `Upstox access token is invalid or expired` | Run `npm run upstox-login` again |
| `Invalid expiry …. Available: …` | Use one of the listed expiry dates (YYYY-MM-DD) |
| `… has no NSE options (not an F&O underlying)` | That stock has no options on NSE |

---

## 5. Troubleshooting Claude Desktop

| Symptom | Fix |
|---|---|
| Settings → Developer shows "No servers added" | Fully quit Claude Desktop (taskbar tray → right-click Claude → Quit) and reopen. Closing the window with ✕ is not enough |
| Server shows "failed" | Run `npm start` in `indiaquant-mcp` and read the error. Logs are in `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\logs` |
| Tools missing from a chat | In the message box, open the tools/sliders menu and turn **indiaquant** on |
| Prices look old | Normal when the market is closed. During market hours prices refresh every 15 s |
| News sentiment always neutral with an `error` field | Internet or Google News issue. NewsAPI is used as a backup if `NEWSAPI_KEY` is set |

**Claude Desktop config** (Microsoft Store build):
`%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`

```json
"mcpServers": {
  "indiaquant": {
    "command": "C:/Program Files/nodejs/node.exe",
    "args": ["C:/Users/A/Desktop/Trading-MCP-plugin/indiaquant-mcp/src/index.js"],
    "env": { "PORT": "3917" }
  }
}
```

---

## 6. Cache times (why repeat questions are instant)

| Data | Market open | Market closed |
|---|---|---|
| Live price | 15 s | 10 min |
| Price history (OHLC) | 5 min | 1 h |
| Options chain | 1 min | 15 min |
| News sentiment | 30 min | 1 h |
| Upstox instrument list | 12 h | 12 h |

If an upstream API fails, the last good value is served (for up to 1 hour) instead of an error.
