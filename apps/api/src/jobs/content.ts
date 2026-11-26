import { processBrief } from "../services/content";
import { defineJob } from "./queue";

defineJob("content.brief", 4, async ({ briefId }) => {
  await processBrief(briefId);
});
