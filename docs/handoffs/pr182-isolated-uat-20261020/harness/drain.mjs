import { readFileSync } from "node:fs";
import { sql, calls, sleep, text, webhook, cron } from "./drive.mjs";
const { g, id, batch } = JSON.parse(readFileSync(new URL("./inflight-state.json", import.meta.url), "utf8"));
for (let i = 0; i < 8 && !sql(`select state from slip_image_events where line_message_id='${id}'`).startsWith("failed_permanent"); i++) {
  sql(`update slip_image_events set next_retry_at = now() - interval '1 second' where line_message_id='${id}' and state='retry_pending' returning 1`);
  await cron("finalize-slip-batches");
}
await webhook([text(g, "จบสลิป")]);
for (let i = 0; i < 40 && sql(`select status from slip_batches where id='${batch}'`) !== "closing"; i++) await sleep(250);
sql(`update slip_batches set closing_at=closing_at - interval '30 seconds', last_image_at=last_image_at - interval '30 seconds' where id='${batch}' returning 1`);
await cron("finalize-slip-batches");
const push = calls().filter((c) => c.kind === "push" && c.to === g);
console.log(JSON.stringify({ image: sql(`select state||':'||attempts from slip_image_events where line_message_id='${id}'`), batch: sql(`select status from slip_batches where id='${batch}'`), pushes: push.length, notice: push[0]?.text?.split("\n").filter((l) => /ยังไม่|รับรูป/.test(l)).join(" | ") }));
