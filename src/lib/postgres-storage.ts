/**
 * postgres-storage.ts
 *
 * Stores encrypted file blobs in Prisma Postgres (files.data Bytes column).
 * This is a drop-in replacement for supabase-storage.ts.
 * No external storage service is required.
 */

import { prisma } from "@/lib/db";

export class StorageError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "StorageError";
    this.status = status;
  }
}

export function isStorageError(error: unknown): error is StorageError {
  return error instanceof StorageError;
}

/** No-op: Postgres storage is always available when the DB is. */
export function assertStorageConfigured(): void {
  // Nothing to check — storage is the DB itself.
}

/**
 * Writes bytes to the `data` column of an existing `files` row.
 * The fileId is the primary key (uuid) of the row, which must already exist.
 */
export async function uploadObject(fileId: string, bytes: Uint8Array): Promise<void> {
  // Pass as a clean Uint8Array to satisfy Prisma Bytes type
  const payload = new Uint8Array(bytes);
  await prisma.file.update({
    where: { id: fileId },
    data: { data: payload },
  });
}

/**
 * Reads the `data` column of a `files` row and returns it as a Response
 * with the appropriate content headers (mirrors the Supabase storage API shape).
 */
export async function downloadObject(fileId: string): Promise<Response> {
  const row = await prisma.file.findUnique({
    where: { id: fileId },
    select: { data: true, size: true },
  });

  if (!row || !row.data) {
    throw new StorageError("File not found in storage", 404);
  }

  const bytes = row.data as Uint8Array;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": bytes.byteLength.toString(),
    },
  });
}

/**
 * Clears the `data` column (sets to null) for a given file row.
 * The row itself is deleted via Prisma cascade when the link is deleted,
 * so this is a best-effort early cleanup.
 */
export async function deleteObject(fileId: string): Promise<void> {
  await prisma.file
    .update({
      where: { id: fileId },
      data: { data: null },
    })
    .catch(() => {
      // Row may already be gone — ignore
    });
}
