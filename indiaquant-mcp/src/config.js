import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "..", ".env") });

export const config = {
  // API Keys (all optional - core tools work without any key)
  newsApiKey: process.env.NEWSAPI_KEY || "", // fallback news source
  upstoxAccessToken: process.env.UPSTOX_ACCESS_TOKEN || "", // NSE options chain

  // Trading parameters
  riskFreeRate: parseFloat(process.env.RISK_FREE_RATE || "0.065"),
  initialCashBalance: 1000000, // ₹10 Lakh

  // Upstream request budgets (ms)
  timeouts: {
    yahoo: 4000,
    news: 2500,
    upstox: 5000,
    instrumentMaster: 15000,
  },

  // Max parallel Yahoo requests (library default is 4)
  yahooConcurrency: 10,

  // Cache TTLs in seconds - short while the market is open, long once it is closed
  // (prices cannot change after 15:30 IST, so refetching is wasted latency)
  cacheTTL: {
    livePrice: { open: 15, closed: 600 },
    ohlc: { open: 300, closed: 3600 },
    optionsChain: { open: 60, closed: 900 },
    newsSentiment: { open: 1800, closed: 3600 },
    companyInfo: { open: 86400, closed: 86400 },
    instrumentMaster: { open: 43200, closed: 43200 },
  },

  // Market hours (IST)
  marketHours: {
    start: { hour: 9, minute: 15 },
    end: { hour: 15, minute: 30 },
    timezone: "Asia/Kolkata",
  },

  // Indian market indices
  indices: {
    NIFTY: "^NSEI",
    NIFTY50: "^NSEI",
    BANKNIFTY: "^NSEBANK",
    NIFTYIT: "^CNXIT",
    NIFTYBANK: "^NSEBANK",
    NIFTYPHARMA: "^CNXPHARMA",
    NIFTYAUTO: "^CNXAUTO",
    NIFTYFMCG: "^CNXFMCG",
    NIFTYMETAL: "^CNXMETAL",
    NIFTYREALTY: "^CNXREALTY",
    NIFTYENERGY: "^CNXENERGY",
  },

  // Sector indices for heatmap
  sectorIndices: [
    { name: "NIFTY IT", symbol: "^CNXIT" },
    { name: "NIFTY BANK", symbol: "^NSEBANK" },
    { name: "NIFTY PHARMA", symbol: "^CNXPHARMA" },
    { name: "NIFTY AUTO", symbol: "^CNXAUTO" },
    { name: "NIFTY FMCG", symbol: "^CNXFMCG" },
    { name: "NIFTY METAL", symbol: "^CNXMETAL" },
    { name: "NIFTY REALTY", symbol: "^CNXREALTY" },
    { name: "NIFTY ENERGY", symbol: "^CNXENERGY" },
  ],

  // Nifty 50 constituents (sample - extend as needed)
  nifty50Stocks: [
    "RELIANCE",
    "TCS",
    "HDFCBANK",
    "INFY",
    "ICICIBANK",
    "HINDUNILVR",
    "ITC",
    "SBIN",
    "BHARTIARTL",
    "BAJFINANCE",
    "KOTAKBANK",
    "LT",
    "ASIANPAINT",
    "AXISBANK",
    "MARUTI",
    "HCLTECH",
    "WIPRO",
    "SUNPHARMA",
    "TITAN",
    "ULTRACEMCO",
    "NESTLEIND",
    "TATASTEEL",
    "BAJAJFINSV",
    "POWERGRID",
    "NTPC",
    "M&M",
    "TECHM",
    "ONGC",
    "TMPV", // Tata Motors PV - TATAMOTORS was demerged and now returns 404
    "ADANIPORTS",
    "COALINDIA",
    "INDUSINDBK",
    "DRREDDY",
    "GRASIM",
    "JSWSTEEL",
    "HINDALCO",
    "BPCL",
    "EICHERMOT",
    "DIVISLAB",
    "CIPLA",
    "HEROMOTOCO",
    "SBILIFE",
    "BAJAJ-AUTO",
    "TATACONSUM",
    "BRITANNIA",
    "APOLLOHOSP",
    "ADANIENT",
    "HDFCLIFE",
    "LTM", // LTIMindtree - renamed from LTIM
    "SHRIRAMFIN",
  ],

  // Database path
  dbPath: process.env.DB_PATH || join(__dirname, "..", "data", "portfolio.db"),
};

// Sentiment keywords
export const sentimentKeywords = {
  bullish: [
    "rally",
    "surge",
    "gain",
    "rise",
    "up",
    "high",
    "growth",
    "profit",
    "positive",
    "bullish",
    "strong",
    "outperform",
    "buy",
    "upgrade",
    "beat",
    "exceed",
    "record",
    "milestone",
    "expansion",
    "breakthrough",
  ],
  bearish: [
    "fall",
    "drop",
    "decline",
    "crash",
    "plunge",
    "down",
    "loss",
    "negative",
    "bearish",
    "weak",
    "underperform",
    "sell",
    "downgrade",
    "miss",
    "concern",
    "risk",
    "warning",
    "cut",
    "layoff",
    "investigation",
  ],
};
