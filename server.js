/**
 * SCALP·PRO — Servidor Webhook
 * Recibe alertas de TradingView y envía señales a WhatsApp vía Twilio
 * 
 * Stack: Node.js + Express + Twilio
 * Deploy: Railway / Render / Fly.io (gratis)
 */

require('dotenv').config();
const express  = require('express');
const twilio   = require('twilio');
const app      = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────
//  CONFIGURACIÓN — llenar en .env
// ─────────────────────────────────────────────
const CONFIG = {
  port          : process.env.PORT || 3000,
  webhookSecret : process.env.WEBHOOK_SECRET || 'scalp-pro-secret-2024',
  twilio: {
    accountSid  : process.env.TWILIO_ACCOUNT_SID,
    authToken   : process.env.TWILIO_AUTH_TOKEN,
    fromNumber  : process.env.TWILIO_WHATSAPP_FROM,   // 'whatsapp:+14155238886'
    toNumbers   : (process.env.WHATSAPP_RECIPIENTS || '').split(',').map(n => n.trim())
  }
};

const twilioClient = twilio(CONFIG.twilio.accountSid, CONFIG.twilio.authToken);

// ─────────────────────────────────────────────
//  MEMORIA DE SEÑALES (en RAM — simple log)
// ─────────────────────────────────────────────
const signals = [];

// ─────────────────────────────────────────────
//  UTILIDADES
// ─────────────────────────────────────────────
function toJPYprice(val) {
  return parseFloat(val).toFixed(3);
}

function buildWhatsAppMessage(data) {
  const dir      = data.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL';
  const arrow    = data.direction === 'BUY' ? '▲' : '▼';
  const poi      = toJPYprice(data.poi);
  const inv      = toJPYprice(data.invalidation);
  const e1       = toJPYprice(data.exit1);
  const e2       = toJPYprice(data.exit2);
  const e3       = toJPYprice(data.exit3);
  const rsi      = parseFloat(data.rsi).toFixed(1);
  const now      = new Date();
  const timeUTC  = now.toUTCString().slice(17, 22) + ' UTC';
  const conf     = data.confidence || 'HIGH';

  return [
    `━━━━━━━━━━━━━━━━━━━━━`,
    `📊 *SCALP·PRO SIGNAL*`,
    `━━━━━━━━━━━━━━━━━━━━━`,
    `${dir} ${arrow} *USD/JPY* · M5`,
    `🕐 ${timeUTC}`,
    `⚡ Confianza: *${conf}*`,
    ``,
    `📍 *POI (Entry)*`,
    `   \`${poi}\``,
    ``,
    `✕ *Invalidation Level (SL)*`,
    `   \`${inv}\`  (−20 pip)`,
    ``,
    `🎯 *Exit 1 · R:R 1:1*`,
    `   \`${e1}\`  (+20 pip)`,
    ``,
    `🎯 *Exit 2 · R:R 1:2*`,
    `   \`${e2}\`  (+40 pip)`,
    ``,
    `🎯 *Exit 3 · R:R 1:3*`,
    `   \`${e3}\`  (+60 pip)`,
    ``,
    `📈 RSI(7): ${rsi} · EMA cruce ${arrow}`,
    `━━━━━━━━━━━━━━━━━━━━━`,
    `_SCALP·PRO — Sistema automatizado_`,
    `_Gestiona tu riesgo correctamente._`
  ].join('\n');
}

// ─────────────────────────────────────────────
//  ENVIAR WHATSAPP
// ─────────────────────────────────────────────
async function sendWhatsApp(message) {
  const results = [];
  for (const toNum of CONFIG.twilio.toNumbers) {
    try {
      const msg = await twilioClient.messages.create({
        from: CONFIG.twilio.fromNumber,
        to  : `whatsapp:${toNum}`,
        body: message
      });
      console.log(`✅ WhatsApp enviado a ${toNum} — SID: ${msg.sid}`);
      results.push({ to: toNum, status: 'sent', sid: msg.sid });
    } catch (err) {
      console.error(`❌ Error enviando a ${toNum}:`, err.message);
      results.push({ to: toNum, status: 'error', error: err.message });
    }
  }
  return results;
}

// ─────────────────────────────────────────────
//  ENDPOINT PRINCIPAL — Webhook de TradingView
// ─────────────────────────────────────────────
app.post('/webhook/usdjpy', async (req, res) => {
  try {
    // Verificar secret
    const secret = req.headers['x-webhook-secret'] || req.query.secret;
    if (secret !== CONFIG.webhookSecret) {
      console.warn('⚠️  Webhook secret inválido');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const data = req.body;
    console.log('📩 Webhook recibido:', JSON.stringify(data));

    // Validar campos mínimos
    if (!data.direction || !data.poi) {
      return res.status(400).json({ error: 'Payload incompleto' });
    }

    // Construir y enviar mensaje
    const message = buildWhatsAppMessage(data);
    const results  = await sendWhatsApp(message);

    // Guardar en log
    const signal = {
      id         : Date.now(),
      timestamp  : new Date().toISOString(),
      direction  : data.direction,
      pair       : data.pair || 'USDJPY',
      timeframe  : data.timeframe || 'M5',
      poi        : data.poi,
      invalidation: data.invalidation,
      exit1      : data.exit1,
      exit2      : data.exit2,
      exit3      : data.exit3,
      rsi        : data.rsi,
      confidence : data.confidence,
      whatsapp   : results
    };
    signals.unshift(signal);
    if (signals.length > 200) signals.pop();  // mantener últimas 200

    console.log(`📡 Señal procesada: ${data.direction} @ ${data.poi}`);
    res.json({ success: true, signal_id: signal.id, whatsapp: results });

  } catch (err) {
    console.error('❌ Error en webhook:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  API — Dashboard
// ─────────────────────────────────────────────
app.get('/api/signals', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ signals: signals.slice(0, limit), total: signals.length });
});

app.get('/api/stats', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const todaySignals = signals.filter(s => s.timestamp.startsWith(today));
  res.json({
    total_today  : todaySignals.length,
    buys_today   : todaySignals.filter(s => s.direction === 'BUY').length,
    sells_today  : todaySignals.filter(s => s.direction === 'SELL').length,
    total_all    : signals.length,
    last_signal  : signals[0] || null,
    server_time  : new Date().toISOString()
  });
});

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'SCALP·PRO', version: '1.0.0' }));
app.get('/', (_, res) => res.send('<h2>SCALP·PRO Webhook Server — Activo ✅</h2>'));

// ─────────────────────────────────────────────
//  INICIO
// ─────────────────────────────────────────────
app.listen(CONFIG.port, () => {
  console.log(`
╔══════════════════════════════════════╗
║        SCALP·PRO — SERVER v1.0       ║
║   Webhook USD/JPY M5 + WhatsApp      ║
╚══════════════════════════════════════╝
🟢 Activo en puerto ${CONFIG.port}
📡 Endpoint: POST /webhook/usdjpy
📊 Stats API: GET  /api/signals
`);
});

module.exports = app;
