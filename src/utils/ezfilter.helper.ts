import { BuildQueryFilter, type FilteringQuery } from "@nodewave/prisma-ezfilter";
import type { Context } from "hono";

export function parseQueryParams(c: Context): FilteringQuery {
  const query = c.req.query();

  let filters: Record<string, any> | undefined;
  if (query.filters) {
    try {
      filters = typeof query.filters === "string" ? JSON.parse(query.filters) : query.filters;
    } catch {
      filters = undefined;
    }
  }

  let searchFilters: Record<string, any> | undefined;
  if (query.searchFilters) {
    try {
      searchFilters =
        typeof query.searchFilters === "string"
          ? JSON.parse(query.searchFilters)
          : query.searchFilters;
    } catch {
      searchFilters = undefined;
    }
  }

  let rangedFilters: any[] | undefined;
  if (query.rangedFilters) {
    try {
      rangedFilters =
        typeof query.rangedFilters === "string"
          ? JSON.parse(query.rangedFilters)
          : query.rangedFilters;
    } catch {
      rangedFilters = undefined;
    }
  }

  const page = query.page ? Math.max(1, parseInt(query.page, 10)) : 1;
  const rows = query.rows ? Math.min(100, Math.max(1, parseInt(query.rows, 10))) : 20;
  const orderKey = query.orderKey || "createdAt";
  const orderRule = (query.orderRule?.toLowerCase() === "asc" ? "asc" : "desc") as "asc" | "desc";

  return {
    filters,
    searchFilters,
    rangedFilters,
    page,
    rows,
    orderKey,
    orderRule,
  };
}

export function buildPrismaQuery(filteringQuery: FilteringQuery) {
  const builder = new BuildQueryFilter();
  const built = builder.build(filteringQuery);
  return built.query;
}
