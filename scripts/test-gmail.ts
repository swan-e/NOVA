import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function test() {
  const { fetchEmailBatch, formatBatchForTriage } = await import("../src/tools/gmail.js");

  console.log("Testing personal Gmail connection...");
  try {
    const batch = await fetchEmailBatch("personal", 5);
    console.log(formatBatchForTriage(batch));
    console.log("\n✅ Personal Gmail working");
  } catch (err) {
    console.error("❌ Personal Gmail failed:", err);
  }

  console.log("\nTesting work Gmail connection...");
  try {
    const batch = await fetchEmailBatch("work", 5);
    console.log(formatBatchForTriage(batch));
    console.log("\n✅ Work Gmail working");
  } catch (err) {
    console.error("❌ Work Gmail failed:", err);
  }
}

test();