import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  localPathIndex,
  materializeInboundInlineFiles,
} from "../src/inbound-media.js";

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
});
