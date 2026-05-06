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
});

// Rota 2: Recebe o codigo e troca pelo token
app.get('/ml/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('Erro: sem codigo na URL.');
  try {
    const r = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type: 'authorization_code',
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      code,
      redirect_uri: ML_REDIRECT_URI
    });
    mlToken = r.data.access_token;
    mlRefreshToken = r.data.refresh_token;
    addLog('[ML] Autenticado com sucesso via OAuth!');
    res.send('<h2>✅ Mercado Livre conectado com sucesso!</h2><p>Pode fechar essa aba e voltar ao painel.</p>');
  } catch (e) {
    addLog('[ML] Erro OAuth: ' + e.message);
    res.send('Erro ao conectar: ' + (e.response?.data ? JSON.stringify(e.response.data) : e.message));
  }
});

async function checkMercadoLivre() {
  if (!mlToken) { addLog('[ML] Token nao configurado. Acesse /ml/auth para autenticar.'); return; }
  try {
    const res = await axios.get('https://api.mercadolibre.com/orders/search?sort=date_desc&limit=10', { headers: { Authorization: `Bearer ${mlToken}` } });
    const orders = res.data.results || [];
    for (const order of orders) {
      if (['paid','payment_required'].includes(order.status)) {
        addSale({ id: `ml_${order.id}`, market: 'mercadolivre.com.br', item: order.order_items?.[0]?.item?.title || 'Produto ML', price: parseFloat(order.total_amount || 0).toFixed(2), buyer: order.buyer?.nickname || '', detectedAt: new Date().toISOString(), source: 'api-oficial' });
      }
    }
    addLog(`[ML] ${orders.length} pedidos verificados`);
  } catch (e) {
    if (e.response?.status === 401 && ML_CLIENT_ID && mlRefreshToken) {
      try {
        const r = await axios.post('https://api.mercadolibre.com/oauth/token', { grant_type: 'refresh_token', client_id: ML_CLIENT_ID, client_secret: ML_CLIENT_SECRET, refresh_token: mlRefreshToken });
        mlToken = r.data.access_token;
        mlRefreshToken = r.data.refresh_token;
        addLog('[ML] Token renovado automaticamente');
      } catch (e2) { addLog('[ML] Erro ao renovar token: ' + e2.message); }
    } else { addLog('[ML] Erro: ' + e.message); }
  }
}

// ===================== DFG =====================
const DFG_COOKIE = process.env.DFG_COOKIE || '';

async function checkDFG() {
  if (!DFG_COOKIE) { addLog('[DFG] DFG_COOKIE nao configurado no Render'); return; }
  try {
    const headers = { Cookie: DFG_COOKIE, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'text/html,application/json', 'X-Requested-With': 'XMLHttpRequest' };
    let found = false;
    for (const ep of ['/api/user/sales','/api/sales','/api/orders']) {
      try {
        const r = await axios.get(`https://www.dfg.com.br${ep}`, { headers });
        const data = r.data?.data || r.data;
        if (Array.isArray(data)) {
          data.forEach(o => addSale({ id: `dfg_${o.id||o.order_id}`, market: 'dfg.com.br', item: o.title||o.product_name||o.name||'Produto DFG', price: parseFloat(o.price||o.amount||0).toFixed(2), buyer: o.buyer_name||'', detectedAt: new Date().toISOString(), source: 'api' }));
          addLog(`[DFG] API OK: ${ep} — ${data.length} registros`);
          found = true; break;
        }
      } catch (_) {}
    }
    if (!found) {
      for (const pg of ['/pt/user/sales','/pt/user/my-sales','/user/sales']) {
        try {
          const r = await axios.get(`https://www.dfg.com.br${pg}`, { headers: { ...headers, Accept: 'text/html' } });
          const $ = cheerio.load(r.data);
          let count = 0;
          $('table tbody tr, [class*="sale"], [class*="order"]').each((i, el) => {
            const text = $(el).text().replace(/\s+/g, ' ').trim();
            const id = $(el).attr('data-id') || text.match(/\b(\d{6,})\b/)?.[1];
            const price = text.match(/R\$\s*([\d]+[.,][\d]+)/)?.[1];
            if (id && price) { addSale({ id: `dfg_${id}`, market: 'dfg.com.br', item: $(el).find('[class*="title"],td:nth-child(2)').first().text().trim() || 'Produto DFG', price: price.replace(',','.'), detectedAt: new Date().toISOString(), source: 'scraping' }); count++; }
          });
          addLog(`[DFG] Scraping ${pg} — ${count} vendas`);
          found = true; break;
        } catch (_) {}
      }
    }
    if (!found) addLog('[DFG] Nenhum endpoint funcionou. Verifique o DFG_COOKIE.');
  } catch (e) { addLog('[DFG] Erro geral: ' + e.message); }
}

