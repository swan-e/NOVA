import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function test() {
  const { listUpcomingEvents, getWeekSummary, formatWeekDashboard } = await import("../src/tools/calendar.js");

  console.log("Testing personal Calendar — upcoming events...");
  try {
    const events = await listUpcomingEvents("personal", 5);
    console.log(events);
    console.log("\n✅ Personal Calendar working");
  } catch (err) {
    console.error("❌ Personal Calendar failed:", err);
  }

  console.log("\nTesting week summary dashboard...");
  try {
    const summary = await getWeekSummary("personal");
    const dashboard = formatWeekDashboard(summary, 40);
    console.log(dashboard);
    console.log("\n✅ Week dashboard working");
  } catch (err) {
    console.error("❌ Week dashboard failed:", err);
  }

  console.log("\nListing all calendars...");
  const { formatCalendarList } = await import("../src/tools/calendar.js");
  const calList = await formatCalendarList("personal");
  console.log(calList);
}

test();