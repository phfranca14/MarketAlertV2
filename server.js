import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(STATE_FILE)) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    stats: { checks: 0, sales: 0 },
    recentSales: [],
    connectors: {},
    lastSeen: {},
    logs: []
  }, null, 2));
}

const readState = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
const writeState = (state) => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const pushLog = (state, title, body) => {
  state.logs.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), title, body });
  state.logs = state.logs.slice(0, 50);
};
const pushSale = (state, sale) => {
  state.recentSales.unshift(sale);
  state.recentSales = state.recentSales.slice(0, 30);
  state.stats.sales += 1;
};

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  return response.ok;
}

async function detectMercadoLivreWebhook(payload) {
  if (!payload || !payload.resource) return null;
  return {
    id: payload._id || crypto.randomUUID(),
    market: 'Mercado Livre',
    item: payload.resource,
    price: 'consultar_api',
    detectedAt: new Date().toISOString(),
    source: 'webhook'
  };
}

async function fakeConnectorCheck(name) {
  const chance = Math.random();
  if (chance < 0.86) return null;
  return {
    id: crypto.randomUUID(),
    market: name,
    item: 'Produto detectado',
    price: ['29,90', '79,90', '119,00', '149,90'][Math.floor(Math.random() * 4)],
    detectedAt: new Date().toISOString(),
    source: 'polling'
  };
}

async function runChecks(channel = 'both') {
  const state = readState();
  state.stats.checks += 1;
  const markets = ['dfg.com.br', 'ggmax.com.br', 'gamemarket.com.br', 'desapegogames.com.br'];
  const found = [];
  for (const market of markets) {
    const sale = await fakeConnectorCheck(market);
    if (sale) {
      pushSale(state, sale);
      found.push(sale);
      pushLog(state, 'Nova venda', `${sale.market} vendeu ${sale.item} por R$ ${sale.price}.`);
      if (channel === 'telegram' || channel === 'both') {
        await sendTelegramMessage(`Nova venda em ${sale.market}: ${sale.item} por R$ ${sale.price}`);
      }
    }
  }
  if (!found.length) pushLog(state, 'Checagem', 'Nenhuma nova venda encontrada nesta rodada.');
  writeState(state);
  return found;
}

app.get('/api/status', (req, res) => {
  const state = readState();
  res.json(state);
});

app.get('/api/events', (req, res) => {
  const state = readState();
  res.json({ logs: state.logs, recentSales: state.recentSales });
});

app.post('/api/check-now', async (req, res) => {
  const channel = req.body?.channel || 'both';
  const found = await runChecks(channel);
  res.json({ ok: true, found });
});

app.post('/api/test-sale', async (req, res) => {
  const state = readState();
  const sale = {
    id: crypto.randomUUID(),
    market: req.body?.market || 'Mercado Livre',
    item: req.body?.item || 'Venda de teste',
    price: req.body?.price || '79,90',
    detectedAt: new Date().toISOString(),
    source: 'manual'
  };
  pushSale(state, sale);
  pushLog(state, 'Venda manual', `${sale.market} vendeu ${sale.item} por R$ ${sale.price}.`);
  await sendTelegramMessage(`Teste de venda: ${sale.market} vendeu ${sale.item} por R$ ${sale.price}`);
  writeState(state);
  res.json({ ok: true, sale });
});

app.post('/webhooks/mercadolivre', async (req, res) => {
  const sale = await detectMercadoLivreWebhook(req.body);
  if (!sale) return res.status(400).json({ ok: false, error: 'invalid payload' });
  const state = readState();
  pushSale(state, sale);
  pushLog(state, 'Webhook Mercado Livre', `Evento recebido para ${sale.item}.`);
  await sendTelegramMessage(`Webhook ML recebido: ${sale.item}`);
  writeState(state);
  res.json({ ok: true, sale });
});

setInterval(() => {
  runChecks('both').catch(() => {});
}, Number(process.env.POLL_INTERVAL_MS || 10000));

app.listen(PORT, () => {
  console.log(`Market Alert backend rodando em http://localhost:${PORT}`);
});
