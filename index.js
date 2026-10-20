import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const LOYVERSE_TOKEN = process.env.LOYVERSE_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Server Health Check
app.get("/", (req, res) => {
  res.json({
    status: "online",
    loyverseTokenLoaded: Boolean(LOYVERSE_TOKEN),
    geminiKeyLoaded: Boolean(GEMINI_API_KEY),
  });
});

// သင့် Key ဖြင့် အသုံးပြုနိုင်သော Model စာရင်းများကို ကြည့်ရှုသည့် Endpoint
app.get("/api/models", async (req, res) => {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function fetchLoyverseData() {
  const headers = {
    Authorization: `Bearer ${LOYVERSE_TOKEN}`,
    "Content-Type": "application/json",
  };

  const [itemsRes, inventoryRes] = await Promise.all([
    fetch("https://api.loyverse.com/v1.0/items", { headers }),
    fetch("https://api.loyverse.com/v1.0/inventory", { headers }),
  ]);

  if (!itemsRes.ok) {
    throw new Error(`Loyverse Items API Error: ${itemsRes.status} ${itemsRes.statusText}`);
  }

  const itemsData = await itemsRes.json();
  let inventory = [];
  if (inventoryRes.ok) {
    const invData = await inventoryRes.json();
    inventory = invData.inventory_levels || invData.inventory || [];
  }

  const items = itemsData.items || [];
  return items.map((item) => {
    const stockInfo = inventory.find((inv) => inv.item_id === item.id);
    return {
      id: item.id,
      name: item.item_name,
      price: item.variants?.[0]?.default_price || "0",
      sku: item.variants?.[0]?.sku || "",
      in_stock: stockInfo ? (stockInfo.in_stock ?? 0) : 0,
    };
  });
}

const checkStockTool = {
  functionDeclarations: [
    {
      name: "checkStoreInventory",
      description: "ဆိုင်ရှိ ပစ္စည်းအမည်များ၊ ဈေးနှုန်းများနှင့် လက်ကျန် Stock အရေအတွက်ကို စစ်ဆေးပေးသည်။",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          searchQuery: {
            type: SchemaType.STRING,
            description: "Customer ရှာဖွေလိုသော ပစ္စည်းအမည်",
          },
        },
      },
    },
  ],
};

app.post("/api/chat", async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message is required." });
  }

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const systemInstruction = `
သင်သည် ဆိုင်၏ အွန်လိုင်းအရောင်းနှင့် Customer Service တာဝန်ခံ ဖြစ်သည်။
- Customer များ မေးမြန်းလာပါက 'checkStoreInventory' tool ကို အသုံးပြု၍ လက်ကျန်နှင့် ဈေးနှုန်းကို စစ်ဆေးပြီးမှသာ အဖြေပေးပါ။
- စာရင်းထဲတွင် မရှိသော ပစ္စည်းများ သို့မဟုတ် ဆိုင်နှင့် လုံးဝမသက်ဆိုင်သော အကြောင်းအရာများကို ယဉ်ကျေးစွာ ငြင်းပယ်ပါ။
- အဖြေများကို မြန်မာဘာသာဖြင့် ယဉ်ကျေးသိမ်မွေ့စွာ ဖြေကြားပါ။
`;

    const model = genAI.getGenerativeModel({
      model: "gemini-3.8-flash",
      systemInstruction,
      tools: [checkStockTool],
    });

    const chat = model.startChat();
    let result = await chat.sendMessage(message);

    const calls = result.response.functionCalls();
    if (calls && calls.length > 0) {
      const call = calls[0];
      if (call.name === "checkStoreInventory") {
        const storeItems = await fetchLoyverseData();
        result = await chat.sendMessage([
          {
            functionResponse: {
              name: "checkStoreInventory",
              response: { items: storeItems },
            },
          },
        ]);
      }
    }

    res.json({ reply: result.response.text() });
  } catch (error) {
    console.error("API Error Trace:", error);
    res.status(500).json({
      error: error.message || "Unknown error occurred",
      details: error.toString(),
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
