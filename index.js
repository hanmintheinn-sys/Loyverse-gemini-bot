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

// Customer စကားဝိုင်းများနှင့် အော်ဒါစာရင်းများကို သိမ်းဆည်းရန်
const chatSessions = new Map();
const ordersList = [];

// Google Server လိုင်းကျပ်ပါက အလိုအလျောက် ပြန်ကြိုးစားပေးမည့် Function
async function sendWithRetry(chat, content, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await chat.sendMessage(content);
    } catch (err) {
      const isBusy =
        err.message?.includes("503") ||
        err.message?.includes("high demand") ||
        err.message?.includes("overloaded") ||
        err.message?.includes("429");
      if (isBusy && attempt < maxRetries) {
        console.log(`Server busy. Retrying (${attempt}/${maxRetries})...`);
        await new Promise((resolve) => setTimeout(resolve, 2500 * attempt));
      } else {
        throw err;
      }
    }
  }
}

// Loyverse POS မှ ပစ္စည်းနှင့် လက်ကျန်စာရင်း ဆွဲယူခြင်း
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
    throw new Error(`Loyverse API Error: ${itemsRes.status}`);
  }

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
        item_id: item.id,
        variant_id: variant.variant_id,
        name: variantLabel,
        price: variant.default_price ?? 0,
        sku: variant.sku || "",
        in_stock: stockInfo ? (stockInfo.in_stock ?? 0) : 0,
      });
    }
  }

  return formattedItems;
}

// Gemini အသုံးပြုမည့် Tools များ (Stock စစ်ရန် နှင့် Order မှတ်ရန်)
const shopTools = {
  functionDeclarations: [
    {
      name: "checkStoreInventory",
      description: "ဆိုင်ရှိ ပစ္စည်းအမည်များ၊ ဈေးနှုန်းများနှင့် လက်ကျန် Stock အရေအတွက်ကို စစ်ဆေးပေးသည်။",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          searchQuery: {
            type: SchemaType.STRING,
            description: "Customer မေးမြန်းသော ပစ္စည်းအမည် သို့မဟုတ် 'all'",
          },
        },
      },
    },
    {
      name: "createCustomerOrder",
      description: "Customer ဝယ်ယူမည့် ပစ္စည်းအော်ဒါစာရင်း (Order List) ကို မှတ်သားပြီး ဘောင်ချာထုတ်ပေးသည်။",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          customerName: {
            type: SchemaType.STRING,
            description: "Customer ၏ အမည်",
          },
          phone: {
            type: SchemaType.STRING,
            description: "Customer ၏ ဖုန်းနံပါတ်",
          },
          address: {
            type: SchemaType.STRING,
            description: "ပို့ဆောင်ရမည့် လိပ်စာ",
          },
          items: {
            type: SchemaType.ARRAY,
            description: "ဝယ်ယူမည့် ပစ္စည်းများ စာရင်း",
            items: {
              type: SchemaType.OBJECT,
              properties: {
                name: { type: SchemaType.STRING, description: "ပစ္စည်းအမည်" },
                quantity: { type: SchemaType.NUMBER, description: "အရေအတွက်" },
                unitPrice: { type: SchemaType.NUMBER, description: "တစ်ခုချင်းဈေးနှုန်း" },
              },
              required: ["name", "quantity", "unitPrice"],
            },
          },
          note: {
            type: SchemaType.STRING,
            description: "အထူးမှာကြားချက် (ရှိပါက)",
          },
        },
        required: ["customerName", "phone", "address", "items"],
      },
    },
    {
      name: "getOrdersList",
      description: "မှတ်သားထားသော အော်ဒါစာရင်းများကို ပြန်လည်ကြည့်ရှုပေးသည်။",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          phone: {
            type: SchemaType.STRING,
            description: "Customer ဖုန်းနံပါတ်ဖြင့် ရှာဖွေရန် (မထည့်ပါက အားလုံးပြမည်)",
          },
        },
      },
    },
  ],
};

