import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Run agent watchdog every 30 seconds
crons.interval(
  "agent-watchdog",
  { seconds: 30 },
  internal.agentWatchdog.runWatchdog,
  {}
);

export default crons;
