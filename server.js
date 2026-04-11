import express from "express";

const app = express();
app.use(express.json());

const {
  MONDAY_API_KEY,
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
      Authorization: "Bearer " + MONDAY_API_KEY,
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
        column_values {
          id
          text
          value
        }
        parent_item {
          id
          name
          column_values {
            id
            text
            value
          }
        }
      }
    }
  `, { id: [String(subitemId)] });
  return data?.items?.[0];
}

function col(columns, id) {
  return columns?.find(c => c.id === id)?.text?.trim() || "";
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

  const title = subitem.name;

  const qty = parseInt(col(sc, "text") || "1", 10) || 1;
  const rawPrice = col(sc, "numbers") || "0";
  const price = parseFloat(rawPrice.replace(/[^0-9.]/g, "")).toFixed(2);

  const artworkTitle = subitem.name;
  const materialType = col(sc, "dropdown4");
  const sizeText = col(sc, "text52");
  const sizeNum = col(sc, "numbers4");
  const shape = col(sc, "dropdown0");
  const pattern = col(sc, "dropdown6");
  const finish = col(sc, "dropdown5");

  const notes = [
    `Artwork Title: ${artworkTitle}`,
    materialType ? `Material Type: ${materialType}` : null,
    (sizeText || sizeNum) ? `Size: ${sizeText} x ${sizeNum}` : null,
    shape ? `Shape: ${shape}` : null,
    pattern ? `Pattern: ${pattern}` : null,
    finish ? `Finish: ${finish}` : null,
  ].filter(Boolean).join("\n");

  const customerName = subitem.parent_item?.name || "";
  const nameParts = customerName.split(" ");
  const firstName = nameParts[0] || "";
  const lastName = nameParts.slice(1).join(" ") || "";
  const email = col(pc, "email7") || "";

  const customer = await findCustomer(email);

  return {
    draft_order: {
      line_items: [{
        title,
        quantity: qty,
        price,
      }],
      customer: customer ? { id: customer.id } : undefined,
      email: email || undefined,
      shipping_address: (!customer && firstName) ? {
        first_name: firstName,
        last_name: lastName,
      } : undefined,
      note: notes,
      note_attributes: [
        { name: "monday_subitem_id", value: String(subitem.id) },
        { name: "monday_parent", value: subitem.parent_item?.name || "" },
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

    console.log("[monday] Subitem name:", subitem.name);
    console.log("[monday] Columns:", JSON.stringify(subitem.column_values));

    const draftPayload = await buildDraftOrder(subitem);
    console.log("[shopify] Creating draft order:", JSON.stringify(draftPayload, null, 2));

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