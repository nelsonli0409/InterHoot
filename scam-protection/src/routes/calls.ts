
import { Router } from "express";

import {
  getAllCallSummaries,
  getCallSummary,
} from "../agent/callSummaries.js";

const router = Router();

// GET /calls
// Return all saved call summaries
router.get("/", (_req, res) => {
  const summaries = getAllCallSummaries();

  res.json(summaries);
});

// GET /calls/stats
// Return screening statistics
router.get("/stats", (_req, res) => {
  const summaries = getAllCallSummaries();

  const stats = {
    totalCalls: summaries.length,

    green: summaries.filter(
      (summary) => summary.verdict === "GREEN"
    ).length,

    yellow: summaries.filter(
      (summary) => summary.verdict === "YELLOW"
    ).length,

    red: summaries.filter(
      (summary) => summary.verdict === "RED"
    ).length,
  };

  res.json(stats);
});

// GET /calls/:callSid
// Return a specific call summary
router.get("/:callSid", (req, res) => {
  const callSid = String(req.params.callSid);

  const summary = getCallSummary(callSid);

  if (!summary) {
    res.status(404).json({
      error: "Call summary not found.",
    });
    return;
  }

  res.json(summary);
});

export default router;
