/**
 * Persist inbound file parts under the OpenClaw workspace so native tools
 * (pdf, etc.) can open them via an allowed absolute path.
 *
 * Supports:
 * - inline base64 / raw bytes (FileWithBytes)
 * - remote URI / FileWithUri (downloaded here with SSRF checks)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  checkFileSize,
  decodedBase64Size,
  sanitizeUriForLog,
  validateUri,
} from "./file-security.js";
import type { FileSecurityConfig } from "./types.js";

export const DEFAULT_INBOUND_MEDIA_DIR = path.join(
  os.homedir(),
  ".openclaw",
  "workspace",
  "a2a-inbox",
);

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_FETCH_TIMEOUT_MS = 120_000;

export interface MaterializedInboundFile {
  /** Original filename from the A2A part. */
  name: string;
  mimeType: string;
  /** Absolute path under inbound media dir (OpenClaw workspace). */
  localPath: string;
  /** Source URI when the file was downloaded (presigned / remote). */
  sourceUri?: string;
}

export type ValidateUriFn = (
  uri: string,
  config: FileSecurityConfig,
) => Promise<{ ok: boolean; reason?: string }>;

export interface MaterializeInboundOptions {
  mediaDir?: string;
  ttlMs?: number;
  /** Required to download URI parts (SSRF allowlist, size limits). */
  security?: FileSecurityConfig;
  fetchFn?: typeof fetch;
  /** Override URI SSRF validation (tests). Default: validateUri. */
  validateUriFn?: ValidateUriFn;
  maxRedirects?: number;
  fetchTimeoutMs?: number;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bufferOrBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string" && value.length > 0) {
    try {
      return Buffer.from(value, "base64");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[\r\n\t\x00-\x1f]/g, "").trim();
  const cleaned = base.replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 180);
  return cleaned || "file.bin";
}

function parseContentDispositionFileName(header: string | null): string | undefined {
  if (!header) return undefined;
  const utf8 = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim().replace(/^["']|["']$/g, ""));
    } catch {
      // fall through
    }
  }
  const plain = /filename\s*=\s*("?)([^";]+)\1/i.exec(header);
  if (plain?.[2]) {
    return plain[2].trim();
  }
  return undefined;
}

interface InlinePart {
  name: string;
  mimeType: string;
  data: Buffer;
}

interface UriPart {
  name: string;
  mimeType: string;
  uri: string;
}

function collectInlineParts(message: unknown): InlinePart[] {
  const out: InlinePart[] = [];
  const root = asObject(message);
  if (!root) return out;
  const parts = Array.isArray(root.parts) ? root.parts : [];

  for (const entry of parts) {
    const part = asObject(entry);
    if (!part) continue;

    const content = asObject(part.content);
    if (content?.$case === "raw") {
      const data = bufferOrBytes(content.value);
      if (!data || data.length === 0) continue;
      out.push({
        name: asString(part.filename) || asString(part.name) || "file.bin",
        mimeType: asString(part.mediaType) || asString(part.mimeType) || "application/octet-stream",
        data,
      });
      continue;
    }

    if (typeof part.raw === "string" || Buffer.isBuffer(part.raw)) {
      const data = bufferOrBytes(part.raw);
      if (!data || data.length === 0) continue;
      out.push({
        name: asString(part.filename) || asString(part.name) || "file.bin",
        mimeType: asString(part.mediaType) || asString(part.mimeType) || "application/octet-stream",
        data,
      });
      continue;
    }

    if (part.kind === "file") {
      const file = asObject(part.file);
      if (!file) continue;
      if (asString(file.uri)) continue; // handled by URI collector
      const data = bufferOrBytes(file.bytes);
      if (!data || data.length === 0) continue;
      out.push({
        name: asString(file.name) || asString(part.filename) || "file.bin",
        mimeType: asString(file.mimeType) || asString(file.mediaType) || "application/octet-stream",
        data,
      });
    }
  }

  return out;
}

function collectUriParts(message: unknown): UriPart[] {
  const out: UriPart[] = [];
  const root = asObject(message);
  if (!root) return out;
  const parts = Array.isArray(root.parts) ? root.parts : [];

  for (const entry of parts) {
    const part = asObject(entry);
    if (!part) continue;

    const content = asObject(part.content);
    if (content?.$case === "url" && typeof content.value === "string") {
      const uri = asString(content.value);
      if (!uri) continue;
      out.push({
        name: asString(part.filename) || asString(part.name) || "file.bin",
        mimeType: asString(part.mediaType) || asString(part.mimeType) || "application/octet-stream",
        uri,
      });
      continue;
    }

    // a2a-go v2 flattened: { url, filename, mediaType }
    const flatUrl = asString(part.url);
    if (flatUrl && !part.kind) {
      out.push({
        name: asString(part.filename) || asString(part.name) || "file.bin",
        mimeType: asString(part.mediaType) || asString(part.mimeType) || "application/octet-stream",
        uri: flatUrl,
      });
      continue;
    }

    if (part.kind === "file") {
      const file = asObject(part.file);
      if (!file) continue;
      const uri = asString(file.uri);
      if (!uri) continue;
      out.push({
        name: asString(file.name) || asString(part.filename) || "file.bin",
        mimeType: asString(file.mimeType) || asString(file.mediaType) || "application/octet-stream",
        uri,
      });
    }
  }

  return out;
}

function writeMaterializedFile(
  mediaDir: string,
  name: string,
  mimeType: string,
  data: Buffer,
  sourceUri?: string,
): MaterializedInboundFile {
  const safeName = sanitizeFileName(name);
  const fileName = `${randomUUID().slice(0, 8)}_${safeName}`;
  const localPath = path.join(mediaDir, fileName);
  fs.writeFileSync(localPath, data);
  return {
    name,
    mimeType,
    localPath,
    sourceUri,
  };
}

