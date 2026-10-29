import { NextRequest, NextResponse } from 'next/server';
import { getUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { checkRateLimit } from '@/lib/rate-limit';
import { getClientIp, isSameOrigin, isValidLinkId } from '@/lib/security';
import { isPrismaDatabaseConnectivityError } from '@/lib/prisma-errors';
import { deleteObject, isStorageError } from '@/lib/postgres-storage';

export async function POST(request: NextRequest) {
  const contentType = request.headers.get('content-type') || '';
  const wantsJson =
    contentType.includes('application/json') ||
    (request.headers.get('accept') || '').includes('application/json');

  const respond = (status: number, body: Record<string, unknown>, redirectPath = '/dashboard') => {
    if (wantsJson) {
      return NextResponse.json(body, { status });
    }
    return NextResponse.redirect(new URL(redirectPath, request.url), 303);
  };

  try {
    if (!isSameOrigin(request)) {
      return respond(403, { error: 'CSRF attempt blocked' });
    }

    const user = await getUser();
    if (!user) {
      return respond(401, { error: 'Unauthorized' }, '/login');
    }

    const allowed = await checkRateLimit(`${getClientIp(request)}:${user.id}`, 'delete_link', 30, 5);
    if (!allowed) {
      return respond(429, { error: 'Rate limit exceeded' });
    }

    let linkId = '';
    if (contentType.includes('application/json')) {
      const payload = await request.json().catch(() => ({}));
      linkId = typeof payload?.id === 'string' ? payload.id : '';
    } else {
      const formData = await request.formData();
      linkId = String(formData.get('id') || '');
    }

    if (!linkId || !isValidLinkId(linkId)) {
      return respond(400, { error: 'Invalid link id' });
    }

    // Verify ownership
    const link = await prisma.link.findUnique({
      where: { id: linkId },
      include: { files: true }
    });
    
    if (!link || link.user_id !== user.id) {
      return respond(403, { error: 'Forbidden' });
    }

    // Clear blob data from each file (best-effort; cascade will remove the rows)
    let allDeleted = true;
    for (const file of link.files) {
      try {
        const storageRef = file.storage_path || file.id;
        await deleteObject(storageRef);
      } catch (err) {
        if (isStorageError(err) && err.status === 404) continue;
        console.error('Failed to clear file blob from Postgres Storage:', err);
        allDeleted = false;
      }
    }

    if (!allDeleted) {
      return respond(500, { error: 'Failed to sync storage deletion, aborting database removal' });
    }

    // Delete link (Cascading delete will remove files and savedLinks)
    await prisma.link.delete({
      where: { id: linkId }
    });

    return respond(200, { success: true });
  } catch (error) {
    console.error('Delete error:', error);
    if (isPrismaDatabaseConnectivityError(error)) {
      return respond(503, { error: 'Database unavailable' }, '/dashboard?error=db_unavailable');
    }
    if (isStorageError(error)) {
      return respond(error.status || 500, { error: error.message });
    }
    return respond(500, { error: 'Internal server error' });
  }
}
