import { canViewInvestigations } from '@royal-home/shared';
import { Prisma, type ErrorLog } from '../generated/prisma/client.js';
import { prisma } from '../db.js';
import { visibleSystemErrorWhere } from './investigationOperations.js';
import { publicBackgroundJobSql } from './backgroundJobPrivacy.js';

const fields = new Set(['id', 'source', 'message', 'stack', 'url', 'agentId', 'userAgent', 'createdAt', 'resolvedAt', 'resolvedById', 'dedupKey']);
function column(field: string): Prisma.Sql {
  if (!fields.has(field)) throw new Error('Unsupported ErrorLog field');
  return Prisma.raw(`"ErrorLog"."${field}"`);
}
function join(parts: Prisma.Sql[], operator: 'AND' | 'OR'): Prisma.Sql {
  return parts.length ? Prisma.sql`(${Prisma.join(parts, ` ${operator} `)})` : Prisma.raw(operator === 'AND' ? 'TRUE' : 'FALSE');
}
/** Restricted internal query vocabulary, not a client-supplied SQL/ORM interface.
 * Unknown columns/operators fail closed; every value remains a bound parameter. */
export function errorLogWhereSql(where: Prisma.ErrorLogWhereInput = {}): Prisma.Sql {
  const nested = (value: unknown): Prisma.Sql => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) throw new Error('Unsupported ErrorLog condition');
    return errorLogWhereSql(value as Prisma.ErrorLogWhereInput);
  };
  return join(Object.entries(where).filter(([, value]) => value !== undefined).map(([field, value]) => {
    if (field === 'AND' || field === 'OR') return join((Array.isArray(value) ? value : [value]).map(nested), field);
    if (field === 'NOT') return join((Array.isArray(value) ? value : [value]).map(item => Prisma.sql`NOT (${nested(item)})`), 'AND');
    const c = column(field);
    if (value === null) return Prisma.sql`${c} IS NULL`;
    if (typeof value !== 'object' || value instanceof Date) return Prisma.sql`${c} = ${value}`;
    const filter = value as Record<string, unknown>;
    return join(Object.entries(filter).filter(([op, v]) => op !== 'mode' && v !== undefined).map(([op, v]) => {
      if (op === 'equals') return v === null ? Prisma.sql`${c} IS NULL` : Prisma.sql`${c} = ${v}`;
      if (op === 'not') return v === null ? Prisma.sql`${c} IS NOT NULL` : Prisma.sql`NOT (${errorLogWhereSql({ [field]: v })})`;
      if (op === 'in' || op === 'notIn') {
        if (!Array.isArray(v)) throw new Error('Unsupported ErrorLog list');
        if (!v.length) return Prisma.raw(op === 'in' ? 'FALSE' : 'TRUE');
        return op === 'in' ? Prisma.sql`${c} IN (${Prisma.join(v)})` : Prisma.sql`${c} NOT IN (${Prisma.join(v)})`;
      }
      if (op === 'gte') return Prisma.sql`${c} >= ${v}`;
      if (op === 'gt') return Prisma.sql`${c} > ${v}`;
      if (op === 'lte') return Prisma.sql`${c} <= ${v}`;
      if (op === 'lt') return Prisma.sql`${c} < ${v}`;
      if (op === 'contains' || op === 'startsWith' || op === 'endsWith') {
        if (typeof v !== 'string') throw new Error('Unsupported ErrorLog text');
        const escaped = v.replace(/[\\%_]/g, '\\$&');
        const pattern = `${op !== 'startsWith' ? '%' : ''}${escaped}${op !== 'endsWith' ? '%' : ''}`;
        return filter.mode === 'insensitive' ? Prisma.sql`${c} ILIKE ${pattern}` : Prisma.sql`${c} LIKE ${pattern}`;
      }
      throw new Error(`Unsupported ErrorLog operator: ${op}`);
    }), 'AND');
  }), 'AND');
}