async function downloadUriToBuffer(
  uri: string,
  security: FileSecurityConfig,
  fetchFn: typeof fetch,
  validateUriFn: ValidateUriFn,
  maxRedirects: number,
  fetchTimeoutMs: number,
): Promise<{ data: Buffer; contentType?: string; fileName?: string }> {
  let current = uri;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validation = await validateUriFn(current, security);
    if (!validation.ok) {
      throw new Error(
        `URI blocked (${sanitizeUriForLog(current)}): ${validation.reason ?? "validation failed"}`,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    let response: Response;
    try {
      response = await fetchFn(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "*/*",
          "User-Agent": "openclaw-a2a-gateway/inbound-media",
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to download ${sanitizeUriForLog(current)}: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirect ${response.status} without Location from ${sanitizeUriForLog(current)}`);
      }
      current = new URL(location, current).href;
      continue;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} downloading ${sanitizeUriForLog(current)}`);
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const declared = Number(contentLength);
      if (Number.isFinite(declared) && declared >= 0) {
        const sizeCheck = checkFileSize(declared, security.maxFileSizeBytes);
        if (!sizeCheck.ok) {
          throw new Error(sizeCheck.reason ?? "file too large");
        }
      }
    }

    const arrayBuffer = await response.arrayBuffer();
    const data = Buffer.from(arrayBuffer);
    const sizeCheck = checkFileSize(data.byteLength, security.maxFileSizeBytes);
    if (!sizeCheck.ok) {
      throw new Error(sizeCheck.reason ?? "file too large");
    }

    const contentTypeHeader = response.headers.get("content-type");
    const contentType = contentTypeHeader
      ? contentTypeHeader.split(";")[0]?.trim() || undefined
      : undefined;
    const fileName = parseContentDispositionFileName(response.headers.get("content-disposition"));

    return { data, contentType, fileName };
  }

  throw new Error(`Too many redirects downloading ${sanitizeUriForLog(uri)}`);
}

/**
 * Write inline inbound files into mediaDir and return metadata for agent prompts.
 * Also sweeps files older than ttlMs (default 24h).
 *
 * URI parts are ignored here — use {@link materializeInboundFiles}.
 */
export function materializeInboundInlineFiles(
  message: unknown,
  mediaDir: string = DEFAULT_INBOUND_MEDIA_DIR,
  ttlMs = 24 * 60 * 60 * 1000,
): MaterializedInboundFile[] {
  fs.mkdirSync(mediaDir, { recursive: true });
  sweepExpired(mediaDir, ttlMs);

  const materialized: MaterializedInboundFile[] = [];
  for (const part of collectInlineParts(message)) {
    if (part.data.length === 0) continue;
    if (part.data.length > 52_428_800) continue;
    materialized.push(writeMaterializedFile(mediaDir, part.name, part.mimeType, part.data));
  }
  return materialized;
}

/**
 * Materialize inline bytes and download FileWithUri / url parts into the inbox.
 * URI downloads are SSRF-checked (scheme, DNS→public IP, optional hostname allowlist).
 */
export async function materializeInboundFiles(
  message: unknown,
  options: MaterializeInboundOptions = {},
): Promise<MaterializedInboundFile[]> {
  const mediaDir = options.mediaDir ?? DEFAULT_INBOUND_MEDIA_DIR;
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const fetchFn = options.fetchFn ?? fetch;
  const validateUriFn = options.validateUriFn ?? validateUri;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  fs.mkdirSync(mediaDir, { recursive: true });
  sweepExpired(mediaDir, ttlMs);

  const materialized: MaterializedInboundFile[] = [];

  for (const part of collectInlineParts(message)) {
    if (part.data.length === 0) continue;
    if (part.data.length > 52_428_800) continue;
    materialized.push(writeMaterializedFile(mediaDir, part.name, part.mimeType, part.data));
  }

  const uriParts = collectUriParts(message);
  if (uriParts.length === 0) {
    return materialized;
  }

  if (!options.security) {
    throw new Error("security config is required to materialize URI file parts");
  }

  for (const part of uriParts) {
    const downloaded = await downloadUriToBuffer(
      part.uri,
      options.security,
      fetchFn,
      validateUriFn,
      maxRedirects,
      fetchTimeoutMs,
    );
    const name = downloaded.fileName || part.name;
    const mimeType = downloaded.contentType || part.mimeType;
    materialized.push(
      writeMaterializedFile(mediaDir, name, mimeType, downloaded.data, part.uri),
    );
  }

  return materialized;
}

/** Map filename / source URI → absolute local path (last write wins on duplicates). */
export function localPathIndex(files: MaterializedInboundFile[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of files) {
    map.set(file.name, file.localPath);
    map.set(path.basename(file.name), file.localPath);
    map.set(sanitizeFileName(file.name), file.localPath);
    if (file.sourceUri) {
      map.set(file.sourceUri, file.localPath);
    }
  }
  return map;
}

function sweepExpired(mediaDir: string, ttlMs: number): void {
  if (ttlMs <= 0) return;
  const now = Date.now();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(mediaDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(mediaDir, entry.name);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > ttlMs) {
        fs.unlinkSync(full);
      }
    } catch {
      // ignore
    }
  }
}

/** Exported for tests — estimate size of base64 without writing. */
export function estimateBase64Bytes(b64: string): number {
  return decodedBase64Size(b64);
}
