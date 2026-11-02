/**
 * Test-only Supabase stubs for manual_slip_* tables.
 * White Sheet now loads closed manual slips into verifiedTransfers; mocks that
 * previously only stubbed AI slip tables must return empty (or fixture) rows.
 */

export type ManualSlipSessionStub = {
  id: string;
  market_label: string | null;
  /** Defaults to "closed" — the only status White Sheet counts. */
  status?: "open" | "closed";
  /** Omit unless the test is asserting the source_id filter. */
  source_id?: string;
  /** Omit unless the test is asserting the business_date filter. */
  business_date?: string;
};

export type ManualSlipEntryStub = {
  session_id: string;
  amount: number;
};

export function stubManualSlipTables(options?: {
  sessions?: ManualSlipSessionStub[];
  entries?: ManualSlipEntryStub[];
}): ((table: string) => unknown | null) {
  const sessions = options?.sessions ?? [];
  const entries = options?.entries ?? [];

  return (table: string) => {
    if (table === "manual_slip_sessions") {
      // Filters are applied for real: status/source_id/business_date scoping is
      // a business rule, so a stub that ignored .eq() would silently "pass"
      // tests for filters the query never actually applied.
      const filters: Array<[string, unknown]> = [];
      const matches = (session: ManualSlipSessionStub): boolean =>
        filters.every(([column, value]) => {
          if (column === "status") return (session.status ?? "closed") === value;
          const actual = (session as Record<string, unknown>)[column];
          // Unset => the fixture is not exercising this filter.
          return actual === undefined || actual === value;
        });

      const builder: {
        select: () => typeof builder;
        eq: (column: string, value: unknown) => typeof builder;
        is: (column: string, value: unknown) => typeof builder;
        then: (
          resolve: (value: unknown) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise<unknown>;
      } = {
        select: () => builder,
        eq: (column, value) => {
          filters.push([column, value]);
          return builder;
        },
        // Round-unbound White Sheet scopes filter accountability_round_id IS NULL.
        is: (column, value) => {
          filters.push([column, value]);
          return builder;
        },
        then: (resolve, reject) =>
          Promise.resolve({ data: sessions.filter(matches), error: null })
            .then(resolve, reject),
      };
      return builder;
    }
    if (table === "manual_slip_entries") {
      return {
        select: () => ({
          in: async (column: string, ids: string[]) => {
            // Reference-ownership lookup: stub entries carry no reference.
            if (column === "reference_id") return { data: [], error: null };
            if (column !== "session_id") {
              throw new Error(`unexpected manual_slip_entries filter: ${column}`);
            }
            const idSet = new Set(ids);
            return {
              data: entries.filter((e) => idSet.has(e.session_id)),
              error: null,
            };
          },
        }),
      };
    }
    if (table === "slip_check_approvals") return emptyApprovalTable();
    return null;
  };
}

/** No operator decisions: .select().in().eq() resolves to zero rows. */
export function emptyApprovalTable() {
  const builder = {
    select: () => builder,
    in: () => builder,
    eq: () => builder,
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve, reject),
  };
  return builder;
}
