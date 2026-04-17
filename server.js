/**
 * Shiprocket ↔ Shopify Carrier Service
 *
 * Shopify calls POST /shopify/rates during checkout.
 * We proxy to Shiprocket's serviceability API and return live rates.
 *
 * Confirmed Shiprocket API endpoints (via support):
 *   Step 1  → Create API user: https://app.shiprocket.in/seller/settings/additional-settings/api-users
 *   Step 2  → Auth: POST https://apiv2.shiprocket.in/v1/external/auth/login
 *   Step 3  → Rates: GET  https://apiv2.shiprocket.in/v1/external/courier/serviceability/
 */

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
require('dotenv').config();

const cors = require('cors');
app.use(cors({
  origin: 'https://shop.myarusuvai.com',
  methods: ['GET'],
}));

const app = express();

// Raw body needed for Shopify HMAC verification
app.use(
  express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
  })
);

// ─────────────────────────────────────────────────────────────────────────
// Shiprocket token cache (token valid 24h, we refresh every 23h)
// ─────────────────────────────────────────────────────────────────────────
let srToken  = null;
let srExpiry = 0;

async function getShiprocketToken() {
  if (srToken && Date.now() < srExpiry) return srToken;

  console.log('[Shiprocket] Refreshing auth token...');

  // IMPORTANT: Use API User credentials from:
  // https://app.shiprocket.in/seller/settings/additional-settings/api-users
  // NOT your regular Shiprocket panel login
  const { data } = await axios.post(
    'https://apiv2.shiprocket.in/v1/external/auth/login',
    {
      email:    process.env.SHIPROCKET_API_EMAIL,
      password: process.env.SHIPROCKET_API_PASSWORD,
    }
  );

  srToken  = data.token;
  srExpiry = Date.now() + 23 * 60 * 60 * 1000;
  console.log('[Shiprocket] Token refreshed OK');
  return srToken;
}

// ─────────────────────────────────────────────────────────────────────────
// Shopify HMAC verification (prevents unauthorized calls to your endpoint)
// ─────────────────────────────────────────────────────────────────────────
function verifyShopifyHMAC(req) {
  const secret = process.env.SHOPIFY_SHARED_SECRET;
  if (!secret) return true; // skip in dev if not set

  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader) return false;

  const digest = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('base64');

  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(hmacHeader)
  );
}