const JOB_FORMAT = '^Задание [a-z][a-z0-9-]* [(][^()[:space:]]+[)] сдалось(:| после [0-9]+ попыток:)';
const JOB_ID = '^Задание [a-z][a-z0-9-]* [(]([^()[:space:]]+)[)] сдалось';
const TRANSCRIPT_FORMAT = '^Разговор [^[:space:]]+ так и не расшифрован после всех попыток — запись на станции цела, можно повторить вручную$';
const RECORDING_FORMAT = '^Разговор [^[:space:]]+ был отвечен, но запись так и не нашлась на станции после всех попыток — проверьте MixMonitor и туннель до АТС$';
const CALL_ID = '^Разговор ([^[:space:]]+) ';
export function publicSystemErrorSql(role?: string | null): Prisma.Sql {
  if (canViewInvestigations(role)) return Prisma.sql`TRUE`;
  return Prisma.sql`${errorLogWhereSql(visibleSystemErrorWhere())} AND (CASE
    WHEN "ErrorLog".source = 'background-jobs' AND "ErrorLog".message ~ ${JOB_FORMAT} THEN EXISTS (
      SELECT 1 FROM "BackgroundJob" WHERE "BackgroundJob".id = substring("ErrorLog".message from ${JOB_ID})
        AND starts_with("ErrorLog".message, 'Задание ' || "BackgroundJob".type || ' (' || "BackgroundJob".id || ') сдалось')
        AND ${publicBackgroundJobSql()}
    )
    WHEN ("ErrorLog".source = 'ai' AND "ErrorLog".message ~ ${TRANSCRIPT_FORMAT})
      OR ("ErrorLog".source = 'telephony' AND "ErrorLog".message ~ ${RECORDING_FORMAT}) THEN EXISTS (
        SELECT 1 FROM "Interaction" i WHERE i.id = substring("ErrorLog".message from ${CALL_ID}) AND i."investigationOnly" = false
      )
    ELSE TRUE END)`;
}
/** All operations include the SQL visibility boundary before aggregation/limit/mutation. */
export function visibleErrorLogs(role?: string | null) {
  const predicate = (where?: Prisma.ErrorLogWhereInput) => Prisma.sql`(${publicSystemErrorSql(role)}) AND (${errorLogWhereSql(where)})`;
  async function updateMany(args: { where?: Prisma.ErrorLogWhereInput; data: { resolvedAt?: Date | null; resolvedById?: string | null } }) {
    const values = Object.entries(args.data).map(([field, value]) => {
      if (!['resolvedAt', 'resolvedById'].includes(field)) throw new Error('Unsupported ErrorLog mutation');
      return Prisma.sql`${column(field)} = ${value}`;
    });
    if (!values.length) return { count: 0 };
    // SET targets cannot be table-qualified in PostgreSQL.
    const assignments = Object.entries(args.data).map(([field, value]) => Prisma.sql`${Prisma.raw(`"${field}"`)} = ${value}`);
    const count = await prisma.$executeRaw(Prisma.sql`UPDATE "ErrorLog" SET ${Prisma.join(assignments)} WHERE ${predicate(args.where)}`);
    return { count };
  }
  return {
    async findMany(args: Pick<Prisma.ErrorLogFindManyArgs, 'where' | 'select' | 'take' | 'skip' | 'orderBy'> = {}): Promise<ErrorLog[]> {
      const selected = args.select ? Object.entries(args.select).filter(([, enabled]) => enabled).map(([key]) => column(key)) : [Prisma.sql`"ErrorLog".*`];
      const orders = !args.orderBy ? [] : (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]).flatMap(order => Object.entries(order).map(([field, direction]) => {
        if (direction !== 'asc' && direction !== 'desc') throw new Error('Unsupported ErrorLog ordering');
        return Prisma.sql`${column(field)} ${Prisma.raw(direction.toUpperCase())}`;
      }));
      return prisma.$queryRaw<ErrorLog[]>(Prisma.sql`SELECT ${Prisma.join(selected)} FROM "ErrorLog" WHERE ${predicate(args.where)}
        ${orders.length ? Prisma.sql`ORDER BY ${Prisma.join(orders)}` : Prisma.empty}
        ${args.take === undefined ? Prisma.empty : Prisma.sql`LIMIT ${args.take}`}
        ${args.skip === undefined ? Prisma.empty : Prisma.sql`OFFSET ${args.skip}`}`);
    },
    async count(args: { where?: Prisma.ErrorLogWhereInput } = {}): Promise<number> {
      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT count(*) AS count FROM "ErrorLog" WHERE ${predicate(args.where)}`);
      return Number(rows[0]?.count ?? 0);
    },
    updateMany,
    async update(args: { where: Prisma.ErrorLogWhereInput; data: { resolvedAt?: Date | null; resolvedById?: string | null } }) {
      const result = await updateMany(args);
      if (!result.count) throw new Prisma.PrismaClientKnownRequestError('Record not found', { code: 'P2025', clientVersion: Prisma.prismaVersion.client });
      return result;
    },
  };
}
