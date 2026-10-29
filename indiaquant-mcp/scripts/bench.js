#!/usr/bin/env node
/**
 * End-to-end latency benchmark.
 * Spawns the real MCP server over stdio (so any stray stdout output breaks the run),
 * calls every tool twice (cold = upstream, warm = cache) and prints a latency table.
 * Uses a throwaway portfolio DB so your real virtual portfolio is untouched.
 *
 *   npm run bench
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const expiry = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

const CALLS = [
  ['get_live_price', { symbol: 'RELIANCE' }],
  ['get_live_price', { symbol: 'NIFTY' }],
  ['analyze_sentiment', { symbol: 'TCS' }],
  ['generate_signal', { symbol: 'INFY', timeframe: '3mo' }],
  ['generate_signal', { symbol: 'HDFCBANK', timeframe: '1mo' }],
  ['get_sector_heatmap', {}],
  ['scan_market', { filter: 'oversold', value: 40 }],
  ['scan_market', { filter: 'near_52w_high', value: 10 }],
  ['calculate_greeks', { spot: 24000, strike: 24200, expiry_date: expiry, volatility: 0.14, option_type: 'CE' }],
  ['get_options_chain', { symbol: 'NIFTY' }],
  ['detect_unusual_activity', { symbol: 'NIFTY' }],
  ['place_virtual_trade', { symbol: 'SBIN', qty: 10, side: 'BUY', stop_loss: 1, target: 100000 }],
  ['get_portfolio_pnl', {}],
];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'src', 'index.js')],
  env: { ...process.env, PORT: '0', DB_PATH: join(tmpdir(), `indiaquant-bench-${Date.now()}.db`) },
  stderr: 'ignore',
});
const client = new Client({ name: 'bench', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`Connected: ${tools.length} tools\n`);

async function call(name, args) {
  const started = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const ms = Date.now() - started;
  const text = res.content?.[0]?.text || '';
  let body;
  try { body = JSON.parse(text); } catch { body = { message: text }; }
  return { ms, ok: !res.isError, body, bytes: text.length };
}

function summarize(name, body) {
  switch (name) {
    case 'get_live_price': return `${body.price} (${body.changePct?.toFixed?.(2)}%) via ${body.source}`;
    case 'analyze_sentiment': return `${body.sentiment} ${body.score?.toFixed?.(2)} from ${body.articlesAnalyzed} articles (${body.source})`;
    case 'generate_signal': return `${body.signal} @ ${body.confidence}% RSI=${body.indicators?.rsi?.value?.toFixed?.(1)}`;
    case 'get_sector_heatmap': return `top=${body.topGainer?.name} ${body.topGainer?.changePct?.toFixed?.(2)}% errors=${body.sectors?.filter(s => s.error).length}`;
    case 'scan_market': return `${body.matchesFound} matches, failed=[${body.failed}]`;
    case 'calculate_greeks': return `delta=${body.greeks?.delta?.toFixed?.(3)}`;
    case 'get_options_chain': return `${body.source} exp=${body.expiryDate} strikes=${body.calls?.length} maxPain=${body.maxPain?.maxPainStrike}`;
    case 'place_virtual_trade': return body.message;
    case 'get_portfolio_pnl': return `positions=${body.totalPositions} value=${body.totalPortfolioValue?.toFixed?.(0)}`;
    default: return '';
  }
}

const rows = [];
for (const [name, args] of CALLS) {
  const cold = await call(name, args);
  const warm = name === 'place_virtual_trade' ? null : await call(name, args);
  const detail = cold.ok ? summarize(name, cold.body) : `ERROR: ${cold.body.message}`;
  rows.push({ tool: `${name} ${JSON.stringify(args).slice(0, 40)}`, cold: cold.ms, warm: warm?.ms ?? '-', kb: (cold.bytes / 1024).toFixed(1), ok: cold.ok, detail });
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`${pad('tool / args', 62)} ${pad('cold ms', 8)} ${pad('warm ms', 8)} ${pad('KB', 6)} result`);
for (const r of rows) {
  console.log(`${pad(r.tool, 62)} ${pad(r.cold, 8)} ${pad(r.warm, 8)} ${pad(r.kb, 6)} ${r.ok ? '' : '✗ '}${r.detail.slice(0, 110)}`);
}

await client.close();