// မင်မင် Persona နှင့် စည်းကမ်းချက်များ
const systemInstruction = `
သင်သည် ဆိုင်၏ အွန်လိုင်းအရောင်းနှင့် Customer Service တာဝန်ခံ "မင်မင်" ဖြစ်သည်။

လိုက်နာရမည့် စကားပြောပုံစံနှင့် စည်းကမ်းချက်များ -
၁။ မိမိကိုယ်ကို အမြဲတမ်း "မင်မင်" ဟု သုံးနှုန်းပါ။
၂။ စကားပြောရာတွင် အလွန်ယဉ်ကျေးချိုသာစွာဖြင့် "ပါတယ်ရှင့်"၊ "ပါမယ်ရှင့်"၊ "ဟုတ်တယ်ရှင့်"၊ "ဟုတ်ကဲ့ရှင့်"၊ "ကျေးဇူးပါရှင့်" စသည့် အသုံးအနှုန်းများကို သဘာဝကျကျ အသုံးပြုပါ။
၃။ Customer က ပစ္စည်း သို့မဟုတ် ဈေးနှုန်း မေးမြန်းလာပါက 'checkStoreInventory' tool ကို အသုံးပြု၍ Loyverse စာရင်းကို အရင်စစ်ဆေးပြီးမှ အတိအကျ ဖြေကြားပေးပါ။
၄။ Customer က ပစ္စည်းဝယ်ယူလိုကြောင်း (အော်ဒါတင်လိုကြောင်း) ပြောပါက အော်ဒါမှတ်ရန်အတွက် (၁) အမည်၊ (၂) ဖုန်းနံပါတ်၊ (၃) ပို့ဆောင်ရမည့် လိပ်စာ နှင့် (၄) ဝယ်ယူမည့် ပစ္စည်းအရေအတွက် တို့ကို ယဉ်ကျေးစွာ တောင်းခံပါ။
၅။ အချက်အလက် စုံလင်ပါက 'createCustomerOrder' tool ကို ခေါ်၍ အော်ဒါစာရင်းသွင်းပြီး၊ Customer ဖတ်ရှုရလွယ်ကူစေရန် အော်ဒါနံပါတ်၊ ပစ္စည်းစာရင်း၊ အရေအတွက်နှင့် စုစုပေါင်းကျသင့်ငွေ (Order Summary List) ကို သပ်ရပ်စွာ ထုတ်ပြပေးပါ။
၆။ ဆိုင်နှင့် လုံးဝမသက်ဆိုင်သော အကြောင်းအရာများ မေးမြန်းလာပါက "မင်မင်က ဆိုင်ရဲ့ အရောင်းနဲ့ ပစ္စည်းစာရင်းလေးတွေပဲ ဖြေကြားပေးနိုင်လို့ပါရှင့်၊ ဆိုင်က ပစ္စည်းလေးတွေ သိချင်တာရှိရင် မင်မင့်ကို မေးလို့ရပါတယ်ရှင့်" ဟုသာ ယဉ်ကျေးစွာ ပြန်ဖြေပါ။
`;

// Server Health Check
app.get("/", (req, res) => {
  res.json({
    status: "online",
    botName: "မင်မင် (Loyverse AI Customer Service)",
    totalOrdersRecorded: ordersList.length,
    loyverseTokenLoaded: Boolean(LOYVERSE_TOKEN),
    geminiKeyLoaded: Boolean(GEMINI_API_KEY),
  });
});

// ဆိုင်ရှင်မှ အော်ဒါစာရင်းအားလုံးကို တိုက်ရိုက်ကြည့်ရန် Endpoint
app.get("/api/orders", (req, res) => {
  res.json({
    totalOrders: ordersList.length,
    orders: ordersList,
  });
});

// Chat စကားဝိုင်း အသစ်ပြန်စရန် Endpoint
app.post("/api/chat/reset", (req, res) => {
  const { userId = "default_user" } = req.body;
  chatSessions.delete(userId);
  res.json({ message: "Chat session reset အောင်မြင်ပါတယ်ရှင့်။" });
});

// Main Customer Service Chat Endpoint
app.post("/api/chat", async (req, res) => {
  const { message, userId = "default_user" } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message is required." });
  }

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: "gemini-3.8-flash",
      systemInstruction,
      tools: [shopTools],
    });

    // User တစ်ဦးချင်းစီအတွက် ရှေ့က ပြောခဲ့သော စကားဝိုင်းမှတ်ဉာဏ်ကို ထိန်းသိမ်းခြင်း
    const history = chatSessions.get(userId) || [];
    const chat = model.startChat({ history });

    let result = await sendWithRetry(chat, message);

    // Function Calling (Tool) များ ခေါ်ယူပါက အဆင့်ဆင့် တွက်ချက်ပေးခြင်း
    let loopCount = 0;
    while (result.response.functionCalls()?.length > 0 && loopCount < 3) {
      loopCount++;
      const call = result.response.functionCalls()[0];
      let toolResponseData = {};

      if (call.name === "checkStoreInventory") {
        const items = await fetchLoyverseData();
        toolResponseData = { items };
      } else if (call.name === "createCustomerOrder") {
        const args = call.args;
        const orderItems = (args.items || []).map((item) => ({
          name: item.name,
          quantity: Number(item.quantity) || 1,
          unitPrice: Number(item.unitPrice) || 0,
          subtotal: (Number(item.quantity) || 1) * (Number(item.unitPrice) || 0),
        }));

        const totalAmount = orderItems.reduce((sum, i) => sum + i.subtotal, 0);
        const newOrder = {
          orderId: `ORD-${String(ordersList.length + 1).padStart(4, "0")}`,
          customerName: args.customerName,
          phone: args.phone,
          address: args.address,
          items: orderItems,
          totalAmount,
          note: args.note || "",
          status: "Pending",
          createdAt: new Date().toISOString(),
        };

        ordersList.push(newOrder);
        toolResponseData = {
          success: true,
          message: "Order successfully recorded",
          order: newOrder,
        };
      } else if (call.name === "getOrdersList") {
        const phoneFilter = call.args?.phone;
        const filtered = phoneFilter
          ? ordersList.filter((o) => o.phone.includes(phoneFilter))
          : ordersList;
        toolResponseData = { orders: filtered };
      }

      result = await sendWithRetry(chat, [
        {
          functionResponse: {
            name: call.name,
            response: toolResponseData,
          },
        },
      ]);
    }

    // လက်ရှိ စကားဝိုင်းမှတ်ဉာဏ်ကို သိမ်းဆည်းခြင်း
    const updatedHistory = await chat.getHistory();
    chatSessions.set(userId, updatedHistory);

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
