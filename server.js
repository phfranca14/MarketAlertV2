const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS) || 30000;

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID   || '';

async function sendTelegram(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT,
      text: msg,
      parse_mode: 'HTML'
    });
  } catch (e) { console.error('[Telegram]', e.message); }
}

// ─── ESTADO ──────────────────────────────────────────────────────────────────
const state = {
  checks: 0,
  sales: [],
  seenIds: new Set(),
  logs: [],
  lastCheck: null
};

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
  state.checks++;
  addLog(`💰 VENDA REAL: ${sale.market} | ${sale.item} | R$ ${sale.price} | ${sale.buyer || ''}`);
  sendTelegram(`🔔 <b>Nova venda!</b>\n📦 ${sale.item}\n💰 R$ ${sale.price}\n🛒 ${sale.market}\n👤 ${sale.buyer || 'N/A'}`);
  return true;
}

// ─── MERCADO LIVRE ───────────────────────────────────────────────────────────
// OAuth2 — precisa de: ML_ACCESS_TOKEN (gerado via https://developers.mercadolivre.com.br)
// ou ML_CLIENT_ID + ML_CLIENT_SECRET + ML_REFRESH_TOKEN para auto-refresh
const ML_ACCESS_TOKEN  = process.env.ML_ACCESS_TOKEN  || '';
const ML_REFRESH_TOKEN = process.env.ML_REFRESH_TOKEN || '';
const ML_CLIENT_ID     = process.env.ML_CLIENT_ID     || '';
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || '';

let mlToken = ML_ACCESS_TOKEN;

async function refreshMLToken() {
  if (!ML_CLIENT_ID || !ML_REFRESH_TOKEN) return;
  try {
    const res = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type: 'refresh_token',
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: ML_REFRESH_TOKEN
    });
    mlToken = res.data.access_token;
    addLog('[ML] Token renovado com sucesso');
  } catch (e) {
    addLog('[ML] Erro ao renovar token: ' + e.message);
  }
}

async function checkMercadoLivre() {
  if (!mlToken) { addLog('[ML] ML_ACCESS_TOKEN não configurado — pule esta etapa'); return; }
  try {
    // busca pedidos pagos/recentes
    const res = await axios.get('https://api.mercadolibre.com/orders/search?sort=date_desc&limit=10', {
      headers: { Authorization: `Bearer ${mlToken}` }
    });
    const orders = res.data.results || [];
    for (const order of orders) {
      if (['paid', 'payment_required', 'partially_paid'].includes(order.status)) {
        const item = order.order_items?.[0]?.item?.title || 'Produto';
        const price = order.total_amount || order.order_items?.[0]?.unit_price || 0;
        const buyer = order.buyer?.nickname || '';
        addSale({
          id: `ml_${order.id}`,
          market: 'mercadolivre.com.br',
          item,
          price: parseFloat(price).toFixed(2),
          buyer,
          detectedAt: new Date().toISOString(),
          source: 'api-oficial'
        });
      }
    }
    addLog(`[ML] Verificado — ${orders.length} pedidos encontrados`);
  } catch (e) {
    if (e.response?.status === 401) {
      addLog('[ML] Token expirado, tentando renovar...');
      await refreshMLToken();
    } else {
      addLog('[ML] Erro: ' + e.message);
    }
  }
}

// ─── DFG.COM.BR ──────────────────────────────────────────────────────────────
const DFG_EMAIL = process.env.DFG_EMAIL || '';
const DFG_PASS  = process.env.DFG_PASSWORD || '';
let dfgCookie   = '';

async function loginDFG() {
  if (!DFG_EMAIL || !DFG_PASS) return false;
  try {
    const res = await axios.post('https://www.dfg.com.br/api/login', {
      email: DFG_EMAIL,
      password: DFG_PASS
    }, {
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      maxRedirects: 5
    });
    // captura cookie de sessão
    const cookies = res.headers['set-cookie'];
    if (cookies) {
      dfgCookie = cookies.map(c => c.split(';')[0]).join('; ');
      addLog('[DFG] Login OK');
      return true;
    }
    // tenta token JWT
    if (res.data?.token) {
      dfgCookie = `token=${res.data.token}`;
      addLog('[DFG] Login OK (JWT)');
      return true;
    }
  } catch (e) {
    addLog('[DFG] Erro no login: ' + e.message);
  }
  return false;
}