// ─────────────────────────────────────────────────────────────────────────
// POST /shopify/rates — Shopify calls this during checkout to get rates
// ─────────────────────────────────────────────────────────────────────────
app.post('/shopify/rates', async (req, res) => {
  if (!verifyShopifyHMAC(req)) {
    console.warn('[/shopify/rates] HMAC verification failed');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { rate } = req.body;
    if (!rate) return res.status(400).json({ error: 'Invalid payload' });

    const deliveryPincode = rate.destination?.postal_code;
    const pickupPincode   = process.env.PICKUP_PINCODE;

    console.log(`[Shiprocket] Checking: ${pickupPincode} → ${deliveryPincode}`);

    if (!deliveryPincode || !pickupPincode) {
      return res.json({ rates: [] });
    }

    // Weight: Shopify sends grams per line item
    const totalGrams = (rate.items || []).reduce(
      (sum, item) => sum + (item.grams || 0) * (item.quantity || 1),
      0
    );
    const weightKg = Math.max(totalGrams / 1000, 0.1); // Shiprocket minimum 0.1 kg

    // COD: Shopify online orders are always prepaid → cod = 0
    // cod = 0 (Prepaid) | cod = 1 (Cash on Delivery)
    const cod = 0;

    const token = await getShiprocketToken();

    const { data: srData } = await axios.get(
      'https://apiv2.shiprocket.in/v1/external/courier/serviceability/',
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          pickup_postcode:   parseInt(pickupPincode, 10),
          delivery_postcode: parseInt(deliveryPincode, 10),
          weight:            weightKg.toFixed(2), // in kg
          cod,
        },
      }
    );

    const couriers = srData?.data?.available_courier_companies || [];
    console.log(`[Shiprocket] ${couriers.length} courier(s) available`);

    // Not serviceable to this pincode
    if (!couriers.length) {
      return res.json({
        rates: [
          {
            service_name: 'Delivery not available to this pincode',
            service_code: 'NOT_SERVICEABLE',
            total_price:  '0',
            currency:     'INR',
            description:  `We currently don't deliver to ${deliveryPincode}.`,
          },
        ],
      });
    }

    // Map Shiprocket couriers → Shopify rate objects
    // De-duplicate by estimated days, sort cheapest first, show top 3
    const seen  = new Set();
    const rates = couriers
      .filter(c => c.freight_charge > 0)
      .sort((a, b) => a.freight_charge - b.freight_charge)
      .filter(c => {
        const key = String(c.estimated_delivery_days);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 3)
      .map(c => {
        const days = Number(c.estimated_delivery_days);
        return {
          service_name: buildLabel(days),
          service_code: `SR_${c.courier_company_id}`,
          // Shopify expects smallest currency unit (paise): ₹150 = 15000
          total_price:       String(Math.round(c.freight_charge * 100)),
          currency:          'INR',
          description:       c.etd
                               ? `Estimated delivery: ${c.etd}`
                               : `${days} business day${days !== 1 ? 's' : ''}`,
          min_delivery_date: addDays(days),
          max_delivery_date: addDays(days + 1),
        };
      });

    return res.json({ rates });

  } catch (err) {
    console.error('[/shopify/rates] Error:', err.response?.data || err.message);
    // Return empty → Shopify shows its own fallback rates if configured
    return res.json({ rates: [] });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /test-shiprocket
// Use this to verify your credentials work BEFORE connecting to Shopify.
//
// Usage:
//   curl http://localhost:3000/test-shiprocket
//   curl "http://localhost:3000/test-shiprocket?delivery=400001&weight=0.5"
// ─────────────────────────────────────────────────────────────────────────
app.get('/test-shiprocket', async (req, res) => {
  try {
    const token    = await getShiprocketToken();
    const pickup   = req.query.pickup   || process.env.PICKUP_PINCODE;
    const delivery = req.query.delivery || '400001'; // Default: Mumbai
    const weight   = req.query.weight   || '0.5';

    const { data } = await axios.get(
      'https://apiv2.shiprocket.in/v1/external/courier/serviceability/',
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          pickup_postcode:   parseInt(pickup, 10),
          delivery_postcode: parseInt(delivery, 10),
          weight:            parseFloat(weight),
          cod:               0,
        },
      }
    );

    const couriers = data?.data?.available_courier_companies || [];

    return res.json({
      status:           '✅ Shiprocket connected',
      pickup_pincode:   pickup,
      delivery_pincode: delivery,
      weight_kg:        weight,
      couriers_found:   couriers.length,
      top_rates:        couriers.slice(0, 5).map(c => ({
        courier:      c.courier_name,
        price_inr:    `₹${c.freight_charge}`,
        days:         c.estimated_delivery_days,
        etd:          c.etd,
      })),
    });
  } catch (err) {
    return res.status(500).json({
      status: '❌ Error',
      error:  err.response?.data || err.message,
    });
  }
});

// GET /check-pincode?pincode=400001&weight=0.5
// Called directly from the Shopify cart page widget
app.get('/check-pincode', async (req, res) => {
  try {
    const { pincode, weight = '0.5' } = req.query;

    if (!pincode || !/^\d{6}$/.test(pincode)) {
      return res.status(400).json({ error: 'Enter a valid 6-digit pincode' });
    }

    const token = await getShiprocketToken();

    const { data: srData } = await axios.get(
      'https://apiv2.shiprocket.in/v1/external/courier/serviceability/',
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          pickup_postcode:   parseInt(process.env.PICKUP_PINCODE, 10),
          delivery_postcode: parseInt(pincode, 10),
          weight:            parseFloat(weight),
          cod:               0,
        },
      }
    );

    const couriers = srData?.data?.available_courier_companies || [];

    if (!couriers.length) {
      return res.json({ serviceable: false, message: `Delivery not available to ${pincode}` });
    }

    const seen  = new Set();
    const rates = couriers
      .filter(c => c.freight_charge > 0)
      .sort((a, b) => a.freight_charge - b.freight_charge)
      .filter(c => {
        const k = String(c.estimated_delivery_days);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 3)
      .map(c => ({
        courier:  c.courier_name,
        price:    c.freight_charge,
        days:     c.estimated_delivery_days,
        etd:      c.etd,
      }));

    return res.json({ serviceable: true, pincode, rates });

  } catch (err) {
    console.error('[/check-pincode] Error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Failed to check serviceability' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
function buildLabel(days) {
  if (days <= 1) return `Express Delivery (${days} day)`;
  if (days <= 3) return `Standard Delivery (${days} days)`;
  return `Economy Delivery (${days} days)`;
}

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + Math.round(n));
  return d.toISOString();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Carrier service on port ${PORT}`);
  console.log(`   Verify Shiprocket: GET /test-shiprocket`);
  console.log(`   Health:            GET /health\n`);
});
