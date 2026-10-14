const MAX_TRANSACTION_ATTEMPTS = 3;
const RETRYABLE_DATABASE_CODES = new Set(["40001", "40P01"]);

function isRetryableTransactionConflict(error: unknown): boolean {
  // A conflict can arrive wrapped (for example by AuditWriteError); the cause chain still counts.
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === "object" && !seen.has(current); ) {
    seen.add(current);
    if ("code" in current) {
      const prismaError = current as {
        code?: unknown;
        meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
      };
      if (prismaError.code === "P2034") return true;
      const databaseCode = prismaError.meta?.driverAdapterError?.cause?.originalCode;
      if (typeof databaseCode === "string" && RETRYABLE_DATABASE_CODES.has(databaseCode))
        return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function withTransactionRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableTransactionConflict(error) || attempt >= MAX_TRANSACTION_ATTEMPTS) {
        throw error;
      }
    }
  }
}
