// import_bai_viet.js
import fs from "fs";
import axios from "axios";
import { MongoClient } from "mongodb";
import pLimit from "p-limit";
import cliProgress from "cli-progress";
import ora from "ora";
import { pipeline } from "@xenova/transformers";   // ✅ local embedding
import "dotenv/config";

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "rpa";
const API_BAI_VIET = process.env.API_BAI_VIET || "https://api.rpa4edu.shop/api_bai_viet.php";

const client = new MongoClient(MONGODB_URI);

// ===== Embedding helper (Local MiniLM-L6-v2) =====
let embedder = null;
async function initEmbedder() {
  if (!embedder) {
    console.log("⏳ Loading local embedding model (all-MiniLM-L6-v2)...");
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    console.log("✅ Model loaded");
  }
  return embedder;
}

async function embedBatch(texts) {
  const emb = await (await initEmbedder())(texts, { pooling: "mean", normalize: true });
  return texts.map((_, i) => Array.from(emb[i]));
}

// ===== Streaming fetch with spinner =====
async function fetchJsonStream(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const connectSpinner = ora(`📡 Connecting to ${url}`).start();
      const res = await axios.get(url, {
        responseType: "stream",
        timeout: 60000,
      });
      connectSpinner.succeed(`✔ 📡 Connected to ${url}`);

      let data = "";
      let size = 0;
      const startTime = Date.now();

      const spinner = ora("📥 Downloading...").start();
      const interval = setInterval(() => {
        const mb = (size / 1024 / 1024).toFixed(1);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? (size / 1024 / 1024 / elapsed).toFixed(1) : "0.0";
        spinner.text = `📥 Downloading... ${mb} MB | ${speed} MB/s`;
      }, 500);

      for await (const chunk of res.data) {
        size += chunk.length;
        data += chunk.toString("utf8");
      }

      clearInterval(interval);
      spinner.succeed("✔ 📥 Download complete");

      return JSON.parse(data);
    } catch (err) {
      console.error(`❌ Fetch error (attempt ${attempt}) from ${url}:`, err.message);
      if (attempt < retries) {
        console.log(`⏳ Retry in 5s...`);
        await new Promise((r) => setTimeout(r, 5000));
      } else {
        throw err;
      }
    }
  }
}

// ===== Deep equal (so sánh dữ liệu cũ - mới) =====
function isEqualExceptVector(a, b) {
  const ignore = new Set(["_id", "vector"]);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (ignore.has(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      return false;
    }
  }
  return true;
}

// ===== Import collection =====
async function importCollection(db, name, records, fields) {
  if (!records?.length) {
    console.warn(`⚠️ No data for collection "${name}"`);
    return;
  }

  const spinner = ora(`🔍 Checking existing docs in "${name}"...`).start();

  const existing = await db.collection(name).find({}, { projection: { _id: 0 } }).toArray();
  const existingMap = new Map(existing.map(x => [x._key, x]));

  spinner.succeed(`📊 ${records.length} total records to process in "${name}"`);

  const toProcess = [];
  for (const r of records) {
    const old = existingMap.get(r._key);
    if (!old) {
      toProcess.push({ item: r, reason: "new" });
    } else if (!isEqualExceptVector(old, r)) {
      toProcess.push({ item: { ...old, ...r }, reason: "update" });
    }
  }

  if (!toProcess.length) {
    console.log(`✔ "${name}" đã đầy đủ, skip.`);
    return;
  }

  console.log(`📦 ${toProcess.length} docs need insert/update in "${name}"...`);

  const contents = toProcess.map(({ item }) =>
    fields
      .map((f) => {
        const val = item[f];
        return Array.isArray(val) ? val.join(" ") : val || "";
      })
      .filter(Boolean)
      .join(" ")
  );

  const BATCH_SIZE = 25;
  let vectors = [];

  // 🟢 Bước 1: EMBEDDING
  const embedBar = new cliProgress.SingleBar(
    { format: `   → Embedding [{bar}] {percentage}% | {value}/{total}`, hideCursor: true, barsize: 30 },
    cliProgress.Presets.shades_classic
  );
  embedBar.start(contents.length, 0);

  for (let i = 0; i < contents.length; i += BATCH_SIZE) {
    const batch = contents.slice(i, i + BATCH_SIZE);
    const vecs = await embedBatch(batch);
    vectors.push(...vecs);
    embedBar.update(Math.min(i + batch.length, contents.length));
  }
  embedBar.stop();
  console.log("✔ Embedding finished (local MiniLM-L6-v2)");

  // 🟢 Bước 2: UPDATE DB
  const limit = pLimit(10);
  const updateBar = new cliProgress.SingleBar(
    { format: `   → Writing DB [{bar}] {percentage}% | {value}/{total}`, hideCursor: true, barsize: 30 },
    cliProgress.Presets.shades_classic
  );
  updateBar.start(toProcess.length, 0);

  let done = 0;
  await Promise.all(
    toProcess.map(({ item }, idx) =>
      limit(async () => {
        await db.collection(name).updateOne(
          { _key: item._key },
          { $set: { ...item, vector: vectors[idx] } },
          { upsert: true }
        );
        done++;
        updateBar.update(done);
      })
    )
  );
  updateBar.stop();
  console.log(`✔ Upserted ${toProcess.length} docs into "${name}"`);
}

// ===== Main =====
(async () => {
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    console.log(`✅ MongoDB connected (import_bai_viet.js) → DB: ${MONGODB_DB}`);

    const baiViet = await fetchJsonStream(API_BAI_VIET);
    console.log(`📊 Bài viết fetched: ${baiViet.length}`);

    await importCollection(
      db,
      "social",
      baiViet.map(b => ({
        ...b,
        _key: b.id_bai_viet?.toString() || b.url || "",
        author: b.id_nguoi_dung || "",
        text: b.noi_dung_bai_viet || "",
        summary: b.content || ""
      })),
      ["_key", "author", "text", "summary"]
    );

    console.log("🎯 Import finished (bài viết up-to-date with vectors).");
  } catch (err) {
    console.error("❌ Import failed:", err);
  } finally {
    await client.close();
    console.log("🔌 MongoDB connection closed");
  }
})();
