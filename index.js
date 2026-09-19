const express = require("express");
const crypto = require("crypto");

// ---- Config (set these as env vars on Render) ----
const {
  VERIFY_TOKEN, // any string you choose
  WHATSAPP_TOKEN, // Meta access token
  PHONE_NUMBER_ID, // from Meta API Setup page
  GEMINI_API_KEY, // from aistudio.google.com
  APP_SECRET, // optional: verifies requests come from Meta
} = process.env;

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are a helpful WhatsApp assistant. Keep replies short and friendly.";
const PORT = process.env.PORT || 3000;

for (const key of ["VERIFY_TOKEN", "WHATSAPP_TOKEN", "PHONE_NUMBER_ID", "GEMINI_API_KEY"]) {
  if (!process.env[key]) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
}

const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf; // needed for signature check
    },
  })
);

// ---- In-memory state (fine for testing; resets on restart) ----
const history = new Map(); // per-user chat history
const seenIds = new Set(); // dedupe Meta's webhook retries

function markSeen(id) {
  if (seenIds.has(id)) return false;
  seenIds.add(id);
  if (seenIds.size > 500) seenIds.delete(seenIds.values().next().value);
  return true;
}

async function askGemini(userId, text) {
  const chat = [...(history.get(userId) || []), { role: "user", parts: [{ text }] }];

  // Gemini wants history to start with a "user" turn
  const contents = chat.slice(-10);
  while (contents.length && contents[0].role !== "user") contents.shift();

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!reply) throw new Error("Gemini returned no text");

  // only save the exchange if it succeeded
  history.set(userId, [...chat, { role: "model", parts: [{ text: reply }] }].slice(-10));
  return reply;
}

async function sendWhatsApp(to, body) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: body.slice(0, 4000) },
    }),
  });
  if (!res.ok) console.error("WhatsApp send failed:", res.status, await res.text());
}

async function handleMessage(msg) {
  if (!markSeen(msg.id)) return;

  const sender = msg.from;
  if (msg.type !== "text") {
    return sendWhatsApp(sender, "I can only read text messages for now 🙂");
  }

  const text = msg.text.body;
  console.log(`From ${sender}: ${text}`);

  let reply;
  try {
    reply = await askGemini(sender, text);
  } catch (err) {
    console.error("Gemini error:", err.message);
    reply = "Sorry, something went wrong. Try again in a bit.";
  }
  await sendWhatsApp(sender, reply);
}

// ---- Routes ----
app.get("/", (_req, res) => res.send("ok"));

// Meta calls this once when you set up the webhook
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  if (APP_SECRET) {
    const sig = req.get("X-Hub-Signature-256") || "";
    const expected =
      "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody || "").digest("hex");
    const ok =
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!ok) return res.sendStatus(403);
  }

  // return 200 to Meta fast, process in background
  res.sendStatus(200);

  for (const entry of req.body?.entry || []) {
    for (const change of entry.changes || []) {
      for (const msg of change.value?.messages || []) {
        handleMessage(msg).catch((err) => console.error("handleMessage error:", err));
      }
    }
  }
});

app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
