import {
  BuildQueryFilter,
  type FilteringQuery,
  type PrismaOrderBy,
  type PrismaQueryOptions,
  type RangedFilter,
} from "@nodewave/prisma-ezfilter";
import { Department, Priority, TaskStatus } from "@prisma/client";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

export type QueryPolicy = "tasks" | "clientTasks" | "projects" | "audit" | "comments";
export interface ParsedFilteringQuery extends FilteringQuery {
  policy: QueryPolicy;
  page: number;
  rows: number;
  orderKey: string;
  orderRule: "asc" | "desc";
}
export type PrismaFilterQuery = Omit<PrismaQueryOptions, "orderBy"> & {
  orderBy: PrismaOrderBy[];
  skip: number;
  take: number;
};

const text = z.string().min(1).max(256);
const uuid = z.string().uuid();
const date = z.string().datetime({ offset: true });
const version = z.number().int().min(1).max(2147483647);
const taskFilters = {
  id: uuid,
  projectId: uuid,
  taskCode: text,
  status: z.nativeEnum(TaskStatus),
  priority: z.nativeEnum(Priority),
};
const taskSorts = [
  "id",
  "taskCode",
  "title",
  "status",
  "priority",
  "dueDate",
  "createdAt",
  "updatedAt",
];
const taskRanges = { createdAt: date, updatedAt: date, dueDate: date };

type PolicyDefinition = {
  filters: Record<string, z.ZodType>;
  search: readonly string[];
  ranges: Record<string, z.ZodType>;
  sorts: readonly string[];
  extraParams: readonly string[];
  defaultOrder: string;
  defaultRows: number;
};

const policies: Record<QueryPolicy, PolicyDefinition> = {
  tasks: {
    filters: {
      ...taskFilters,
      department: z.nativeEnum(Department),
      assigneeId: uuid,
      creatorId: uuid,
      isClientVisible: z.boolean(),
    },
    search: ["taskCode", "title", "description"],
    ranges: { ...taskRanges, version },
    sorts: [...taskSorts, "department", "version"],
    extraParams: ["projectId"],
    defaultOrder: "createdAt",
    defaultRows: 20,
  },
  clientTasks: {
    filters: taskFilters,
    search: ["taskCode", "title"],
    ranges: taskRanges,
    sorts: taskSorts,
    extraParams: ["projectId"],
    defaultOrder: "createdAt",
    defaultRows: 20,
  },
  projects: {
    filters: { id: uuid, key: z.string().min(2).max(10), name: text, clientId: uuid },
    search: ["key", "name"],
    ranges: { createdAt: date, updatedAt: date },
    sorts: ["id", "key", "name", "createdAt", "updatedAt"],
    extraParams: [],
    defaultOrder: "createdAt",
    defaultRows: 20,
  },
  audit: {
    filters: {
      id: uuid,
      projectId: uuid,
      taskId: uuid,
      userId: uuid,
      action: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
      changedColumn: z.string().min(1).max(64),
    },
    search: ["action", "changedColumn"],
    ranges: { timestamp: date },
    sorts: ["id", "timestamp", "action"],
    extraParams: ["projectId", "taskId"],
    defaultOrder: "timestamp",
    defaultRows: 25,
  },
  comments: {
    filters: { id: uuid, projectId: uuid, taskId: uuid, authorId: uuid },
    search: ["body"],
    ranges: { createdAt: date },
    sorts: ["id", "createdAt"],
    extraParams: ["projectId", "taskId"],
    defaultOrder: "createdAt",
    defaultRows: 20,
  },
};
const queryPolicies = ["tasks", "clientTasks", "projects", "audit", "comments"] as const;

function badQuery(message: string): never {
  throw new HTTPException(400, { message: `Invalid query: ${message}` });
}

function parseValue<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const result = schema.safeParse(value);
  if (!result.success) badQuery(`${field} has an unsupported field, type, or value.`);
  return result.data;
}

function jsonField(raw: string | undefined, field: string): unknown {
  if (raw === undefined) return undefined;
  if (Buffer.byteLength(raw, "utf8") > 8192) badQuery(`${field} exceeds 8192 bytes.`);
  try {
    return JSON.parse(raw);
  } catch {
    return badQuery(`${field} must be valid JSON.`);
  }
}