// ===================== DESAPEGO GAMES =====================
const DG_COOKIE = process.env.DESAPEGO_COOKIE || '';
const DG_EMAIL  = process.env.DESAPEGO_EMAIL    || '';
const DG_PASS   = process.env.DESAPEGO_PASSWORD || '';
let dgSession   = DG_COOKIE;

async function checkDesapego() {
  if (!dgSession && DG_EMAIL) {
    try {
      const lp = await axios.get('https://www.desapegogames.com.br/login', { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const $ = cheerio.load(lp.data);
      const csrf = $('input[name="_token"]').attr('value') || '';
      const pc = (lp.headers['set-cookie']||[]).map(c=>c.split(';')[0]).join('; ');
      const res = await axios.post('https://www.desapegogames.com.br/login', `email=${encodeURIComponent(DG_EMAIL)}&password=${encodeURIComponent(DG_PASS)}&_token=${csrf}`, { headers: { Cookie: pc, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }, maxRedirects: 5 });
      const ck = res.headers['set-cookie'];
      if (ck) { dgSession = ck.map(c=>c.split(';')[0]).join('; '); addLog('[DG] Login OK'); }
    } catch (e) { addLog('[DG] Erro login: ' + e.message); }
  }
  if (!dgSession) { addLog('[DG] Sem credenciais'); return; }
  try {
    const res = await axios.get('https://www.desapegogames.com.br/profile/sales', { headers: { Cookie: dgSession, 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(res.data);
    let count = 0;
    $('[class*="sale"],[class*="order"],table tbody tr').each((i, el) => {
      const text = $(el).text().replace(/\s+/g,' ').trim();
      const id = $(el).attr('data-id') || text.match(/\b(\d{5,})\b/)?.[1];
      const price = text.match(/R\$\s*([\d]+[.,][\d]+)/)?.[1];
      if (id) { addSale({ id: `dg_${id}`, market: 'desapegogames.com.br', item: $(el).find('[class*="title"],td:first').text().trim()||'Produto Desapego', price: price?price.replace(',','.'):'0.00', detectedAt: new Date().toISOString(), source: 'scraping' }); count++; }
    });
    addLog(`[DG] ${count} vendas`);
  } catch (e) { addLog('[DG] Erro: ' + e.message); dgSession = DG_COOKIE; }
}

// ===================== GAMEMARKET =====================
const GM_COOKIE = process.env.GAMEMARKET_COOKIE   || '';
const GM_EMAIL  = process.env.GAMEMARKET_EMAIL    || '';
const GM_PASS   = process.env.GAMEMARKET_PASSWORD || '';
let gmSession   = GM_COOKIE;

async function checkGameMarket() {
  if (!gmSession && GM_EMAIL) {
    try {
      const lp = await axios.get('https://www.gamemarket.com.br/login', { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const $ = cheerio.load(lp.data);
      const csrf = $('input[name="_token"]').attr('value') || '';
      const pc = (lp.headers['set-cookie']||[]).map(c=>c.split(';')[0]).join('; ');
      const res = await axios.post('https://www.gamemarket.com.br/login', `email=${encodeURIComponent(GM_EMAIL)}&password=${encodeURIComponent(GM_PASS)}&_token=${csrf}`, { headers: { Cookie: pc, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }, maxRedirects: 5 });
      const ck = res.headers['set-cookie'];
      if (ck) { gmSession = ck.map(c=>c.split(';')[0]).join('; '); addLog('[GM] Login OK'); }
    } catch (e) { addLog('[GM] Erro login: ' + e.message); }
  }
  if (!gmSession) { addLog('[GM] Sem credenciais'); return; }
  try {
    const res = await axios.get('https://www.gamemarket.com.br/perfil/vendas', { headers: { Cookie: gmSession, 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(res.data);
    let count = 0;
    $('[class*="sale"],[class*="order"],table tbody tr').each((i, el) => {
      const text = $(el).text().replace(/\s+/g,' ').trim();
      const id = $(el).attr('data-id') || text.match(/\b(\d{5,})\b/)?.[1];
      const price = text.match(/R\$\s*([\d]+[.,][\d]+)/)?.[1];
      if (id) { addSale({ id: `gm_${id}`, market: 'gamemarket.com.br', item: $(el).find('[class*="title"],td:first').text().trim()||'Produto GameMarket', price: price?price.replace(',','.'):'0.00', detectedAt: new Date().toISOString(), source: 'scraping' }); count++; }
    });
    addLog(`[GM] ${count} vendas`);
  } catch (e) { addLog('[GM] Erro: ' + e.message); gmSession = GM_COOKIE; }
}

// ===================== GGMAX =====================
const GX_COOKIE = process.env.GGMAX_COOKIE    || '';
const GX_EMAIL  = process.env.GGMAX_EMAIL     || '';
const GX_PASS   = process.env.GGMAX_PASSWORD  || '';
let gxSession   = GX_COOKIE;

async function checkGGMax() {
  if (!gxSession && GX_EMAIL) {
    try {
      const res = await axios.post('https://www.ggmax.com.br/api/auth/login', { email: GX_EMAIL, password: GX_PASS }, { headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
      if (res.data?.token) { gxSession = `Bearer ${res.data.token}`; addLog('[GX] Login OK'); }
    } catch (e) { addLog('[GX] Erro login: ' + e.message); }
  }
  if (!gxSession) { addLog('[GX] Sem credenciais'); return; }
  try {
    const isBearer = gxSession.startsWith('Bearer ');
    const headers = isBearer ? { Authorization: gxSession, 'User-Agent': 'Mozilla/5.0' } : { Cookie: gxSession, 'User-Agent': 'Mozilla/5.0' };
    const res = await axios.get('https://www.ggmax.com.br/perfil/vendas', { headers });
    const $ = cheerio.load(res.data);
    let count = 0;
    $('[class*="sale"],[class*="order"],table tbody tr').each((i, el) => {
      const text = $(el).text().replace(/\s+/g,' ').trim();
      const id = $(el).attr('data-id') || text.match(/\b(\d{5,})\b/)?.[1];
      const price = text.match(/R\$\s*([\d]+[.,][\d]+)/)?.[1];
      if (id) { addSale({ id: `gx_${id}`, market: 'ggmax.com.br', item: $(el).find('[class*="title"],td:first').text().trim()||'Produto GGMAX', price: price?price.replace(',','.'):'0.00', detectedAt: new Date().toISOString(), source: 'scraping' }); count++; }
    });
    addLog(`[GX] ${count} vendas`);
  } catch (e) { addLog('[GX] Erro: ' + e.message); gxSession = GX_COOKIE; }
}

// ===================== POLLING =====================
async function checkAll() {
  state.lastCheck = new Date().toISOString();
  state.checks++;
  addLog('--- Verificacao iniciada ---');
  await Promise.allSettled([checkMercadoLivre(), checkDFG(), checkDesapego(), checkGameMarket(), checkGGMax()]);
  addLog('--- Verificacao concluida ---');
}

setInterval(checkAll, POLL_INTERVAL);
setTimeout(checkAll, 3000);

// ===================== ROTAS =====================
app.get('/api/status', (req, res) => {
  res.json({
    stats: { checks: state.checks, sales: state.sales.length, lastCheck: state.lastCheck },
    recentSales: state.sales.slice(0,20),
    logs: state.logs.slice(0,30),
    config: {
      mercadolivre: !!mlToken,
      dfg: !!DFG_COOKIE,
      desapego: !!(dgSession||DG_EMAIL),
      gamemarket: !!(gmSession||GM_EMAIL),
      ggmax: !!(gxSession||GX_EMAIL)
    }
  });
});

app.post('/api/check-now', async (req, res) => { checkAll(); res.json({ ok: true }); });

app.post('/webhook/mercadolivre', async (req, res) => {
  res.sendStatus(200);
  const { topic, resource } = req.body;
  if (topic === 'orders_v2' && resource && mlToken) {
    try {
      const order = await axios.get(`https://api.mercadolibre.com${resource}`, { headers: { Authorization: `Bearer ${mlToken}` } });
      const o = order.data;
      addSale({ id: `ml_${o.id}`, market: 'mercadolivre.com.br', item: o.order_items?.[0]?.item?.title||'Produto ML', price: parseFloat(o.total_amount||0).toFixed(2), buyer: o.buyer?.nickname||'', detectedAt: new Date().toISOString(), source: 'webhook' });
    } catch (e) { addLog('[ML Webhook] Erro: ' + e.message); }
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.listen(PORT, () => {
  console.log(`Market Alert v4 porta ${PORT}`);
  console.log(`ML_TOKEN: ${mlToken ? 'OK' : 'NAO CONFIGURADO — acesse /ml/auth para autenticar'}`);
  console.log(`DFG_COOKIE: ${DFG_COOKIE ? 'OK' : 'NAO CONFIGURADO'}`);
});
