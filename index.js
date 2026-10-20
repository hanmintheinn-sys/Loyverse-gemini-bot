import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Telegraf } from "telegraf";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const LOYVERSE_TOKEN = process.env.LOYVERSE_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const chatSessions = new Map();
const ordersList = [];

async function fetchLoyverseData() {
  const headers = {
    Authorization: `Bearer ${LOYVERSE_TOKEN}`,
    "Content-Type": "application/json",
  };

  try {
    const [itemsRes, inventoryRes] = await Promise.all([
      fetch("https://api.loyverse.com/v1.0/items", { headers }),
      fetch("https://api.loyverse.com/v1.0/inventory", { headers }),
    ]);

    if (!itemsRes.ok) return [];

    const itemsData = await itemsRes.json();
    let inventory = [];
    if (inventoryRes.ok) {
      const invData = await inventoryRes.json();
      inventory = invData.inventory_levels || invData.inventory || [];
    }

    const items = itemsData.items || [];
    const formattedItems = [];

    for (const item of items) {
      const variants = item.variants || [];
      for (const variant of variants) {
        const stockInfo = inventory.find(
          (inv) => inv.variant_id === variant.variant_id || inv.item_id === item.id
        );
        const variantLabel = variant.option1_value
          ? `${item.item_name} (${variant.option1_value})`
          : item.item_name;

        formattedItems.push({
          name: variantLabel,
          price: variant.default_price ?? 0,
          sku: variant.sku || "",
          in_stock: stockInfo ? (stockInfo.in_stock ?? 0) : 0,
        });
      }
    }

    return formattedItems;
  } catch (err) {
    console.error("Loyverse Fetch Error:", err.message);
    return [];
  }
}

async function callGeminiAPI(systemText, contents, maxRetries = 3) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;

  const payload = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: contents,
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (response.ok) {
      return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    }

    const errMsg = data.error?.message || "Unknown Gemini API Error";
    const isBusy = response.status === 503 || response.status === 429 || errMsg.includes("high demand");

    if (isBusy && attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw new Error(`[${response.status}] ${errMsg}`);
  }
}

async function processAiChat(userId, message) {
  const storeItems = await fetchLoyverseData();
  const inventoryText =
    storeItems.length > 0
      ? JSON.stringify(storeItems, null, 2)
      : "လက်ရှိ ဆိုင်စာရင်းထဲတွင် ပစ္စည်း မရှိသေးပါ။";

  const systemPrompt = `
သင်သည် ဆိုင်၏ အွန်လိုင်းအရောင်းနှင့် Customer Service တာဝန်ခံ "မင်မင်" ဖြစ်သည်။

လိုက်နာရမည့် စကားပြောပုံစံနှင့် စည်းကမ်းချက်များ -
၁။ မိမိကိုယ်ကို အမြဲတမ်း "မင်မင်" ဟု သုံးနှုန်းပါ။
၂။ စကားပြောရာတွင် အလွန်ယဉ်ကျေးချိုသာစွာဖြင့် "ပါတယ်ရှင့်"၊ "ပါမယ်ရှင့်"၊ "ဟုတ်တယ်ရှင့်"၊ "ဟုတ်ကဲ့ရှင့်"၊ "ကျေးဇူးပါရှင့်" စသည့် အသုံးအနှုန်းများကို သဘာဝကျကျ အသုံးပြုပါ။
၃။ အောက်တွင် ပေးထားသော [လက်ရှိ Loyverse POS ပစ္စည်းစာရင်း] ကိုသာ အခြေခံ၍ ဈေးနှုန်းနှင့် လက်ကျန် (in_stock) ကို တိကျစွာ ဖြေကြားပါ။ စာရင်းထဲမပါသော ပစ္စည်းများကို မရှိကြောင်း ယဉ်ကျေးစွာ ပြောပါ။
၄။ Customer က ပစ္စည်းဝယ်ယူလိုကြောင်း (အော်ဒါတင်လိုကြောင်း) ပြောပါက အော်ဒါမှတ်ရန်အတွက် (၁) အမည်၊ (၂) ဖုန်းနံပါတ်၊ (၃) ပို့ဆောင်ရမည့် လိပ်စာ နှင့် (၄) ဝယ်ယူမည့် ပစ္စည်းအရေအတွက် တို့ကို ယဉ်ကျေးစွာ တောင်းခံပါ။
၅။ Customer ထံမှ အချက်အလက် အားလုံး စုံလင်သွားပါက ယဉ်ကျေးသော ဘောင်ချာ (Order Summary List) ကို ရေးပေးပြီး အောက်ဆုံးတွင် JSON format ကို ထုတ်ပေးပါ-
<ORDER_DATA>{"customerName":"အမည်","phone":"ဖုန်း","address":"လိပ်စာ","items":[{"name":"ပစ္စည်းအမည်","quantity":1,"unitPrice":1000}]}</ORDER_DATA>
၆။ ဆိုင်နှင့် မသက်ဆိုင်သော မေးခွန်းများကို မင်မင်က ဆိုင်ပစ္စည်းလေးတွေပဲ ဖြေပေးနိုင်ပါကြောင်း ယဉ်ကျေးစွာ ပြန်ဖြေပါ။

[လက်ရှိ Loyverse POS ပစ္စည်းစာရင်း]:
${inventoryText}
`;

  const history = chatSessions.get(userId) || [];
  const contents = [...history, { role: "user", parts: [{ text: message }] }];

  let replyText = await callGeminiAPI(systemPrompt, contents);
  let recordedOrder = null;

  const orderMatch = replyText.match(/<ORDER_DATA>([\s\S]*?)<\/ORDER_DATA>/);
  if (orderMatch) {
    try {
      const rawOrder = JSON.parse(orderMatch[1].trim());
      const orderItems = (rawOrder.items || []).map((i) => ({
        name: i.name,
        quantity: Number(i.quantity) || 1,
        unitPrice: Number(i.unitPrice) || 0,
        subtotal: (Number(i.quantity) || 1) * (Number(i.unitPrice) || 0),
      }));
      const totalAmount = orderItems.reduce((sum, i) => sum + i.subtotal, 0);

      recordedOrder = {
        orderId: `ORD-${String(ordersList.length + 1).padStart(4, "0")}`,
        customerName: rawOrder.customerName,
        phone: rawOrder.phone,
        address: rawOrder.address,
        items: orderItems,
        totalAmount,
        status: "Pending",
        createdAt: new Date().toISOString(),
      };
      ordersList.push(recordedOrder);
    } catch (e) {
      console.error("Order Parse Error:", e.message);
    }
    replyText = replyText.replace(/<ORDER_DATA>[\s\S]*?<\/ORDER_DATA>/, "").trim();
    if (recordedOrder) {
      replyText += `\n\n🧾 အော်ဒါနံပါတ်: ${recordedOrder.orderId}\n💰 စုစုပေါင်းကျသင့်ငွေ: ${recordedOrder.totalAmount.toLocaleString()} ကျပ်`;
    }
  }

  history.push({ role: "user", parts: [{ text: message }] });
  history.push({ role: "model", parts: [{ text: replyText }] });
  if (history.length > 20) history.splice(0, 2);
  chatSessions.set(userId, history);

  return { reply: replyText, orderCreated: recordedOrder };
}

