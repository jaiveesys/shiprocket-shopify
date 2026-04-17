const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const cors    = require('cors');
require('dotenv').config();

const app = express();
app.use(cors({ origin: 'https://shop.myarusuvai.com', methods: ['GET', 'POST'] }));
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

let srToken = null, srExpiry = 0;

async function getShiprocketToken() {
  if (srToken && Date.now() < srExpiry) return srToken;
  console.log('[Shiprocket] Refreshing token...');
  const { data } = await axios.post('https://apiv2.shiprocket.in/v1/external/auth/login', {
    email: process.env.SHIPROCKET_API_EMAIL,
    password: process.env.SHIPROCKET_API_PASSWORD,
  });
  srToken = data.token;
  srExpiry = Date.now() + 23 * 60 * 60 * 1000;
  console.log('[Shiprocket] Token OK');
  return srToken;
}

function verifyShopifyHMAC(req) {
  const secret = process.env.SHOPIFY_SHARED_SECRET;
  if (!secret) return true;
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader) return false;
  const digest = crypto.createHmac('sha256', secret).update(req.rawBody).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

app.post('/shopify/rates', async (req, res) => {
  if (!verifyShopifyHMAC(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { rate } = req.body;
    if (!rate) return res.status(400).json({ error: 'Invalid payload' });
    const deliveryPincode = rate.destination?.postal_code;
    const pickupPincode   = process.env.PICKUP_PINCODE;
    if (!deliveryPincode || !pickupPincode) return res.json({ rates: [] });
    const totalGrams = (rate.items || []).reduce((sum, item) => sum + (item.grams || 0) * (item.quantity || 1), 0);
    const weightKg = Math.max(totalGrams / 1000, 0.1);
    const token = await getShiprocketToken();
    const { data: srData } = await axios.get('https://apiv2.shiprocket.in/v1/external/courier/serviceability/', {
      headers: { Authorization: `Bearer ${token}` },
      params: { pickup_postcode: parseInt(pickupPincode, 10), delivery_postcode: parseInt(deliveryPincode, 10), weight: weightKg.toFixed(2), cod: 0 },
    });
    const couriers = srData?.data?.available_courier_companies || [];
    if (!couriers.length) {
      return res.json({ rates: [{ service_name: 'Delivery not available to this pincode', service_code: 'NOT_SERVICEABLE', total_price: '0', currency: 'INR', description: `We currently don't deliver to ${deliveryPincode}.` }] });
    }
    const seen = new Set();
    const rates = couriers
      .filter(c => c.freight_charge > 0)
      .sort((a, b) => a.freight_charge - b.freight_charge)
      .filter(c => { const k = String(c.estimated_delivery_days); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 3)
      .map(c => {
        const days = Number(c.estimated_delivery_days);
        const label = days <= 1 ? `Express Delivery (${days} day)` : days <= 3 ? `Standard Delivery (${days} days)` : `Economy Delivery (${days} days)`;
        const addDays = n => { const d = new Date(); d.setDate(d.getDate() + Math.round(n)); return d.toISOString(); };
        return { service_name: label, service_code: `SR_${c.courier_company_id}`, total_price: String(Math.round(c.freight_charge * 100)), currency: 'INR', description: c.etd ? `Estimated delivery: ${c.etd}` : `${days} business day${days !== 1 ? 's' : ''}`, min_delivery_date: addDays(days), max_delivery_date: addDays(days + 1) };
      });
    return res.json({ rates });
  } catch (err) {
    console.error('[/shopify/rates] Error:', err.response?.data || err.message);
    return res.json({ rates: [] });
  }
});

app.get('/check-pincode', async (req, res) => {
  try {
    const { pincode, weight = '0.5' } = req.query;
    if (!pincode || !/^\d{6}$/.test(pincode)) {
      return res.status(400).json({ error: 'Enter a valid 6-digit pincode' });
    }
    const token = await getShiprocketToken();
    const { data: srData } = await axios.get('https://apiv2.shiprocket.in/v1/external/courier/serviceability/', {
      headers: { Authorization: `Bearer ${token}` },
      params: { pickup_postcode: parseInt(process.env.PICKUP_PINCODE, 10), delivery_postcode: parseInt(pincode, 10), weight: parseFloat(weight), cod: 0 },
    });
    const couriers = srData?.data?.available_courier_companies || [];
    if (!couriers.length) {
      return res.json({ serviceable: false, message: `Delivery not available to ${pincode}` });
    }
    const seen = new Set();
    const rates = couriers
      .filter(c => c.freight_charge > 0)
      .sort((a, b) => a.freight_charge - b.freight_charge)
      .filter(c => { const k = String(c.estimated_delivery_days); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 3)
      .map(c => ({ courier: c.courier_name, price: c.freight_charge, days: c.estimated_delivery_days, etd: c.etd }));
    return res.json({ serviceable: true, pincode, rates });
  } catch (err) {
    console.error('[/check-pincode] Error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Failed to check serviceability' });
  }
});

app.get('/test-shiprocket', async (req, res) => {
  try {
    const token    = await getShiprocketToken();
    const pickup   = req.query.pickup   || process.env.PICKUP_PINCODE;
    const delivery = req.query.delivery || '400001';
    const weight   = req.query.weight   || '0.5';
    const { data } = await axios.get('https://apiv2.shiprocket.in/v1/external/courier/serviceability/', {
      headers: { Authorization: `Bearer ${token}` },
      params: { pickup_postcode: parseInt(pickup, 10), delivery_postcode: parseInt(delivery, 10), weight: parseFloat(weight), cod: 0 },
    });
    const couriers = data?.data?.available_courier_companies || [];
    return res.json({ status: '✅ Shiprocket connected', pickup_pincode: pickup, delivery_pincode: delivery, weight_kg: weight, couriers_found: couriers.length, top_rates: couriers.slice(0, 5).map(c => ({ courier: c.courier_name, price_inr: `₹${c.freight_charge}`, days: c.estimated_delivery_days, etd: c.etd })) });
  } catch (err) {
    return res.status(500).json({ status: '❌ Error', error: err.response?.data || err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`   Test: curl http://localhost:${PORT}/test-shiprocket\n`);
});