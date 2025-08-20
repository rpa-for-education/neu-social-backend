// app.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import { callLLM } from "./llm.js";
import { socialVectorSearch, initEmbedding } from "./search.js";

const app = express();
const PORT = process.env.PORT || 4000;
const DEFAULT_MODEL_ID = process.env.DEFAULT_MODEL_ID || "qwen-max";

// ===== Middleware =====
app.use(cors()); // ✅ Cho phép mọi origin gọi API
app.use(express.json({ limit: "10mb" }));

// Debug log middleware
app.use((req, res, next) => {
  console.log("📩 Request:", {
    method: req.method,
    url: req.url,
    body: req.body,
  });
  next();
});

// ===== Chuẩn hóa context =====
function buildPrompt(question, socials = []) {
  let context =
    "Bạn là trợ lý học thuật, trả lời ngắn gọn, có trích dẫn bài viết liên quan.\n\n";

  if (socials.length) {
    context += "Danh sách bài viết:\n";
    socials.slice(0, 10).forEach((s, i) => {
      context += `Bài viết ${i + 1}:
- Người đăng: ${s.id_nguoi_dung || "Không rõ"} 
- Thời gian: ${
        s.created_time && s.created_time !== "0000-00-00 00:00:00"
          ? s.created_time
          : s.inserted_time || "Không rõ"
      }
- Nội dung: ${s.noi_dung_bai_viet?.slice(0, 200) || "Không có"}...
- Lượt thích: ${s.like || 0}, Bình luận: ${s.comment || 0}, Chia sẻ: ${s.share || 0}
- Link: ${s.url || "Không có"}\n\n`;
    });
  } else {
    context += "Không tìm thấy bài viết phù hợp.\n\n";
  }

  context += `\nCâu hỏi: ${question}\n\nHãy trả lời bằng tiếng Việt hoặc ngôn ngữ của câu hỏi.`;
  return context;
}

// ===== Agent API =====
app.post("/api/agent", async (req, res) => {
  try {
    const { question, model_id = DEFAULT_MODEL_ID, topk = 5 } = req.body || {};
    if (!question?.trim()) {
      return res.status(400).json({ error: "Missing question" });
    }

    let socials = [];
    try {
      socials = await socialVectorSearch(question, Number(topk));
      console.log(`🔎 Found ${socials.length} socials from DB`);
    } catch (e) {
      console.error("❌ Social vector search failed:", e);
    }

    const prompt = buildPrompt(question, socials);

    let answerText = "";
    try {
      const resp = await callLLM(prompt, model_id);

      // 🔑 Ép kết quả thành string an toàn
      answerText =
        typeof resp === "string"
          ? resp
          : resp?.text || resp?.output || JSON.stringify(resp, null, 2);
    } catch (e) {
      console.error("❌ LLM call failed:", e);
      return res
        .status(500)
        .json({ error: "LLM call failed", details: e.message });
    }

    res.json({
      model_id,
      answer: answerText || "❌ Không có câu trả lời.",
      retrieved: { social: socials },
    });
  } catch (e) {
    console.error("❌ API /api/agent error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ===== Boot =====
if (!process.env.VERCEL) {
  app.listen(PORT, async () => {
    console.log(`➡️ API listening on http://localhost:${PORT}`);
    initEmbedding().catch((e) =>
      console.error("Embedding preload failed:", e.message)
    );
  });
}

export default app;
