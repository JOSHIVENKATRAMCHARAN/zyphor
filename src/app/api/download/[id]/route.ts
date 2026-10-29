import { NextRequest, NextResponse } from 'next/server';
import { getUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { checkRateLimit } from '@/lib/rate-limit';
import { getClientIp, isValidLinkId, isValidUuid, noStoreJson } from '@/lib/security';
import { databaseUnavailableMessage, isPrismaDatabaseConnectivityError } from '@/lib/prisma-errors';
import { downloadObject, isStorageError } from '@/lib/postgres-storage';

type DownloadFileRow = {
  id: string;
  original_name: string;
  size: number;
  storage_path: string;
  salt: string;
  iv: string;
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: linkId } = await context.params;
    if (!isValidLinkId(linkId)) {
      return noStoreJson({ error: 'Invalid link id' }, { status: 400 });
    }
    
    // Fetch link info
    const link = await prisma.link.findUnique({
      where: { id: linkId },
      include: { files: true }
    });
    
    if (!link) {
      return noStoreJson({ error: 'Link not found' }, { status: 404 });
    }

    const user = await getUser();
    const requiresAuth = link.auth_required === 1;
    if (requiresAuth && !user?.id) {
      return noStoreJson(
        { error: 'This transfer requires sign-in before download.', authRequired: true },
        { status: 401 }
      );
    }

    // Check expiration
    if (new Date(link.expires_at) < new Date()) {
      return noStoreJson({ error: 'Link expired' }, { status: 410 });
    }

    // Check downloads limit
    if (link.max_downloads > 0 && link.current_downloads >= link.max_downloads) {
      return noStoreJson({ error: 'Download limit reached' }, { status: 410 });
    }

    const files = link.files as DownloadFileRow[];

    if (files.length === 0) {
      return noStoreJson({ error: 'No files found' }, { status: 404 });
    }

    // Determine return type based on query param (metadata or actual file streaming)
    const { searchParams } = new URL(request.url);
    const downloadFileId = searchParams.get('fileId');
    if (downloadFileId && !isValidUuid(downloadFileId)) {
      return noStoreJson({ error: 'Invalid file id' }, { status: 400 });
    }

    const ip = getClientIp(request);
    const rateAction = downloadFileId ? "download_file" : "download_meta";
    const rateLimit = downloadFileId ? 120 : 240;
    const allowed = await checkRateLimit(`${ip}:${linkId}`, rateAction, rateLimit, 5);
    if (!allowed) {
      return noStoreJson({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    if (!downloadFileId) {
      // Just return metadata
      return noStoreJson({
        allowSave: link.allow_save,
        authRequired: requiresAuth,
        files: files.map((f: DownloadFileRow) => ({
          id: f.id,
          name: f.original_name,
          size: f.size,
          salt: f.salt,
          iv: f.iv
        }))
      });
    }

    const file = files.find((f: DownloadFileRow) => f.id === downloadFileId);
    if (!file) {
      return noStoreJson({ error: 'File not found in link' }, { status: 404 });
    }

    // storage_path holds the fileId — use it to fetch from Postgres
    const storageFileId = file.storage_path || file.id;
    const storageResponse = await downloadObject(storageFileId);
    if (!storageResponse.body) {
      throw new Error('Downloaded storage object has no response body.');
    }

    // Increment download count
    await prisma.link.update({
      where: { id: linkId },
      data: { current_downloads: { increment: 1 } }
    });

    if (requiresAuth && user?.id) {
      prisma.downloadLog.create({
        data: {
          link_id: linkId,
          file_id: file.id,
          user_id: user.id,
          ip_address: getClientIp(request),
        },
      }).catch((logError: unknown) => {
        console.warn('Failed to persist download log:', logError);
      });
    }

    const encodedFilename = encodeURIComponent(file.original_name).replace(/['()]/g, escape).replace(/\*/g, '%2A');
    const contentType = storageResponse.headers.get('content-type') || 'application/octet-stream';
    const contentLength = storageResponse.headers.get('content-length') || file.size.toString();

    return new NextResponse(storageResponse.body, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodedFilename}`,
        'Content-Length': contentLength,
        'Cache-Control': 'no-store, max-age=0',
        'Pragma': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
    });
  } catch (error) {
    console.error('Download Error:', error);
    if (isPrismaDatabaseConnectivityError(error)) {
      return noStoreJson({ error: databaseUnavailableMessage('Download service') }, { status: 503 });
    }
    if (isStorageError(error)) {
      return noStoreJson({ error: error.message }, { status: error.status || 500 });
    }
    return noStoreJson({ error: 'Internal server error' }, { status: 500 });
  }
}
