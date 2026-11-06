// SPDX-License-Identifier: AGPL-3.0-only
import {
  Document,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  Packer,
  HeadingLevel,
  WidthType,
  PageBreak,
  BorderStyle,
} from "docx";
import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import { StudioError } from "./store.ts";
import type { BibleBlock } from "./bible-content.ts";
const font = (name: string) =>
  fileURLToPath(new URL("../assets/" + name, import.meta.url));
/** Wide saved grids are continued in readable bands, with the first column repeated for context. */
export function bibleLayout(blocks: BibleBlock[]): BibleBlock[] {
  return blocks.flatMap((b) => {
    if (b.kind !== "table") return [b];
    if (!b.header?.length && !b.rows.length)
      return [{ kind: "note", text: "No table rows recorded." }];
    const count = Math.max(
      b.header?.length ?? 0,
      ...b.rows.map((r) => r.length),
      0,
    );
    if (count <= 6) return [b];
    const out: BibleBlock[] = [];
    for (let start = 1; start < count; start += 5) {
      const take = (row: string[]) => [
        row[0] ?? "",
        ...Array.from(
          { length: Math.min(5, count - start) },
          (_, i) => row[start + i] ?? "",
        ),
      ];
      out.push(
        {
          kind: "paragraph",
          text: `Table columns ${start + 1}–${Math.min(count, start + 5)}${start > 1 ? " (continued)" : ""}`,
        },
        {
          ...b,
          header: b.header ? take(b.header) : undefined,
          rows: b.rows.map(take),
        },
      );
    }
    return out;
  });
}
export async function renderBible(
  blocks: BibleBlock[],
  format: "docx" | "pdf",
): Promise<Buffer> {
  const laid = bibleLayout(blocks);
  for (const b of laid) {
    const texts =
      b.kind === "table"
        ? [...(b.header ?? []), ...b.rows.flat()]
        : [b.text ?? ""];
    for (const t of texts)
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(t))
        throw new StudioError(
          422,
          "EXPORT_TEXT",
          "Some saved text contains unsupported control characters. Review it before exporting.",
        );
  }
  if (format === "pdf") return renderPDF(laid);
  const paragraph = (text: string, bold = false, cell = false) =>
    new Paragraph({
      children: text
        .split("\n")
        .flatMap((t, i) => [
          ...(i ? [new TextRun({ break: 1 })] : []),
          new TextRun({ text: t, bold }),
        ]),
      spacing: { after: cell ? 0 : 120 },
      keepNext: !cell && text.startsWith("Table columns "),
    });
  const splitRows = (rows: string[][], columns: number) =>
    rows.flatMap((row) => {
      const pieces = row.map((text) => {
        const out: string[] = [];
        let part = "",
          count = 0,
          lines = 0;
        for (const { segment } of new Intl.Segmenter("en", {
          granularity: "grapheme",
        }).segment(text)) {
          part += segment;
          count++;
          if (segment.includes("\n")) lines++;
          if (count >= (columns <= 2 ? 600 : 120) || lines >= 6) {
            const split = lines >= 6 ? part.length - 1 : part.lastIndexOf(" ");
            if (split > 0) {
              out.push(part.slice(0, split + 1));
              part = part.slice(split + 1);
              count = [...part].length;
              lines = 0;
            } else {
              out.push(part);
              part = "";
              count = 0;
              lines = 0;
            }
          }
        }
        if (part || !out.length) out.push(part);
        return out;
      });
      return Array.from(
        { length: Math.max(...pieces.map((p) => p.length), 1) },
        (_, i) => pieces.map((p) => p[i] ?? ""),
      );
    });
  const children: (Paragraph | Table)[] = laid.map((b) => {
    if (b.kind === "table") {
      const columns = Math.max(
          b.header?.length ?? 0,
          ...b.rows.map((r) => r.length),
          1,
        ),
        headers = b.header ? splitRows([b.header], columns) : [];
      return new Table({
        width: { size: 9360, type: WidthType.DXA },
        rows: [
          ...headers.map(
            (header) =>
              new TableRow({
                tableHeader: headers.length === 1,
                cantSplit: true,
                children: header.map(
                  (t) =>
                    new TableCell({
                      children: [paragraph(t, true, true)],
                      shading: { fill: "EEEAE2" },
                    }),
                ),
              }),
          ),
          ...splitRows(b.rows, columns).map(
            (row) =>
              new TableRow({
                cantSplit: true,
                children: row.map(
                  (t, i) =>
                    new TableCell({
                      children: [paragraph(t, !!b.keyed && i === 0, true)],
                    }),
                ),
              }),
          ),
        ],
        borders: {
          top: { style: BorderStyle.SINGLE, size: 4, color: "D6D0C4" },
          bottom: { style: BorderStyle.SINGLE, size: 4, color: "D6D0C4" },
          left: { style: BorderStyle.SINGLE, size: 4, color: "D6D0C4" },
          right: { style: BorderStyle.SINGLE, size: 4, color: "D6D0C4" },
          insideHorizontal: {
            style: BorderStyle.SINGLE,
            size: 4,
            color: "D6D0C4",
          },
          insideVertical: {
            style: BorderStyle.SINGLE,
            size: 4,
            color: "D6D0C4",
          },
        },
      });
    }
    if (b.kind === "break")
      return new Paragraph({ children: [new PageBreak()] });
    if (b.kind === "title")
      return new Paragraph({
        text: b.text,
        heading: HeadingLevel.TITLE,
        spacing: { before: 960, after: 300 },
      });
    if (b.kind === "subtitle")
      return new Paragraph({
        text: b.text,
        style: "Subtitle",
        spacing: { after: 240 },
      });
    if (b.kind === "heading")
      return new Paragraph({
        text: b.text,
        heading:
          b.level === 1
            ? HeadingLevel.HEADING_1
            : b.level === 2
              ? HeadingLevel.HEADING_2
              : HeadingLevel.HEADING_3,
        keepNext: true,
        spacing: { before: 240, after: 160 },
      });
    if (b.kind === "bullet")
      return new Paragraph({
        children: [new TextRun(b.text ?? "")],
        bullet: { level: 0 },
        spacing: { after: 120 },
      });
    return paragraph(b.text ?? "");
  });
  return Packer.toBuffer(
    new Document({
      title: blocks[0]?.kind === "title" ? blocks[0].text : undefined,
      creator: "Writers Rolltop",
      styles: {
        default: {
          document: {
            run: { font: "Noto Sans", size: 22 },
            paragraph: { spacing: { line: 288 } },
          },
        },
        paragraphStyles: [
          {
            id: "Title",
            name: "Title",
            basedOn: "Normal",
            run: { font: "Noto Sans", size: 44, bold: true, color: "000000" },
          },
          {
            id: "Heading1",
            name: "heading 1",
            basedOn: "Normal",
            next: "Normal",
            run: { size: 30, bold: true, color: "000000" },
          },
          {
            id: "Heading2",
            name: "heading 2",
            basedOn: "Normal",
            next: "Normal",
            run: { size: 26, bold: true, color: "000000" },
          },
          {
            id: "Heading3",
            name: "heading 3",
            basedOn: "Normal",
            next: "Normal",
            run: { size: 23, bold: true, color: "000000" },
          },
        ],
      },
      sections: [
        {
          properties: {
            page: {
              size: { width: 12240, height: 15840 },
              margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
            },
          },
          children,
        },
      ],
    }),
  );
}
async function renderPDF(blocks: BibleBlock[]): Promise<Buffer> {
  const d = new PDFDocument({
    size: "LETTER",
    margins: { top: 64, bottom: 64, left: 64, right: 64 },
    font: font("DejaVuSans.ttf"),
    info: {
      Title: blocks[0]?.kind === "title" ? blocks[0].text : "Story Bible",
      Creator: "Writers Rolltop",
    },
  });
  d.registerFont("regular", font("DejaVuSans.ttf"));
  d.registerFont("bold", font("DejaVuSans-Bold.ttf"));
  // Never substitute missing glyphs silently in a fixed PDF; Word remains available for font fallback.
  const face = (d as any)._font.font;
  for (const b of blocks)
    for (const text of b.kind === "table"
      ? [...(b.header ?? []), ...b.rows.flat()]
      : [b.text ?? ""])
      for (const c of text)
        if (!/[\s]/u.test(c) && !face.hasGlyphForCodePoint(c.codePointAt(0)))
          throw new StudioError(
            422,
            "PDF_GLYPH",
            `The PDF font cannot display U+${c.codePointAt(0)!.toString(16).toUpperCase()}. Word export preserves this text with font fallback.`,
          );
  const chunks: Buffer[] = [];
  let size = 0,
    pages = 1;
  const done = new Promise<Buffer>((resolve, reject) => {
    d.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) {
        d.destroy(new Error("The exported file exceeds 32 MiB."));
        return;
      }
      chunks.push(c);
    });
    d.on("end", () => resolve(Buffer.concat(chunks)));
    d.on("error", reject);
  });
  const width = 484,
    bottom = 728;
  const page = () => {
    if (++pages > 2000)
      throw new StudioError(
        413,
        "EXPORT_TOO_LARGE",
        "This bible exceeds 2,000 PDF pages.",
      );
    d.addPage();
  };
  const ensure = (height: number) => {
    if (d.y + height > bottom) page();
  };
  const wrap = (value: string, w: number): string[] => {
    const lines: string[] = [];
    for (const raw of value.replaceAll("\t", "    ").split("\n")) {
      let line = "";
      for (const c of raw) {
        if (line && d.widthOfString(line + c) > w) {
          const split = line.lastIndexOf(" ");
          if (split > 0) {
            lines.push(line.slice(0, split));
            line = line.slice(split + 1);
          } else {
            lines.push(line);
            line = "";
          }
        }
        line += c;
      }
      lines.push(line);
    }
    return lines;
  };
  for (const b of blocks) {
    if (b.kind === "break") {
      page();
      continue;
    }
    if (b.kind === "table") {
      const columns = Math.max(
          b.header?.length ?? 0,
          ...b.rows.map((r) => r.length),
          1,
        ),
        cw = width / columns;
      d.fontSize(10);
      d.font("bold");
      const repeatHeader =
        b.header &&
        Math.max(...b.header.map((t) => wrap(t, cw - 12).length)) * 15 + 12 <
          180;
      const row = (values: string[], header = false) => {
        d.font(header ? "bold" : "regular");
        const lines = Array.from({ length: columns }, (_, i) => {
          d.font(header || (b.keyed && i === 0) ? "bold" : "regular");
          return wrap(values[i] ?? "", cw - 12);
        });
        let offset = 0,
          total = Math.max(...lines.map((l) => l.length));
        while (offset < total) {
          if (d.y + 25 > bottom) {
            page();
            if (b.header && repeatHeader && !header) row(b.header, true);
          }
          const available = Math.max(1, Math.floor((bottom - d.y - 12) / 15)),
            count = Math.min(total - offset, available),
            y = d.y,
            h = count * 15 + 12;
          for (let i = 0; i < columns; i++) {
            if (header) d.rect(64 + i * cw, y, cw, h).fill("#EEEAE2");
            d.rect(64 + i * cw, y, cw, h)
              .strokeColor("#D6D0C4")
              .lineWidth(0.5)
              .stroke();
            d.fillColor("#202020")
              .font(header || (b.keyed && i === 0) ? "bold" : "regular")
              .fontSize(10);
            for (let j = 0; j < count; j++) {
              const t = lines[i][offset + j];
              if (t !== undefined)
                d.text(t, 70 + i * cw, y + 6 + j * 15, {
                  width: cw - 12,
                  lineBreak: false,
                });
            }
          }
          d.y = y + h;
          d.x = 64;
          offset += count;
          if (offset < total) {
            page();
            if (b.header && repeatHeader && !header) row(b.header, true);
          }
        }
      };
      if (b.header) {
        d.font("bold");
        const headerHeight =
          Math.max(...b.header.map((t) => wrap(t, cw - 12).length)) * 15 + 12;
        if (headerHeight < 180) ensure(headerHeight + (b.rows.length ? 27 : 0));
        row(b.header, true);
      }
      for (const r of b.rows) row(r);
      d.y += 12;
      continue;
    }
    const size =
      b.kind === "title"
        ? 24
        : b.kind === "heading"
          ? b.level === 1
            ? 17
            : b.level === 2
              ? 14
              : 12
          : 11;
    d.font(b.kind === "title" || b.kind === "heading" ? "bold" : "regular")
      .fontSize(size)
      .fillColor("#202020");
    if (b.kind === "title") d.y += 36;
    ensure(b.kind === "heading" ? 65 : size * 2);
    d.x = 64;
    d.text((b.kind === "bullet" ? "• " : "") + (b.text ?? ""), {
      width,
      lineGap: 3,
      paragraphGap: 8,
    });
    d.y += b.kind === "heading" ? 10 : 8;
  }
  d.end();
  return done;
}
