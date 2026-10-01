import {
  BuildQueryFilter,
  type FilteringQuery,
  type RangedFilter,
} from "@nodewave/prisma-ezfilter";
import type { Context } from "hono";

type EzFilterMap = Record<string, unknown | unknown[] | null>;

function parseJsonField(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function parseQueryParams(c: Context): FilteringQuery {
  const query = c.req.query();

  const parsedFilters = parseJsonField(query.filters);
  const filters: EzFilterMap | undefined =
    parsedFilters !== undefined && typeof parsedFilters === "object"
      ? (parsedFilters as EzFilterMap)
      : undefined;

  const parsedSearch = parseJsonField(query.searchFilters);
  const searchFilters: EzFilterMap | undefined =
    parsedSearch !== undefined && typeof parsedSearch === "object"
      ? (parsedSearch as EzFilterMap)
      : undefined;

  const parsedRanged = parseJsonField(query.rangedFilters);
  const rangedFilters: RangedFilter[] | undefined = Array.isArray(parsedRanged)
    ? (parsedRanged as RangedFilter[])
    : undefined;

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
