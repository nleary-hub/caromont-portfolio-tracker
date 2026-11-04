import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

/**
 * A machine-independent fingerprint for a rendered PDF.
 *
 * pdfkit compresses every stream with Node's built-in zlib. Node bundles a zlib fork whose compressed bytes can
 * differ between machines and Node builds (CPU-specific fast paths), even when the input is identical. So a hash of
 * the raw PDF bytes passes on one machine and fails on another with nothing in the report changed.
 *
 * This hashes what the PDF actually says instead: every object in order with its stream decompressed, the
 * compressed `/Length` dropped, and the cross-reference table (byte offsets) dropped. Text, fonts, drawing
 * operators, images, metadata and the trailer are all still compared byte for byte, so any change to the
 * rendering still changes the fingerprint.
 */
export class PdfCanonical {
  static canonical(pdf: Uint8Array): Buffer {
    const buf = Buffer.from(pdf);
    const src = buf.toString("latin1");
    const out: Buffer[] = [];
    let pos = 0;
    let streams = 0;
    const streamStart = /(\/Length (\d+)[^]*?)>>\s*stream\r?\n/g;
    for (;;) {
      streamStart.lastIndex = pos;
      const m = streamStart.exec(src);
      if (!m) break;
      const dictEnd = m.index + m[0].length;
      const length = Number(m[2]);
      const data = buf.subarray(dictEnd, dictEnd + length);
      const tail = src.slice(dictEnd + length, dictEnd + length + 12);
      if (!/^\r?\n?endstream/.test(tail)) throw new Error(`PdfCanonical: stream ${streams + 1} does not end where its /Length says`);
      const dict = src.slice(m.index, dictEnd);
      out.push(Buffer.from(src.slice(pos, m.index), "latin1"));
      out.push(Buffer.from(dict.replace(/\/Length \d+\s*/, ""), "latin1"));
      out.push(/\/Filter\s*\/FlateDecode/.test(dict) ? inflateSync(data) : data);
      pos = dictEnd + length;
      streams++;
    }
    const rest = src.slice(pos);
    const xref = rest.lastIndexOf("\nxref");
    if (xref < 0 || !/startxref\s*\d+\s*%%EOF\s*$/.test(rest)) throw new Error("PdfCanonical: no cross-reference table at the end of the PDF");
    const trailer = rest.indexOf("trailer", xref);
    out.push(Buffer.from(rest.slice(0, xref), "latin1"));
    out.push(Buffer.from(rest.slice(trailer, rest.lastIndexOf("startxref")), "latin1"));
    if (streams === 0) throw new Error("PdfCanonical: no streams found; not a pdfkit PDF?");
    return Buffer.concat(out);
  }

  static sha(pdf: Uint8Array): string {
    return createHash("sha256").update(PdfCanonical.canonical(pdf)).digest("hex");
  }
}
