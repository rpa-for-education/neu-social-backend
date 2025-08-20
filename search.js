// backend/search.js
import { MongoClient } from "mongodb";
import { pipeline } from "@xenova/transformers";

const client = new MongoClient(process.env.MONGODB_URI);
const dbName = process.env.MONGODB_DB || "rpa";

let embedder = null;

// ===== Khởi tạo embedder local =====
export async function initEmbedding() {
  if (!embedder) {
    console.log("⏳ Loading local embedder (all-MiniLM-L6-v2)...");
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    console.log("✅ Embedder ready");
  }
  return embedder;
}

// ===== Hàm tạo vector cho query =====
async function embed(text) {
  const model = await initEmbedding();
  const output = await model(text || "", { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

// ===== Hàm tìm kiếm bài viết =====
export async function socialVectorSearch(query, topk = 5) {
  await client.connect();
  const db = client.db(dbName);

  const queryVector = await embed(query);

  const results = await db.collection("social").aggregate([
    {
      $vectorSearch: {
        index: "vector_index_social",   // 👈 tên index vector trong MongoDB Atlas
        path: "vector",
        queryVector,
        numCandidates: 100,
        limit: topk,
        similarity: "cosine",
      },
    },
    {
      $project: {
        vector: 0, // loại bỏ vector gốc cho nhẹ
        _key: 0,
        is_crawed: 0,
        is_deleted: 0,
        sentiment_result_lstm_cnn: 0,
        sentiment_result_phobert: 0,
        modified_time: 0,
        created: 0,
        inserted_time: 0,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ]).toArray();

  return results;
}
