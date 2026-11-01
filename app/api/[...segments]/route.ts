import { NextRequest } from 'next/server';
import { handleApi } from '@/src/lib/local-api';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = {params: Promise<{segments: string[]}>};
export async function GET(request: NextRequest, {params}: Context) { return handleApi(request, (await params).segments); }
export async function POST(request: NextRequest, {params}: Context) { return handleApi(request, (await params).segments); }
export async function PATCH(request: NextRequest, {params}: Context) { return handleApi(request, (await params).segments); }
export async function DELETE(request: NextRequest, {params}: Context) { return handleApi(request, (await params).segments); }
