import { randomBytes } from "node:crypto";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type FileTransactionOperation = {
  phase: "inspect" | "stage" | "commit" | "rollback" | "cleanup";
  action: string;
  label: string;
  targetPath: string;
  artifactPath?: string;
};

export type FileTransactionOperationExecutor = <Result>(
  operation: FileTransactionOperation,
  action: () => Promise<Result>,
) => Promise<Result>;

export type FileReplacement = {
  path: string;
  label: string;
  contents: string | Uint8Array;
};

type TransactionEntry = FileReplacement & {
  temporaryPath: string;
  backupPath: string;
  hadOriginal: boolean;
  originalMoved: boolean;
  replacementMayExist: boolean;
};

type OperationFailure = {
  operation: FileTransactionOperation;
  cause: unknown;
};

type RecoveryFailure = {
  action: string;
  label: string;
  code: string;
};

const defaultExecutor: FileTransactionOperationExecutor = async (_operation, action) => action();

export async function replaceFilesAtomically(
  replacements: FileReplacement[],
  options: { execute?: FileTransactionOperationExecutor } = {},
) {
  if (replacements.length === 0) {
    return;
  }
  const execute = options.execute ?? defaultExecutor;
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const entries: TransactionEntry[] = [];

  try {
    for (const [index, replacement] of replacements.entries()) {
      const directory = path.dirname(replacement.path);
      const basename = path.basename(replacement.path);
      const artifactStem = path.join(directory, `.${basename}.sporades-tx-${token}-${index}`);
      const entry: TransactionEntry = {
        ...replacement,
        temporaryPath: `${artifactStem}.tmp`,
        backupPath: `${artifactStem}.bak`,
        hadOriginal: false,
        originalMoved: false,
        replacementMayExist: false,
      };
      entries.push(entry);
      entry.hadOriginal = await targetExists(entry, execute);
      await performOperation(execute, {
        phase: "stage",
        action: "write",
        label: entry.label,
        targetPath: entry.path,
        artifactPath: entry.temporaryPath,
      }, () => writeFile(entry.temporaryPath, entry.contents, { flag: "wx", mode: 0o600 }));
    }

    for (const entry of entries) {
      if (entry.hadOriginal) {
        await performOperation(execute, {
          phase: "commit",
          action: "backup",
          label: entry.label,
          targetPath: entry.path,
          artifactPath: entry.backupPath,
        }, () => rename(entry.path, entry.backupPath));
        entry.originalMoved = true;
      }
      entry.replacementMayExist = true;
      await performOperation(execute, {
        phase: "commit",
        action: "replace",
        label: entry.label,
        targetPath: entry.path,
        artifactPath: entry.temporaryPath,
      }, () => rename(entry.temporaryPath, entry.path));
    }
  } catch (failure) {
    const original = asOperationFailure(failure);
    const recoveryFailures = await recoverEntries(entries, execute);
    throw transactionError(original, recoveryFailures);
  }

  const cleanupFailures = await cleanupCommittedEntries(entries, execute);
  if (cleanupFailures.length > 0) {
    throw transactionError({
      operation: {
        phase: "cleanup",
        action: "remove-backup",
        label: cleanupFailures[0].label,
        targetPath: "",
      },
      cause: Object.assign(new Error("Transaction cleanup failed."), { code: cleanupFailures[0].code }),
    }, cleanupFailures, "committed");
  }
}

async function targetExists(entry: TransactionEntry, execute: FileTransactionOperationExecutor) {
  try {
    await performOperation(execute, {
      phase: "inspect",
      action: "stat",
      label: entry.label,
      targetPath: entry.path,
    }, () => lstat(entry.path));
    return true;
  } catch (failure) {
    const operationFailure = asOperationFailure(failure);
    if (errorCode(operationFailure.cause) === "ENOENT") {
      return false;
    }
    throw operationFailure;
  }
}

