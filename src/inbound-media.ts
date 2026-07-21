/**
 * Persist inbound inline (base64/raw) file parts under the OpenClaw workspace
 * so native tools (pdf, etc.) can open them via an allowed absolute path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { decodedBase64Size } from "./file-security.js";

export const DEFAULT_INBOUND_MEDIA_DIR = path.join(
  os.homedir(),
  ".openclaw",
  "workspace",
  "a2a-inbox",
);

export interface MaterializedInboundFile {
  /** Original filename from the A2A part. */
  name: string;
  mimeType: string;
  /** Absolute path under inbound media dir (OpenClaw workspace). */
  localPath: string;
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

function collectInlineParts(message: unknown): Array<{ name: string; mimeType: string; data: Buffer }> {
  const out: Array<{ name: string; mimeType: string; data: Buffer }> = [];
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
      if (asString(file.uri)) continue; // URI parts are not materialized
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

/**
 * Write inline inbound files into mediaDir and return metadata for agent prompts.
 * Also sweeps files older than ttlMs (default 24h).
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
    // Skip empty / tiny placeholders
    if (part.data.length === 0) continue;
    // Sanity: refuse absurd sizes here (caller already validates)
    if (part.data.length > 52_428_800) continue;

    const safeName = sanitizeFileName(part.name);
    const fileName = `${randomUUID().slice(0, 8)}_${safeName}`;
    const localPath = path.join(mediaDir, fileName);
    fs.writeFileSync(localPath, part.data);
    materialized.push({
      name: part.name,
      mimeType: part.mimeType,
      localPath,
    });
  }
  return materialized;
}

/** Map original filename → absolute local path (last write wins on duplicates). */
export function localPathIndex(files: MaterializedInboundFile[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of files) {
    map.set(file.name, file.localPath);
    map.set(path.basename(file.name), file.localPath);
    map.set(sanitizeFileName(file.name), file.localPath);
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
