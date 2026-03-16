// netlify/functions/shipstation.js
// Proxy seguro — la API key vive en Netlify env vars, nunca en el HTML

const SS_BASE = 'https://ssapi.shipstation.com';

exports.handler = async (event) => {
  const apiKey    = process.env.SS_API_KEY;
  const apiSecret = process.env.SS_API_SECRET;

  if (!apiKey || !apiSecret) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'ShipStation credentials not configured in Netlify env vars' })
    };
  }

  const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${credentials}`,
    'Content-Type': 'application/json'
  };

  // Calcular fechas: últimos 7 días
  const now     = new Date();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().slice(0, 10); // YYYY-MM-DD

  try {
    // ── 1. Shipments enviados (últimos 7 días) ────────────────────────────
    const shipRes = await fetch(
      `${SS_BASE}/shipments?shipDateStart=${fmt(weekAgo)}&shipDateEnd=${fmt(now)}&pageSize=500`,
      { headers }
    );
    const shipData = await shipRes.json();
    const shipments = shipData.shipments || [];

    // ── 2. Órdenes pendientes (awaiting_shipment) ─────────────────────────
    const pendRes = await fetch(
      `${SS_BASE}/orders?orderStatus=awaiting_shipment&pageSize=500`,
      { headers }
    );
    const pendData = await pendRes.json();
    const pendingOrders = pendData.orders || [];

    // ── 3. Stores activos ─────────────────────────────────────────────────
    const storeRes = await fetch(`${SS_BASE}/stores?showInactive=false`, { headers });
    const storeData = await storeRes.json();
    const stores = Array.isArray(storeData) ? storeData : [];

    // ── Calcular KPIs ─────────────────────────────────────────────────────
    const totalShipped  = shipments.length;
    const totalPending  = pendingOrders.length;
    const totalRevenue  = shipments.reduce((s, sh) => s + (sh.shipmentCost || 0), 0);

    // SLA: shipments enviados dentro del delivery_by date
    const ontimeCount = shipments.filter(sh => {
      if (!sh.shipDate || !sh.estimatedDeliveryDate) return true; // benefit of doubt
      return new Date(sh.shipDate) <= new Date(sh.estimatedDeliveryDate);
    }).length;

    const slaPct = totalShipped > 0
      ? Math.round((ontimeCount / totalShipped) * 100)
      : 100;

    // Agrupar shipments por store
    const byStore = {};
    shipments.forEach(sh => {
      const id = String(sh.advancedOptions?.storeId || 'unknown');
      byStore[id] = (byStore[id] || 0) + 1;
    });

    // Shipments por día de la semana actual (Lun-Dom)
    const days = Array(7).fill(0);
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay() + 1); // Lunes
    startOfWeek.setHours(0, 0, 0, 0);
    shipments.forEach(sh => {
      const d = new Date(sh.shipDate);
      const diff = Math.floor((d - startOfWeek) / 86400000);
      if (diff >= 0 && diff < 7) days[diff]++;
    });

    // Week range
    const weekStart = fmt(weekAgo);
    const weekEnd   = fmt(now);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        kpis: {
          revenue_est:      parseFloat(totalRevenue.toFixed(2)),
          total_shipments:  totalShipped,
          sla_pct:          slaPct,
          pending_orders:   totalPending,
          on_time_count:    ontimeCount,
          error_count:      0,
          week_start:       weekStart,
          week_end:         weekEnd,
          updated_at:       now.toISOString()
        },
        days_data: days,           // [lun, mar, mie, jue, vie, sab, dom]
        pending_orders: pendingOrders.map(o => ({
          orderNumber: o.orderNumber,
          store:       o.advancedOptions?.storeId,
          orderDate:   o.orderDate,
          deliverBy:   o.requestedShippingService,
          items:       o.items?.length || 0
        })),
        stores_by_shipments: byStore,
        stores: stores.map(s => ({
          id:          String(s.storeId),
          name:        s.storeName,
          marketplace: s.marketplaceName,
          active:      s.active
        }))
      })
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message })
    };
  }
};
