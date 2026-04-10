import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());

const {
  MONDAY_API_KEY,
  MONDAY_SIGNING_SECRET,
  SHOPIFY_STORE,
  SHOPIFY_ACCESS_TOKEN,
  TRIGGER_STATUS,
  PORT = 3000,
} = process.env;

async function mondayQuery(query, variables = {}) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: MONDAY_API_KEY,
      "API-Version": "2024-01",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function shopifyPost(path, body) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getSubitem(subitemId) {
  const data = await mondayQuery(`
    query($id: [ID!]!) {
      items(ids: $id) {
        id
        name
        column_values { id title text value }
        parent_item {
          id
          name
          column_values { id title text }
        }
      }
    }
  `, { id: [String(subitemId)] });
  return data?.items?.[0];
}

function val(columns, titleOrId) {
  const t = titleOrId.toLowerCase();
  return columns?.find(c => c.title?.toLowerCase() === t || c.id?.toLowerCase() === t)?.text?.trim() || "";
}

async function findCustomer(email) {
  if (!email) return null;
  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2024-01/customers/search.json?query=email:${encodeURIComponent(email)}&limit=1`,
    { headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN } }
  );
  const json = await res.json();
  return json.customers?.[0] || null;
}

async function buildDraftOrder(subitem) {
  const sc = subitem.column_values;
  const pc = subitem.parent_item?.column_values;

  const title     = subitem.name;
  const qty       = parseInt(val(sc, "Quantity") || val(sc, "Qty") || "1", 10) || 1;
  const price     = val(sc, "Price") || val(sc, "Unit Price") || "0.00";
  const discount  = val(sc, "Discount") || "";
  const notes     = val(sc, "Notes") || val(sc, "Note") || "";
  const tags      = val(sc, "Tags") || val(sc, "Tag") || "";

  const email     = val(pc, "Email")      || val(sc, "Email") || "";
  const phone     = val(pc, "Phone")      || val(sc, "Phone") || "";
  const firstName = val(pc, "First Name") || val(sc, "First Name") || "";
  const lastName  = val(pc, "Last Name")  || val(sc, "Last Name") || "";
  const address1  = val(pc, "Address")    || val(sc, "Address") || "";
  const city      = val(pc, "City")       || val(sc, "City") || "";
  const province  = val(pc, "State")      || val(sc, "State") || "";
  const zip       = val(pc, "Zip")        || val(sc, "Zip") || "";
  const country   = val(pc, "Country")    || val(sc, "Country") || "US";

  const customer = await findCustomer(email);

  const address = { first_name: firstName, last_name: lastName, address1, city, province, zip, country, phone };

  const appliedDiscount = discount ? {
    value_type: discount.includes("%") ? "percentage" : "fixed_amount",
    value: parseFloat(discount.replace(/[^0-9.]/g, "")),
    title: "Monday Discount",
  } : undefined;

  return {
    draft_order: {
      line_items: [{
        title,
        quantity: qty,
        price: parseFloat(price.replace(/[^0-9.]/g, "")).toFixed(2),
        applied_discount: appliedDiscount,
      }],
      shipping_address: address.address1 ? address : undefined,
      billing_address:  address.address1 ? address : undefined,
      customer: customer ? { id: customer.id } : undefined,
      email:    email || undefined,
      phone:    phone || undefined,
      note:     notes || undefined,
      tags:     tags || undefined,
      note_attributes: [
        { name: "monday_item_id", value: String(subitem.id) },
        { name: "monday_parent",  value: subitem.parent_item?.name || "" },
      ],
    },
  };
}

app.post("/webhook", async (req, res) => {
  if (req.body?.challenge) return res.json({ challenge: req.body.challenge });

  const event = req.body?.event;
  if (!event) return res.status(400).json({ error: "No event" });

  const { pulseId, value: newValue } = event;

  if (TRIGGER_STATUS) {
    let statusLabel = "";
    try {
      statusLabel = typeof newValue === "string"
        ? JSON.parse(newValue)?.label?.text
        : newValue?.label?.text;
    } catch {}
    if (statusLabel !== TRIGGER_STATUS) {
      return res.json({ skipped: true, reason: "Status not matching trigger" });
    }
  }

  console.log(`[webhook] Triggered for subitem ${pulseId}`);

  try {
    const subitem = await getSubitem(pulseId);
    if (!subitem) throw new Error(`Subitem ${pulseId} not found`);

    const draftPayload = await buildDraftOrder(subitem);
    console.log("[shopify] Creating draft order...");

    const result = await shopifyPost("/draft_orders.json", draftPayload);
    if (result.errors || result.error) throw new Error(JSON.stringify(result.errors || result.error));

    const draft = result.draft_order;
    console.log(`[shopify] Draft order created: #${draft.id}`);
    res.json({ success: true, draft_order_id: draft.id });
  } catch (err) {
    console.error("[error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));