async function checkDFG() {
  if (!DFG_EMAIL || !DFG_PASS) { addLog('[DFG] Credenciais não configuradas'); return; }
  if (!dfgCookie) await loginDFG();
  if (!dfgCookie) return;
  try {
    // tenta endpoint de vendas/pedidos
    const endpoints = [
      '/api/user/sales', '/api/sales', '/api/orders',
      '/api/user/orders', '/api/user/products/sold'
    ];
    let orders = null;
    for (const ep of endpoints) {
      try {
        const r = await axios.get(`https://www.dfg.com.br${ep}`, {
          headers: { Cookie: dfgCookie, 'User-Agent': 'Mozilla/5.0' }
        });
        if (r.data && (r.data.data || Array.isArray(r.data))) {
          orders = r.data.data || r.data;
          addLog(`[DFG] Endpoint funcionou: ${ep}`);
          break;
        }
      } catch (_) {}
    }
    if (!orders) {
      // fallback: scraping da página de vendas
      const r = await axios.get('https://www.dfg.com.br/pt/user/sales', {
        headers: { Cookie: dfgCookie, 'User-Agent': 'Mozilla/5.0' }
      });
      const $ = cheerio.load(r.data);
      // coleta linhas de venda da tabela
      $('table tbody tr, .sale-item, .order-row, [class*="sale"], [class*="order"]').each((i, el) => {
        const text = $(el).text().trim();
        const idMatch = text.match(/\d{6,}/);
        const priceMatch = text.match(/R\$\s*([\d.,]+)/);
        if (idMatch && priceMatch) {
          addSale({
            id: `dfg_${idMatch[0]}`,
            market: 'dfg.com.br',
            item: $(el).find('[class*="title"], td:nth-child(2), .name').first().text().trim() || 'Produto DFG',
            price: priceMatch[1].replace(',', '.'),
            detectedAt: new Date().toISOString(),
            source: 'scraping'
          });
        }
      });
      addLog('[DFG] Scraping da página de vendas concluído');
      return;
    }
    if (Array.isArray(orders)) {
      for (const o of orders) {
        const statusOk = ['paid', 'sold', 'completed', 'approved', 'concluido', 'pago'].includes(
          (o.status || o.estado || '').toLowerCase()
        );
        if (statusOk || o.id) {
          addSale({
            id: `dfg_${o.id || o.order_id}`,
            market: 'dfg.com.br',
            item: o.title || o.product_name || o.name || o.item || 'Produto DFG',
            price: parseFloat(o.price || o.amount || o.valor || 0).toFixed(2),
            buyer: o.buyer_name || o.buyer?.name || '',
            detectedAt: new Date().toISOString(),
            source: 'api'
          });
        }
      }
    }
    addLog(`[DFG] Verificado — ${(orders||[]).length} registros`);
  } catch (e) {
    addLog('[DFG] Erro: ' + e.message);
    dfgCookie = ''; // força novo login na próxima rodada
  }
}

// ─── DESAPEGO GAMES ──────────────────────────────────────────────────────────
const DG_EMAIL = process.env.DESAPEGO_EMAIL    || '';
const DG_PASS  = process.env.DESAPEGO_PASSWORD || '';
let dgCookie   = '';