app.get("/", (req, res) => {
  res.json({
    status: "online",
    botName: "မင်မင် (Loyverse AI Customer Service)",
    totalOrdersRecorded: ordersList.length,
    loyverseTokenLoaded: Boolean(LOYVERSE_TOKEN),
    geminiKeyLoaded: Boolean(GEMINI_API_KEY),
    telegramBotActive: Boolean(TELEGRAM_BOT_TOKEN),
  });
});

app.get("/api/orders", (req, res) => {
  res.json({ totalOrders: ordersList.length, orders: ordersList });
});

app.post("/api/chat", async (req, res) => {
  const { message, userId = "default_user" } = req.body;
  if (!message) return res.status(400).json({ error: "Message is required." });

  try {
    const result = await processAiChat(userId, message);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Telegram Bot Launch with Error Protection
if (TELEGRAM_BOT_TOKEN) {
  try {
    const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

    bot.start((ctx) => {
      ctx.reply("မင်္ဂလာပါရှင်! မင်မင်က ဆိုင်ရဲ့ အွန်လိုင်းအရောင်းကိုယ်စားလှယ် ဖြစ်ပါတယ်ရှင့်။ သိချင်တာလေးတွေ မေးလို့ရပါတယ်ရှင့်။");
    });

    bot.on("text", async (ctx) => {
      const userMessage = ctx.message.text;
      const userId = `tg_${ctx.from.id}`;

      try {
        await ctx.telegram.sendChatAction(ctx.chat.id, "typing");
        const result = await processAiChat(userId, userMessage);
        await ctx.reply(result.reply);
      } catch (err) {
        console.error("Telegram User Chat Error:", err.message);
        await ctx.reply("ဆာဗာနဲ့ ချိတ်ဆက်ရာမှာ အခက်အခဲ ရှိနေပါတယ်ရှင့်။");
      }
    });

    bot.launch().catch((err) => {
      console.error("Telegram launch error (non-fatal):", err.message);
    });

    console.log("Telegram Bot started safely.");
  } catch (err) {
    console.error("Failed to initialize Telegraf:", err.message);
  }
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
