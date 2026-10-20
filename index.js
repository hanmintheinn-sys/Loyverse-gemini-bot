import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const LOYVERSE_TOKEN = process.env.LOYVERSE_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

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

    const itemsData = await itemsRes.json();
    const inventoryData = await inventoryRes.json();

    const items = itemsData.items || [];
    const inventory = inventoryData.inventory || [];

    return items.map((item) => {
      const stockInfo = inventory.find((inv) => inv.item_id === item.id);
      return {
        id: item.id,
        name: item.item_name,
        price: item.variants?.[0]?.default_price || "0",
        sku: item.variants?.[0]?.sku || "",
        in_stock: stockInfo ? stockInfo.in_stock : 0,
      };
    });
  } catch (error) {
    console.error("Loyverse Fetch Error:", error);
    return [];
  }
}

const checkStockTool = {
  name: "checkStoreInventory",
  description: "ဆိုင်ရှိ ပစ္စည်းအမည်များ၊ ဈေးနှုန်းများနှင့် လက်ကျန် Stock အရေအတွက်ကို စစ်ဆေးပေးသည်။",
  parameters: {
    type: Type.OBJECT,
    properties: {
      searchQuery: {
        type: Type.STRING,
        description: "Customer ရှာဖွေလိုသော ပစ္စည်းအမည်",
      },
    },
  },
};

app.get("/", (req, res) => {
  res.send({ status: "online", message: "Loyverse Customer Service API is running." });
});

app.post("/api/chat", async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message is required." });
  }

  try {
    const systemInstruction = `
သင်သည် ဆိုင်၏ အွန်လိုင်းအရောင်းနှင့် Customer Service တာဝန်ခံ ဖြစ်သည်။
- Customer များ မေးမြန်းလာပါက 'checkStoreInventory' tool ကို အသုံးပြု၍ လက်ကျန်နှင့် ဈေးနှုန်းကို အမြဲတမ်း စစ်ဆေးပြီးမှသာ အဖြေပေးပါ။
- စာရင်းထဲတွင် မရှိသော ပစ္စည်းများ သို့မဟုတ် ဆိုင်နှင့် လုံးဝမသက်ဆိုင်သော အကြောင်းအရာများကို ယဉ်ကျေးစွာ ငြင်းပယ်ပါ။
- အဖြေများကို မြန်မာဘာသာဖြင့် ယဉ်ကျေးသိမ်မွေ့စွာ ရှင်းလင်းစွာ ဖြေကြားပါ။
`;

    let response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: message,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: [checkStockTool] }],
      },
    });

    const functionCalls = response.functionCalls;
    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      if (call.name === "checkStoreInventory") {
        const storeItems = await fetchLoyverseData();

        response = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [
            { role: "user", parts: [{ text: message }] },
            { role: "model", parts: [{ functionCall: call }] },
            {
              role: "user",
              parts: [
                {
                  functionResponse: {
                    name: "checkStoreInventory",
                    response: { items: storeItems },
                  },
                },
              ],
            },
          ],
          config: { systemInstruction },
        });
      }
    }

    res.json({ reply: response.text });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({ error: "အချက်အလက် တွက်ချက်ရာတွင် အမှားအယွင်း ဖြစ်ပေါ်နေပါသည်။" });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