async function recoverEntries(entries: TransactionEntry[], execute: FileTransactionOperationExecutor) {
  const failures: RecoveryFailure[] = [];
  for (const entry of entries) {
    if (entry.hadOriginal) {
      const backupExists = await artifactExists(entry.backupPath);
      if (backupExists) {
        try {
          await performOperation(execute, {
            phase: "rollback",
            action: "restore",
            label: entry.label,
            targetPath: entry.path,
            artifactPath: entry.backupPath,
          }, () => rename(entry.backupPath, entry.path));
          entry.originalMoved = false;
        } catch (failure) {
          failures.push(recoveryFailure("restore", entry.label, asOperationFailure(failure).cause));
        }
      } else if (entry.originalMoved) {
        failures.push({ action: "restore", label: entry.label, code: "BACKUP_MISSING" });
      }
    } else if (entry.replacementMayExist) {
      try {
        await performOperation(execute, {
          phase: "rollback",
          action: "remove",
          label: entry.label,
          targetPath: entry.path,
        }, () => rm(entry.path, { force: true }));
        entry.replacementMayExist = false;
      } catch (failure) {
        failures.push(recoveryFailure("remove", entry.label, asOperationFailure(failure).cause));
      }
    }
  }

  for (const entry of entries) {
    try {
      await performOperation(execute, {
        phase: "cleanup",
        action: "remove-temp",
        label: entry.label,
        targetPath: entry.path,
        artifactPath: entry.temporaryPath,
      }, () => rm(entry.temporaryPath, { force: true }));
    } catch (failure) {
      failures.push(recoveryFailure("remove-temp", entry.label, asOperationFailure(failure).cause));
    }
  }
  return failures;
}

async function cleanupCommittedEntries(entries: TransactionEntry[], execute: FileTransactionOperationExecutor) {
  const failures: RecoveryFailure[] = [];
  for (const entry of entries) {
    for (const [action, artifactPath] of [
      ["remove-temp", entry.temporaryPath],
      ["remove-backup", entry.backupPath],
    ] as const) {
      try {
        await performOperation(execute, {
          phase: "cleanup",
          action,
          label: entry.label,
          targetPath: entry.path,
          artifactPath,
        }, () => rm(artifactPath, { force: true }));
      } catch (failure) {
        failures.push(recoveryFailure(action, entry.label, asOperationFailure(failure).cause));
      }
    }
  }
  return failures;
}

async function artifactExists(artifactPath: string) {
  try {
    await lstat(artifactPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    return true;
  }
}

async function performOperation<Result>(
  execute: FileTransactionOperationExecutor,
  operation: FileTransactionOperation,
  action: () => Promise<Result>,
) {
  try {
    return await execute(operation, action);
  } catch (cause) {
    throw { operation, cause } satisfies OperationFailure;
  }
}

function asOperationFailure(value: unknown): OperationFailure {
  if (
    value &&
    typeof value === "object" &&
    "operation" in value &&
    "cause" in value
  ) {
    return value as OperationFailure;
  }
  return {
    operation: {
      phase: "commit",
      action: "unknown",
      label: "transaction",
      targetPath: "",
    },
    cause: value,
  };
}

function recoveryFailure(action: string, label: string, cause: unknown): RecoveryFailure {
  return { action, label, code: errorCode(cause) };
}

function transactionError(
  originalFailure: OperationFailure,
  recoveryFailures: RecoveryFailure[],
  recoveryOverride?: "committed",
) {
  const recovery = recoveryOverride ?? (recoveryFailures.length === 0 ? "complete" : "incomplete");
  const error = new Error("Unable to update OAuth configuration atomically.") as Error & {
    hint?: string;
    diagnostics?: unknown;
  };
  error.hint = recovery === "complete"
    ? "The previous project configuration and Server env state were restored. Retry the command."
    : recovery === "committed"
      ? "The new project configuration was committed, but transaction artifact cleanup was incomplete."
      : `Recovery was incomplete for ${[...new Set(recoveryFailures.map((failure) => failure.label))].join(", ")}. Inspect those files before retrying.`;
  error.diagnostics = {
    original: {
      phase: originalFailure.operation.phase,
      action: originalFailure.operation.action,
      label: originalFailure.operation.label,
      code: errorCode(originalFailure.cause),
    },
    recovery,
    recoveryFailures,
  };
  return error;
}

function errorCode(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
  return /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : "UNKNOWN";
}
