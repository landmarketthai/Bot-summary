import { describe, expect, it } from "bun:test";
import { plainTextIngestDocument } from "@/lib/line/pending-session-finalizer";
import { validateProduceEntry } from "@/lib/produce/entry-validation";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import {
  RECOVER_LATEST_COMMAND,
  RECOVER_REFUSED_AFTER_CLOSE_PROVENANCE_REPLY,
  RECOVER_REFUSED_AMBIGUOUS_REPLY,
  RECOVER_REFUSED_NO_HEADER_REPLY,
  RECOVER_REFUSED_UNKEYED_REPLY,
  afterCloseProvenanceMismatch,
  boundaryRejectReply,
  clusterRecoverableEvents,
  durableRecoveryBundleKey,
  headerOpenedWithRetainedReply,
  headerProvenance,
  incompleteCloserReply,
  isCompleteHeaderProvenance,
  isExactRecoverLatestCommand,
  isIncompleteProduceCloser,
  recoverCommandReply,
  selectRecoveryBundle,
  type RecoverableDeferredEvent,
} from "@/lib/line/pending-produce-recovery";

function event(overrides: Partial<RecoverableDeferredEvent> & Pick<
  RecoverableDeferredEvent,
  "line_event_id" | "status"
>): RecoverableDeferredEvent {
  return {
    raw_message_id: `raw-${overrides.line_event_id}`,
    session_key: "group:group-1:user:user-1",
    source_id: "group-1",
    line_user_id: "user-1",
    line_timestamp_ms: 1_000,
    raw_text: "1.ทุเรียน100บาท",
    defer_reason: overrides.status,
    session_generation: null,
    opener_line_event_id: null,
    close_line_event_id: null,
    close_line_timestamp_ms: null,
    expires_at: new Date(Date.now() + 30_000).toISOString(),
    recovery_bundle_id: null,
    received_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("กู้รายการล่าสุด command", () => {
  it("matches only the exact trimmed command", () => {
    expect(isExactRecoverLatestCommand("กู้รายการล่าสุด")).toBe(true);
    expect(isExactRecoverLatestCommand("  กู้รายการล่าสุด \n")).toBe(true);
    expect(isExactRecoverLatestCommand("กู้รายการ")).toBe(false);
    expect(isExactRecoverLatestCommand("กู้รายการล่าสุดครับ")).toBe(false);
    expect(isExactRecoverLatestCommand("ขอกู้รายการล่าสุด")).toBe(false);
    expect(isExactRecoverLatestCommand("")).toBe(false);
  });
});

describe("incomplete Produce closer interceptor", () => {
  it("intercepts a proper prefix of a known closer", () => {
    expect(isIncompleteProduceCloser("จบราย")).toBe(true);
    expect(isIncompleteProduceCloser("จบรายการชั่งคื")).toBe(true);
  });

  it("does not reinterpret a complete closer or unrelated product text", () => {
    expect(isIncompleteProduceCloser("จบรายการ")).toBe(false);
    expect(isIncompleteProduceCloser("จบรายการชั่งคืน")).toBe(false);
    expect(isIncompleteProduceCloser("จบรายการเบิก")).toBe(false);
    expect(isIncompleteProduceCloser("จบรายการ 16 รายการ")).toBe(false);
    expect(isIncompleteProduceCloser("จบรายการผลไม้ที่เหลือในบ้าน")).toBe(false);
    expect(isIncompleteProduceCloser("1.ทุเรียน100บาท")).toBe(false);
    expect(isIncompleteProduceCloser("จบรายได้วันนี้")).toBe(false);
    expect(isIncompleteProduceCloser("จบงานกะเช้า")).toBe(false);
  });

  it("tells the operator the exact closer still needed", () => {
    const reply = incompleteCloserReply("ดำ-ราชพฤกษ์ ชั่งคืน 11/8/2569\n1.ทุเรียน100บาท\n2โล");
    expect(reply).toContain("คำสั่งปิดรายการไม่ครบ");
    expect(reply).toContain("ข้อมูลเดิมยังอยู่ครบ");
    expect(reply).toContain("จบรายการชั่งคืน");
    expect(reply).not.toContain("ยกเลิก");
  });
});

describe("rejected Produce bundle clustering", () => {
  it("groups only unexpired waiting rows as the live reorder window", () => {
    const bundles = clusterRecoverableEvents([
      event({ line_event_id: "a", status: "waiting", line_timestamp_ms: 1 }),
      event({
        line_event_id: "b",
        status: "waiting",
        line_timestamp_ms: 2,
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.key).toBe("waiting");
    expect(bundles[0]?.events.map((row) => row.line_event_id)).toEqual(["a"]);
  });

  it("hides rejected bundles from a prior Bangkok business day", () => {
    const now = Date.parse("2026-09-14T05:06:00.000Z");
    const stale = event({
      line_event_id: "stale-6", status: "rejected_after_close", close_line_event_id: "close-old",
      received_at: "2026-09-13T10:01:18.000Z",
    });
    expect(selectRecoveryBundle([stale], now)).toEqual({ kind: "none" });
    const fresh = event({
      line_event_id: "fresh", status: "rejected_after_close", close_line_event_id: "close-new",
      received_at: "2026-09-14T04:59:00.000Z",
    });
    expect(selectRecoveryBundle([fresh], now).kind).toBe("one");
  });

  it("keeps rejected evidence recoverable across midnight before the 04:00 cutoff", () => {
    const now = Date.parse("2026-09-14T20:30:00.000Z"); // 03:30 Bangkok on Sep 15
    const sameBusinessDay = event({
      line_event_id: "late-night", status: "rejected_after_close", close_line_event_id: "close-night",
      received_at: "2026-09-14T15:00:00.000Z", // 22:00 Bangkok on Sep 14
    });
    expect(selectRecoveryBundle([sameBusinessDay], now).kind).toBe("one");
  });

  it("separates before-opener episodes by opener_line_event_id", () => {
    const morning = event({
      line_event_id: "m1",
      status: "rejected_before_opener",
      opener_line_event_id: "opener-09",
      line_timestamp_ms: 9_000,
    });
    const afternoon = event({
      line_event_id: "a1",
      status: "rejected_before_opener",
      opener_line_event_id: "opener-14",
      line_timestamp_ms: 14_000,
    });
    expect(durableRecoveryBundleKey(morning)).toBe("before_opener:opener-09");
    expect(durableRecoveryBundleKey(afternoon)).toBe("before_opener:opener-14");
    expect(selectRecoveryBundle([morning, afternoon]).kind).toBe("ambiguous");
  });

  it("keeps after-close clusters separated by closer identity", () => {
    const bundles = clusterRecoverableEvents([
      event({
        line_event_id: "a",
        status: "rejected_after_close",
        close_line_event_id: "close-1",
      }),
      event({
        line_event_id: "b",
        status: "rejected_after_close",
        close_line_event_id: "close-2",
      }),
    ]);
    expect(selectRecoveryBundle(bundles.flatMap((bundle) => bundle.events)).kind)
      .toBe("ambiguous");
    expect(bundles.map((bundle) => bundle.key)).toEqual([
      "after_close:close-1",
      "after_close:close-2",
    ]);
  });

  it("does not merge two unkeyed orphan episodes into one recoverable bundle", () => {
    const selection = selectRecoveryBundle([
      event({ line_event_id: "morning-1", status: "rejected_orphan", line_timestamp_ms: 9_000 }),
      event({ line_event_id: "morning-2", status: "rejected_orphan", line_timestamp_ms: 9_001 }),
      event({ line_event_id: "afternoon-1", status: "rejected_orphan", line_timestamp_ms: 14_000 }),
    ]);
    expect(selection.kind).toBe("unkeyed");
    expect(clusterRecoverableEvents([
      event({ line_event_id: "morning-1", status: "rejected_orphan", line_timestamp_ms: 9_000 }),
      event({ line_event_id: "afternoon-1", status: "rejected_orphan", line_timestamp_ms: 14_000 }),
    ])).toEqual([]);
    expect(recoverCommandReply({ status: "unkeyed" })).toBe(RECOVER_REFUSED_UNKEYED_REPLY);
  });

  it("refuses a sole stale unkeyed orphan rather than treating it as latest", () => {
    const selection = selectRecoveryBundle([
      event({ line_event_id: "days-old", status: "rejected_orphan" }),
    ]);
    expect(selection.kind).toBe("unkeyed");
    expect(durableRecoveryBundleKey(event({
      line_event_id: "days-old",
      status: "rejected_orphan",
    }))).toBeNull();
  });

  it("refuses to guess when before-opener and after-close both exist", () => {
    const selection = selectRecoveryBundle([
      event({
        line_event_id: "a",
        status: "rejected_before_opener",
        opener_line_event_id: "opener-1",
      }),
      event({
        line_event_id: "b",
        status: "rejected_after_close",
        close_line_event_id: "close-1",
      }),
    ]);
    expect(selection.kind).toBe("ambiguous");
    expect(recoverCommandReply({ status: "ambiguous" }))
      .toBe(RECOVER_REFUSED_AMBIGUOUS_REPLY);
  });

  it("groups a genuine no-header burst by its durable recovery_bundle_id", () => {
    const selection = selectRecoveryBundle([
      event({
        line_event_id: "burst-1",
        status: "rejected_orphan",
        line_timestamp_ms: 9_000,
        recovery_bundle_id: "bundle-morning",
      }),
      event({
        line_event_id: "burst-2",
        status: "rejected_orphan",
        line_timestamp_ms: 9_001,
        recovery_bundle_id: "bundle-morning",
      }),
    ]);
    expect(selection.kind).toBe("one");
    expect(selection.kind === "one" && selection.bundle.key).toBe("orphan:bundle:bundle-morning");
    expect(selection.kind === "one" && selection.bundle.recoveryBundleId).toBe("bundle-morning");
    expect(selection.kind === "one" && selection.bundle.events.map((row) => row.line_event_id))
      .toEqual(["burst-1", "burst-2"]);
  });

  it("never merges a 09:00 bundle and a 14:00 bundle sharing the same session", () => {
    const morning = [
      event({
        line_event_id: "m1", status: "rejected_orphan",
        line_timestamp_ms: 9_000, recovery_bundle_id: "bundle-am",
      }),
      event({
        line_event_id: "m2", status: "rejected_orphan",
        line_timestamp_ms: 9_001, recovery_bundle_id: "bundle-am",
      }),
    ];
    const afternoon = [
      event({
        line_event_id: "a1", status: "rejected_orphan",
        line_timestamp_ms: 14_000, recovery_bundle_id: "bundle-pm",
      }),
      event({
        line_event_id: "a2", status: "rejected_orphan",
        line_timestamp_ms: 14_001, recovery_bundle_id: "bundle-pm",
      }),
    ];
    const bundles = clusterRecoverableEvents([...morning, ...afternoon]);
    expect(bundles).toHaveLength(2);
    expect(bundles.map((bundle) => bundle.key).sort()).toEqual([
      "orphan:bundle:bundle-am",
      "orphan:bundle:bundle-pm",
    ]);
    expect(selectRecoveryBundle([...morning, ...afternoon]).kind).toBe("ambiguous");
  });

  it("falls back to unkeyed when recovery_bundle_id is absent (pre-migration rows)", () => {
    const selection = selectRecoveryBundle([
      event({ line_event_id: "legacy-1", status: "rejected_orphan", line_timestamp_ms: 1 }),
      event({ line_event_id: "legacy-2", status: "rejected_orphan", line_timestamp_ms: 2 }),
    ]);
    expect(selection.kind).toBe("unkeyed");
  });

  it("recovers a keyed orphan only by explicit command", () => {
    const selection = selectRecoveryBundle([
      event({
        line_event_id: "orphan-1",
        status: "rejected_orphan",
        session_generation: "gen-1",
      }),
    ]);
    expect(selection.kind).toBe("one");
    expect(selection.kind === "one" && selection.bundle.key).toBe("orphan:gen:gen-1");
    const reply = boundaryRejectReply(1, "orphan");
    expect(reply).toContain("ไม่กู้ให้อัตโนมัติ");
    expect(reply).toContain(RECOVER_LATEST_COMMAND);
  });
});

describe("operator recovery copy", () => {
  it("answers what happened, how many, retained, and the next command", () => {
    const reply = boundaryRejectReply(16, "after_close");
    expect(reply).toContain("พบ 16 ข้อความที่ยังไม่ถูกบันทึก");
    expect(reply).toContain("หลังปิดรอบก่อนแล้ว");
    expect(reply).toContain("ข้อมูลเดิมยังเก็บไว้ ไม่ต้องพิมพ์ใหม่");
    expect(reply).toContain(RECOVER_LATEST_COMMAND);
    expect(reply).not.toContain("ยกเลิก");
  });

  it("does not tell the operator to retype after a valid header is open", () => {
    const reply = headerOpenedWithRetainedReply(12, "before_opener");
    expect(reply).toContain("เปิดหัวรายการแล้ว");
    expect(reply).toContain("พบ 12 ข้อความที่ยังเก็บไว้");
    expect(reply).toContain(RECOVER_LATEST_COMMAND);
    expect(recoverCommandReply({ status: "no_header" }))
      .toBe(RECOVER_REFUSED_NO_HEADER_REPLY);
  });
});

describe("plain-text ingest document after recovery", () => {
  const opener = { line_event_id: "opener-1", raw_text: "ดำ-ราชพฤกษ์ เบิก 11/8/2569" };
  const recoveredOlder = [
    { line_event_id: "rec-1", raw_text: "1.ทุเรียน100บาท\n2โล" },
    { line_event_id: "rec-2", raw_text: "2.มังคุด80บาท\n3โล" },
  ];
  const liveItems = [
    { line_event_id: "new-1", raw_text: "3.เงาะ70บาท\n4โล" },
  ];
  const closer = { line_event_id: "close-1", raw_text: "จบรายการเบิก" };

  it("leaves a normal non-recovery session in ledger order", () => {
    const rows = [opener, ...liveItems, closer];
    expect(plainTextIngestDocument("opener-1", rows))
      .toBe(rows.map((row) => row.raw_text).join("\n"));
  });

  it("keeps recovered older events after the opener without reordering them", () => {
    const document = plainTextIngestDocument("opener-1", [
      ...recoveredOlder,
      opener,
      ...liveItems,
      closer,
    ]);
    expect(document).toBe([
      opener.raw_text,
      recoveredOlder[0]?.raw_text,
      recoveredOlder[1]?.raw_text,
      liveItems[0]?.raw_text,
      closer.raw_text,
    ].join("\n"));
  });
});

describe("after-close header provenance", () => {
  it("refuses a known return bundle into a withdrawal header", () => {
    const origin = headerProvenance("ดำ-ราชพฤกษ์ ชั่งคืน 11/8/2569");
    const current = headerProvenance("ดำ-ราชพฤกษ์ เบิก 11/8/2569");
    expect(origin.type).toBe("คืน");
    expect(current.type).toBe("เบิก");
    expect(afterCloseProvenanceMismatch(origin, current)).toEqual(["type"]);
  });

  it("refuses seller, market, or date mismatch when those fields are known", () => {
    const origin = headerProvenance("ดำ-ราชพฤกษ์ เบิก 11/8/2569");
    expect(afterCloseProvenanceMismatch(
      origin,
      headerProvenance("แดง-ราชพฤกษ์ เบิก 11/8/2569"),
    )).toEqual(["staff"]);
    expect(afterCloseProvenanceMismatch(
      origin,
      headerProvenance("ดำ-ตลาดทดสอบ เบิก 11/8/2569"),
    )).toEqual(["market"]);
    expect(afterCloseProvenanceMismatch(
      origin,
      headerProvenance("ดำ-ราชพฤกษ์ เบิก 12/8/2569"),
    )).toEqual(["date"]);
  });

  it("does not invent type constraints for item-only evidence", () => {
    expect(headerProvenance("1.ทุเรียน100บาท\n2โล").type).toBeNull();
  });

  it("accepts identical provenance across every authoritative field", () => {
    const origin = headerProvenance("ดำ-ราชพฤกษ์ ชั่งคืน 11/8/2569");
    const current = headerProvenance("ดำ-ราชพฤกษ์ ชั่งคืน 11/8/2569");
    expect(isCompleteHeaderProvenance(origin)).toBe(true);
    expect(afterCloseProvenanceMismatch(origin, current)).toEqual([]);
  });

  it("treats a header that fails to parse a full origin as incomplete provenance", () => {
    expect(isCompleteHeaderProvenance(headerProvenance("1.ทุเรียน100บาท\n2โล"))).toBe(false);
    expect(isCompleteHeaderProvenance({
      type: "เบิก", staff: null, market: "ราชพฤกษ์", date: "2569-08-11",
    })).toBe(false);
  });

  it("refuses recovery outright when after-close provenance cannot be reconstructed", () => {
    expect(recoverCommandReply({ status: "missing_provenance" }))
      .toBe(RECOVER_REFUSED_AFTER_CLOSE_PROVENANCE_REPLY);
    expect(RECOVER_REFUSED_AFTER_CLOSE_PROVENANCE_REPLY).toBe([
      "พบรายการที่ส่งหลังปิดรอบเดิม",
      "แต่ระบบยืนยันข้อมูลรอบเดิมได้ไม่ครบ",
      "จึงไม่กู้รายการอัตโนมัติเพื่อป้องกันการผูกผิดตลาด/ผิดประเภท",
      "ข้อมูลเดิมยังเก็บไว้",
    ].join("\n"));
  });
});

describe("recovered items still use ordinary validation", () => {
  it("blocks a recovered unknown unit", () => {
    const parsed = parseWeighSession([
      "ดำ-ราชพฤกษ์ เบิก 11/8/2569",
      "1.ทุเรียน100บาท",
      "2 โลก",
      "จบรายการเบิก",
    ].join("\n"));
    const result = validateProduceEntry({
      parsed,
      roundRows: [],
      roundBound: false,
    });
    expect(result.blocking.some((row) => row.kind === "unknown_unit")).toBe(true);
  });

  it("blocks a recovered return in a unit that was not withdrawn", () => {
    const parsed = parseWeighSession([
      "ดำ-ราชพฤกษ์ ชั่งคืน 11/8/2569",
      "1.ทับทิม15บาท",
      "2กล่อง",
      "จบรายการชั่งคืน",
    ].join("\n"));
    const result = validateProduceEntry({
      parsed,
      roundBound: true,
      roundRows: [{
        product_name: "ทับทิม",
        unit: "ลูก",
        quantity: 10,
        price_per_unit: 15,
        transaction_type: "เบิก",
      }],
    });
    expect(result.blocking.some((row) => row.kind === "unit_not_withdrawn")).toBe(true);
  });

  it("blocks recovered return quantity that exceeds withdrawal", () => {
    const parsed = parseWeighSession([
      "ดำ-ราชพฤกษ์ ชั่งคืน 11/8/2569",
      "1.มังคุด45บาท",
      "20โล",
      "จบรายการชั่งคืน",
    ].join("\n"));
    const result = validateProduceEntry({
      parsed,
      roundBound: true,
      roundRows: [{
        product_name: "มังคุด",
        unit: "โล",
        quantity: 10,
        price_per_unit: 45,
        transaction_type: "เบิก",
      }],
    });
    expect(result.blocking.some((row) => row.kind === "return_exceeds_withdrawal")).toBe(true);
  });

  it("lets แก้ข้อ N correct a recovered typo", () => {
    const parsed = parseWeighSession([
      "กี้-ตลาดทดสอบ เบิก 24/8/2569",
      "1.อะโวคาโด้80บาท",
      "15โล",
      "แก้ข้อ 1",
      "1.อะโวคาโด80บาท",
      "16โล",
      "จบรายการเบิก",
    ].join("\n"));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.product_name).toBe("อะโวคาโด");
    expect(parsed.items[0]?.quantity).toBe(16);
  });

  it("lets ลบข้อ N remove one recovered item", () => {
    const parsed = parseWeighSession([
      "กี้-ตลาดทดสอบ เบิก 24/8/2569",
      "1.อะโวคาโด80บาท",
      "15โล",
      "2.มังคุด45บาท",
      "10โล",
      "ลบข้อ 1",
      "จบรายการเบิก",
    ].join("\n"));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.product_name).toBe("มังคุด");
  });

  it("keeps recovered items unchanged when a correction is invalid", () => {
    const parsed = parseWeighSession([
      "กี้-ตลาดทดสอบ เบิก 24/8/2569",
      "1.มังคุด45บาท",
      "10โล",
      "แก้ข้อ 1",
      "รายการนี้อ่านไม่ได้",
      "จบรายการเบิก",
    ].join("\n"));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({ product_name: "มังคุด", quantity: 10 });
  });
});
