import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function test() {
  const { formatCategoryOptions, listTasks, formatTaskList } = await import("../src/tools/notion.js");

  console.log("Fetching category options...");
  try {
    const cats = await formatCategoryOptions("personal");
    console.log(cats);
    console.log("\n✅ Notion schema working");
  } catch (err) {
    console.error("❌ Failed:", err);
  }

  console.log("\nFetching incomplete tasks...");
  try {
    const tasks = await listTasks("personal", { showCompleted: false });
    console.log(formatTaskList(tasks));
    console.log("\n✅ Notion tasks working");
  } catch (err) {
    console.error("❌ Failed:", err);
  }
}

test();