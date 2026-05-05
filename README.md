# Market Alert Backend v2 — Vendas REAIS

## Variáveis de ambiente no Render

Configure no painel do Render → Environment:

### Mercado Livre (API oficial)
| Variável | Descrição |
|---|---|
| `ML_ACCESS_TOKEN` | Token de acesso gerado em developers.mercadolivre.com.br |
| `ML_CLIENT_ID` | App ID do seu app ML |
| `ML_CLIENT_SECRET` | Secret do seu app ML |
| `ML_REFRESH_TOKEN` | Refresh token para renovação automática |

### DFG.com.br
| Variável | Descrição |
|---|---|
| `DFG_EMAIL` | Seu email de login no DFG |
| `DFG_PASSWORD` | Sua senha no DFG |

### Desapego Games
| Variável | Descrição |
|---|---|
| `DESAPEGO_EMAIL` | Seu email no Desapego Games |
| `DESAPEGO_PASSWORD` | Sua senha |

### GameMarket
| Variável | Descrição |
|---|---|
| `GAMEMARKET_EMAIL` | Seu email no GameMarket |
| `GAMEMARKET_PASSWORD` | Sua senha |

### GGMAX
| Variável | Descrição |
|---|---|
| `GGMAX_EMAIL` | Seu email no GGMAX |
| `GGMAX_PASSWORD` | Sua senha |

### Telegram (opcional)
| Variável | Descrição |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token do seu bot (@BotFather) |
| `TELEGRAM_CHAT_ID` | Seu chat_id para receber alertas |

### Intervalo
| Variável | Padrão |
|---|---|
| `POLL_INTERVAL_MS` | 30000 (30 segundos) |

## Como obter o token do Mercado Livre

1. Acesse https://developers.mercadolivre.com.br
2. Clique em "Criar aplicativo"
3. Preencha nome, URL de redirecionamento (pode ser https://marketalertv2.onrender.com)
4. Anote Client ID e Client Secret
5. Use o fluxo OAuth para gerar o Access Token e Refresh Token

## Rotas disponíveis

- `GET /api/status` — status geral + últimas vendas
- `POST /api/check-now` — dispara checagem manual
- `POST /webhook/mercadolivre` — recebe notificações instantâneas do ML
- `GET /health` — healthcheck

## Deploy no Render

1. git add . && git commit -m "v2 vendas reais" && git push
2. O Render redeploya automaticamente
3. Configure as variáveis de ambiente no painel
