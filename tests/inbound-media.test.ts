import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  localPathIndex,
  materializeInboundFiles,
  materializeInboundInlineFiles,
} from "../src/inbound-media.js";
import type { FileSecurityConfig } from "../src/types.js";

function testSecurity(overrides?: Partial<FileSecurityConfig>): FileSecurityConfig {
  return {
    allowedMimeTypes: ["application/pdf", "image/*", "text/plain", "application/zip"],
    maxFileSizeBytes: 52_428_800,
    maxInlineFileSizeBytes: 10_485_760,
    fileUriAllowlist: ["s3.cloud.ru", "*.s3.example.com", "cdn.example.com"],
    inboundMediaDir: path.join(os.tmpdir(), "a2a-inbox-test"),
    ...overrides,
  };
}

const allowAllUris = async () => ({ ok: true as const });

async function allowlistValidate(
  uri: string,
  config: FileSecurityConfig,
): Promise<{ ok: boolean; reason?: string }> {
  const host = new URL(uri).hostname.toLowerCase();
  if (config.fileUriAllowlist.length === 0) return { ok: true };
  const allowed = config.fileUriAllowlist.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.startsWith("*.")) {
      const suffix = p.slice(1);
      return host.endsWith(suffix) || host === p.slice(2);
    }
    return host === p;
  });
  return allowed
    ? { ok: true }
    : { ok: false, reason: `Hostname "${host}" not in URI allowlist` };
}

describe("inbound-media materialize", () => {
  it("writes inline raw parts under media dir and indexes by name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-inbox-"));
    try {
      const pdfBytes = Buffer.from("%PDF-1.4 test content");
      const message = {
        messageId: "m1",
        role: "ROLE_USER",
        parts: [
          { text: "Summarize this" },
          {
            filename: "AI Agents Golang.pdf",
            mediaType: "application/pdf",
            raw: pdfBytes.toString("base64"),
          },
        ],
      };

      const files = materializeInboundInlineFiles(message, dir);
      assert.equal(files.length, 1);
      assert.ok(files[0].localPath.startsWith(dir));
      assert.ok(fs.existsSync(files[0].localPath));
      assert.equal(fs.readFileSync(files[0].localPath).toString(), pdfBytes.toString());

      const index = localPathIndex(files);
      assert.equal(index.get("AI Agents Golang.pdf"), files[0].localPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes zip mime parts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-inbox-"));
    try {
      const message = {
        parts: [
          {
            kind: "file",
            file: {
              name: "bundle.zip",
              mimeType: "application/zip",
              bytes: Buffer.from("PK\x03\x04fake").toString("base64"),
            },
          },
        ],
      };
      const files = materializeInboundInlineFiles(message, dir);
      assert.equal(files.length, 1);
      assert.match(files[0].localPath, /bundle\.zip$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("downloads FileWithUri into inbox (presigned-style URL)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-inbox-"));
    const body = Buffer.from("%PDF-1.4 from-s3");
    try {
      const message = {
        parts: [
          { text: "Summarize" },
          {
            kind: "file",
            file: {
              name: "report.pdf",
              mimeType: "application/pdf",
              uri: "https://s3.cloud.ru/bucket/agent-space/p/u/report.pdf?X-Amz-Signature=abc",
            },
          },
        ],
      };

      const fetchFn: typeof fetch = async (input) => {
        const url = String(input);
        assert.match(url, /^https:\/\/s3\.cloud\.ru\//);
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-disposition": 'inline; filename="report.pdf"',
          },
        });
      };

      const files = await materializeInboundFiles(message, {
        mediaDir: dir,
        security: testSecurity(),
        fetchFn,
        validateUriFn: allowAllUris,
      });
      assert.equal(files.length, 1);
      assert.equal(files[0].name, "report.pdf");
      assert.equal(files[0].sourceUri?.startsWith("https://s3.cloud.ru/"), true);
      assert.equal(fs.readFileSync(files[0].localPath).toString(), body.toString());
      assert.equal(localPathIndex(files).get("report.pdf"), files[0].localPath);
      assert.equal(
        localPathIndex(files).get(
          "https://s3.cloud.ru/bucket/agent-space/p/u/report.pdf?X-Amz-Signature=abc",
        ),
        files[0].localPath,
        "index must resolve by sourceUri so prompt formatting can hide S3 URL",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("downloads a2a-go flattened url parts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-inbox-"));
    try {
      const message = {
        parts: [
          {
            filename: "photo.png",
            mediaType: "image/png",
            url: "https://cdn.example.com/photo.png",
          },
        ],
      };
      const fetchFn: typeof fetch = async () =>
        new Response(Buffer.from("PNGDATA"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });

      const files = await materializeInboundFiles(message, {
        mediaDir: dir,
        security: testSecurity(),
        fetchFn,
        validateUriFn: allowAllUris,
      });
      assert.equal(files.length, 1);
      assert.equal(files[0].name, "photo.png");
      assert.equal(fs.readFileSync(files[0].localPath).toString(), "PNGDATA");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects URI download when hostname not on allowlist", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-inbox-"));
    try {
      const message = {
        parts: [
          {
            kind: "file",
            file: {
              name: "x.pdf",
              mimeType: "application/pdf",
              uri: "https://evil.example/x.pdf",
            },
          },
        ],
      };
      await assert.rejects(
        () =>
          materializeInboundFiles(message, {
            mediaDir: dir,
            security: testSecurity({ fileUriAllowlist: ["s3.cloud.ru"] }),
            fetchFn: async () => new Response("nope"),
            validateUriFn: allowlistValidate,
          }),
        /not in URI allowlist|URI blocked/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("follows a single redirect with re-validation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-inbox-"));
    try {
      const message = {
        parts: [
          {
            kind: "file",
            file: {
              name: "doc.pdf",
              mimeType: "application/pdf",
              uri: "https://cdn.example.com/start",
            },
          },
        ],
      };
      let hops = 0;
      const fetchFn: typeof fetch = async (input) => {
        hops += 1;
        const url = String(input);
        if (url.endsWith("/start")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://cdn.example.com/final.pdf" },
          });
        }
        return new Response(Buffer.from("FINAL"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      };

      const files = await materializeInboundFiles(message, {
        mediaDir: dir,
        security: testSecurity(),
        fetchFn,
        validateUriFn: allowlistValidate,
      });
      assert.equal(hops, 2);
      assert.equal(fs.readFileSync(files[0].localPath).toString(), "FINAL");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
