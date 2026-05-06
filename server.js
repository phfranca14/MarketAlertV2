
server
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS) || 30000;

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID   || '';

async function sendTelegram(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try { await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' }); } catch (e) {}
}

const state = { checks: 0, sales: [], seenIds: new Set(), logs: [], lastCheck: null };

function addLog(msg) {
  const entry = { ts: new Date().toISOString(), msg };
  state.logs.unshift(entry);
  if (state.logs.length > 100) state.logs.pop();
  console.log(`[${entry.ts}] ${msg}`);
}

function addSale(sale) {
  if (state.seenIds.has(sale.id)) return false;
  state.seenIds.add(sale.id);
  state.sales.unshift(sale);
  if (state.sales.length > 50) state.sales.pop();
  addLog(`VENDA REAL: ${sale.market} | ${sale.item} | R$ ${sale.price}`);
  sendTelegram(`🔔 Nova venda!\n📦 ${sale.item}\n💰 R$ ${sale.price}\n🛒 ${sale.market}`);
  return true;
}

// ===================== MERCADO LIVRE =====================
const ML_CLIENT_ID     = process.env.ML_CLIENT_ID     || '';
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || '';
const ML_REDIRECT_URI  = process.env.ML_REDIRECT_URI  || '';
let mlToken        = process.env.ML_ACCESS_TOKEN  || '';
let mlRefreshToken = process.env.ML_REFRESH_TOKEN || '';

// Rota 1: Redireciona para login do ML
app.get('/ml/auth', (req, res) => {
  if (!ML_CLIENT_ID) return res.send('Erro: ML_CLIENT_ID nao configurado no Render.');
  const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${ML_CLIENT_ID}&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}`;
  res.redirect(url);
})