async function loginDesapego() {
  if (!DG_EMAIL || !DG_PASS) return false;
  try {
    // pega token CSRF
    const loginPage = await axios.get('https://www.desapegogames.com.br/login', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const $ = cheerio.load(loginPage.data);
    const csrf = $('input[name="_token"], meta[name="csrf-token"]').attr('value') ||
                 $('meta[name="csrf-token"]').attr('content') || '';
    const pageCookies = (loginPage.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const res = await axios.post('https://www.desapegogames.com.br/login', {
      email: DG_EMAIL, password: DG_PASS, _token: csrf
    }, {
      headers: {
        Cookie: pageCookies,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://www.desapegogames.com.br/login'
      },
      maxRedirects: 5
    });
    const cookies = res.headers['set-cookie'];
    if (cookies) {
      dgCookie = cookies.map(c => c.split(';')[0]).join('; ');
      addLog('[DG] Login OK');
      return true;
    }
  } catch (e) { addLog('[DG] Erro login: ' + e.message); }
  return false;
}

async function checkDesapego() {
  if (!DG_EMAIL || !DG_PASS) { addLog('[DG] Credenciais não configuradas'); return; }
  if (!dgCookie) await loginDesapego();
  if (!dgCookie) return;
  try {
    const res = await axios.get('https://www.desapegogames.com.br/profile/sales', {
      headers: { Cookie: dgCookie, 'User-Agent': 'Mozilla/5.0' }
    });
    const $ = cheerio.load(res.data);
    $('[class*="sale"], [class*="order"], table tbody tr, .item-row').each((i, el) => {
      const text = $(el).text().trim();
      const idMatch = $(el).attr('data-id') || text.match(/\d{5,}/)?.[0];
      const priceMatch = text.match(/R\$\s*([\d.,]+)/);
      if (idMatch) {
        addSale({
          id: `dg_${idMatch}`,
          market: 'desapegogames.com.br',
          item: $(el).find('[class*="title"], [class*="name"], td:first').text().trim() || 'Produto Desapego',
          price: priceMatch ? priceMatch[1].replace(',', '.') : '0.00',
          detectedAt: new Date().toISOString(),
          source: 'scraping'
        });
      }
    });
    addLog('[DG] Verificado');
  } catch (e) {
    addLog('[DG] Erro: ' + e.message);
    dgCookie = '';
  }
}

// ─── GAMEMARKET ───────────────────────────────────────────────────────────────
const GM_EMAIL = process.env.GAMEMARKET_EMAIL    || '';
const GM_PASS  = process.env.GAMEMARKET_PASSWORD || '';
let gmCookie   = '';

async function loginGameMarket() {
  if (!GM_EMAIL || !GM_PASS) return false;
  try {
    const loginPage = await axios.get('https://www.gamemarket.com.br/login', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const $ = cheerio.load(loginPage.data);
    const csrf = $('input[name="_token"]').attr('value') || '';
    const pageCookies = (loginPage.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const res = await axios.post('https://www.gamemarket.com.br/login', {
      email: GM_EMAIL, password: GM_PASS, _token: csrf
    }, {
      headers: {
        Cookie: pageCookies,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0'
      },
      maxRedirects: 5
    });
    const cookies = res.headers['set-cookie'];
    if (cookies) {
      gmCookie = cookies.map(c => c.split(';')[0]).join('; ');
      addLog('[GM] Login OK');
      return true;
    }
  } catch (e) { addLog('[GM] Erro login: ' + e.message); }
  return false;
}

async function checkGameMarket() {
  if (!GM_EMAIL || !GM_PASS) { addLog('[GM] Credenciais não configuradas'); return; }
  if (!gmCookie) await loginGameMarket();
  if (!gmCookie) return;
  try {
    const res = await axios.get('https://www.gamemarket.com.br/perfil/vendas', {
      headers: { Cookie: gmCookie, 'User-Agent': 'Mozilla/5.0' }
    });
    const $ = cheerio.load(res.data);
    $('[class*="sale"], [class*="order"], [class*="sell"], table tbody tr').each((i, el) => {
      const text = $(el).text().trim();
      const idMatch = $(el).attr('data-id') || text.match(/\d{5,}/)?.[0];
      const priceMatch = text.match(/R\$\s*([\d.,]+)/);
      if (idMatch) {
        addSale({
          id: `gm_${idMatch}`,
          market: 'gamemarket.com.br',
          item: $(el).find('[class*="title"], [class*="name"], td:first').text().trim() || 'Produto GameMarket',
          price: priceMatch ? priceMatch[1].replace(',', '.') : '0.00',
          detectedAt: new Date().toISOString(),
          source: 'scraping'
        });
      }
    });
    addLog('[GM] Verificado');
  } catch (e) {
    addLog('[GM] Erro: ' + e.message);
    gmCookie = '';
  }
}

// ─── GGMAX ────────────────────────────────────────────────────────────────────
const GX_EMAIL = process.env.GGMAX_EMAIL    || '';
const GX_PASS  = process.env.GGMAX_PASSWORD || '';
let gxCookie   = '';

async function loginGGMax() {
  if (!GX_EMAIL || !GX_PASS) return false;
  try {
    const res = await axios.post('https://www.ggmax.com.br/api/auth/login', {
      email: GX_EMAIL, password: GX_PASS
    }, { headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
    if (res.data?.token) {
      gxCookie = `token=${res.data.token}`;
      addLog('[GX] Login OK (JWT)');
      return true;
    }
    const cookies = res.headers['set-cookie'];
    if (cookies) {
      gxCookie = cookies.map(c => c.split(';')[0]).join('; ');
      addLog('[GX] Login OK');
      return true;
    }
  } catch (e) { addLog('[GX] Erro login: ' + e.message); }
  return false;
}

async function checkGGMax() {
  if (!GX_EMAIL || !GX_PASS) { addLog('[GX] Credenciais não configuradas'); return; }
  if (!gxCookie) await loginGGMax();
  if (!gxCookie) return;
  try {
    // tenta API primeiro, depois scraping
    let orders = null;
    try {
      const r = await axios.get('https://www.ggmax.com.br/api/user/sales', {
        headers: { Cookie: gxCookie, Authorization: gxCookie.startsWith('token=') ? `Bearer ${gxCookie.slice(6)}` : '', 'User-Agent': 'Mozilla/5.0' }
      });
      orders = r.data?.data || r.data;
    } catch (_) {}

    if (orders && Array.isArray(orders)) {
      for (const o of orders) {
        addSale({
          id: `gx_${o.id || o.order_id}`,
          market: 'ggmax.com.br',
          item: o.title || o.name || o.product || 'Produto GGMAX',
          price: parseFloat(o.price || o.amount || 0).toFixed(2),
          detectedAt: new Date().toISOString(),
          source: 'api'
        });
      }
    } else {
      const res = await axios.get('https://www.ggmax.com.br/perfil/vendas', {
        headers: { Cookie: gxCookie, 'User-Agent': 'Mozilla/5.0' }
      });
      const $ = cheerio.load(res.data);
      $('[class*="sale"], [class*="order"], table tbody tr').each((i, el) => {
        const text = $(el).text().trim();
        const idMatch = $(el).attr('data-id') || text.match(/\d{5,}/)?.[0];
        const priceMatch = text.match(/R\$\s*([\d.,]+)/);
        if (idMatch) {
          addSale({
            id: `gx_${idMatch}`,
            market: 'ggmax.com.br',
            item: $(el).find('[class*="title"], td:first').text().trim() || 'Produto GGMAX',
            price: priceMatch ? priceMatch[1].replace(',', '.') : '0.00',
            detectedAt: new Date().toISOString(),
            source: 'scraping'
          });
        }
      });
    }
    addLog('[GX] Verificado');
  } catch (e) {
    addLog('[GX] Erro: ' + e.message);
    gxCookie = '';
  }
}

// ─── LOOP PRINCIPAL ──────────────────────────────────────────────────────────
async function checkAll() {
  state.lastCheck = new Date().toISOString();
  state.checks++;
  addLog('--- Iniciando verificação ---');
  await Promise.allSettled([
    checkMercadoLivre(),
    checkDFG(),
    checkDesapego(),
    checkGameMarket(),
    checkGGMax()
  ]);
  addLog('--- Verificação concluída ---');
}

setInterval(checkAll, POLL_INTERVAL);
setTimeout(checkAll, 3000); // primeira checagem em 3 segundos

// ─── ROTAS ────────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    stats: { checks: state.checks, sales: state.sales.length, lastCheck: state.lastCheck },
    recentSales: state.sales.slice(0, 20),
    logs: state.logs.slice(0, 30),
    config: {
      mercadolivre: !!mlToken,
      dfg: !!DFG_EMAIL,
      desapego: !!DG_EMAIL,
      gamemarket: !!GM_EMAIL,
      ggmax: !!GX_EMAIL
    }
  });
});

app.post('/api/check-now', async (req, res) => {
  checkAll();
  res.json({ ok: true, message: 'Verificação iniciada' });
});

// Webhook do Mercado Livre
app.post('/webhook/mercadolivre', async (req, res) => {
  res.sendStatus(200);
  const { topic, resource } = req.body;
  if (topic === 'orders_v2' && resource && mlToken) {
    try {
      const order = await axios.get(`https://api.mercadolibre.com${resource}`, {
        headers: { Authorization: `Bearer ${mlToken}` }
      });
      const o = order.data;
      addSale({
        id: `ml_${o.id}`,
        market: 'mercadolivre.com.br',
        item: o.order_items?.[0]?.item?.title || 'Produto ML',
        price: parseFloat(o.total_amount || 0).toFixed(2),
        buyer: o.buyer?.nickname || '',
        detectedAt: new Date().toISOString(),
        source: 'webhook'
      });
    } catch (e) { addLog('[ML Webhook] Erro: ' + e.message); }
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.listen(PORT, () => {
  console.log(`✅ Market Alert rodando na porta ${PORT}`);
  console.log(`   ML Token: ${mlToken ? 'OK' : 'NÃO CONFIGURADO'}`);
  console.log(`   DFG: ${DFG_EMAIL ? 'OK' : 'NÃO CONFIGURADO'}`);
  console.log(`   Desapego: ${DG_EMAIL ? 'OK' : 'NÃO CONFIGURADO'}`);
  console.log(`   GameMarket: ${GM_EMAIL ? 'OK' : 'NÃO CONFIGURADO'}`);
  console.log(`   GGMAX: ${GX_EMAIL ? 'OK' : 'NÃO CONFIGURADO'}`);
});