function validateMap(value: unknown, fields: Record<string, z.ZodType>, name: string) {
  if (value === undefined) return undefined;
  const map = parseValue(z.object(fields).partial().strict(), value, name);
  if (Object.keys(map).length > 20) badQuery(`${name} has too many fields.`);
  return map;
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
  max: number,
): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) badQuery(`${name} must be a positive integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) badQuery(`${name} exceeds ${max}.`);
  return value;
}

function validateQuery(query: FilteringQuery, policy: QueryPolicy): ParsedFilteringQuery {
  const definition = policies[policy];
  const filters = validateMap(query.filters, definition.filters, "filters");
  const searchFields = Object.fromEntries(definition.search.map((key) => [key, text]));
  const searchFilters = validateMap(query.searchFilters, searchFields, "searchFilters");
  const rangedFilters =
    query.rangedFilters === undefined
      ? undefined
      : parseValue(
          z
            .array(z.object({ key: z.string(), start: z.unknown(), end: z.unknown() }).strict())
            .max(10),
          query.rangedFilters,
          "rangedFilters",
        ).map((range) => {
          const schema = definition.ranges[range.key];
          if (!schema || !Object.hasOwn(definition.ranges, range.key))
            badQuery("Unsupported ranged field.");
          const start = parseValue(schema, range.start, `${range.key}.start`) as string | number;
          const end = parseValue(schema, range.end, `${range.key}.end`) as string | number;
          const low = typeof start === "number" ? start : Date.parse(start);
          const high = typeof end === "number" ? end : Date.parse(end);
          if (!Number.isFinite(low) || !Number.isFinite(high) || low > high)
            badQuery("Range start must not exceed end.");
          return { key: range.key, start, end } as RangedFilter;
        });

  const page = query.page ?? 1;
  const rows = query.rows ?? definition.defaultRows;
  if (!Number.isSafeInteger(page) || page < 1) badQuery("page must be a positive safe integer.");
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > 100)
    badQuery("rows must be between 1 and 100.");
  if ((page - 1) * rows > 100000) badQuery("Pagination offset exceeds 100000.");
  const orderKey = query.orderKey ?? definition.defaultOrder;
  const orderRule = query.orderRule ?? "desc";
  if (!definition.sorts.includes(orderKey)) badQuery("Unsupported orderKey.");
  if (orderRule !== "asc" && orderRule !== "desc") badQuery("orderRule must be asc or desc.");
  return { filters, searchFilters, rangedFilters, page, rows, orderKey, orderRule, policy };
}

export function parseQueryParams(c: Context, policy: QueryPolicy = "tasks"): ParsedFilteringQuery {
  const checkedPolicy = parseValue(z.enum(queryPolicies), policy, "policy");
  const definition = policies[checkedPolicy];
  const raw = c.req.query();
  const allowed = new Set([
    "filters",
    "searchFilters",
    "rangedFilters",
    "page",
    "rows",
    "orderKey",
    "orderRule",
    ...definition.extraParams,
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) badQuery(`Unsupported parameter ${key}.`);
  }
  for (const values of Object.values(c.req.queries())) {
    if (values.length !== 1) badQuery("Duplicate query parameters are not supported.");
  }
  for (const key of definition.extraParams) {
    if (raw[key] !== undefined) parseValue(uuid, raw[key], key);
  }
  return validateQuery(
    {
      filters: jsonField(raw.filters, "filters") as FilteringQuery["filters"],
      searchFilters: jsonField(
        raw.searchFilters,
        "searchFilters",
      ) as FilteringQuery["searchFilters"],
      rangedFilters: jsonField(raw.rangedFilters, "rangedFilters") as RangedFilter[] | undefined,
      page: positiveInteger(raw.page, 1, "page", 100001),
      rows: positiveInteger(raw.rows, definition.defaultRows, "rows", 100),
      orderKey: raw.orderKey,
      orderRule: raw.orderRule as FilteringQuery["orderRule"],
    },
    checkedPolicy,
  );
}

export function buildPrismaQuery(query: FilteringQuery): PrismaFilterQuery {
  const policy = parseValue(
    z.enum(queryPolicies),
    (query as Partial<ParsedFilteringQuery>).policy ?? "tasks",
    "policy",
  );
  const validated = validateQuery(query, policy);
  const definition = policies[policy];
  const builder = new BuildQueryFilter({
    allowedFields: [
      ...new Set([
        ...Object.keys(definition.filters),
        ...definition.search,
        ...Object.keys(definition.ranges),
        ...definition.sorts,
      ]),
    ],
    allowedRelations: [],
    maxPageSize: 100,
  });
  const built = builder.build(validated);
  if (!built.validation.isValid) badQuery("Query builder rejected the request.");
  const orderBy: PrismaOrderBy[] = [{ [validated.orderKey]: validated.orderRule }];
  if (validated.orderKey !== "id") orderBy.push({ id: validated.orderRule });
  return {
    ...built.query,
    orderBy,
    skip: (validated.page - 1) * validated.rows,
    take: validated.rows,
  };
}
