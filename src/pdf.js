import { PDFDocument, PDFName, PDFRawStream, PDFDict } from "pdf-lib";

// PDF を 1 ページずつの PDF に分ける
export async function splitPages(bytes) {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = [];
  for (let i = 0; i < src.getPageCount(); i++) {
    const doc = await PDFDocument.create();
    const [page] = await doc.copyPages(src, [i]);
    doc.addPage(page);
    pages.push(await doc.save());
  }
  return pages;
}

// PDF から 1 ページだけを取り出した PDF を作る（pageIndex は 0 始まり）
export async function extractOnePage(bytes, pageIndex) {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (pageIndex < 0 || pageIndex >= src.getPageCount()) return null;
  const doc = await PDFDocument.create();
  const [page] = await doc.copyPages(src, [pageIndex]);
  doc.addPage(page);
  return doc.save();
}

// スキャンした PDF のページに埋め込まれている JPEG 画像（いちばん大きいもの）を取り出す。
// Workers AI の画像モデルは PDF を直接読めないため。JPEG 以外の形式なら null。
export async function extractPageJpeg(pdfBytes, pageIndex = 0) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  if (pageIndex < 0 || pageIndex >= doc.getPageCount()) return null;
  const page = doc.getPage(pageIndex);
  let best = null;
  const visit = (resources, depth) => {
    if (!(resources instanceof PDFDict) || depth > 3) return;
    const xobjs = resources.lookup(PDFName.of("XObject"));
    if (!(xobjs instanceof PDFDict)) return;
    for (const [, ref] of xobjs.entries()) {
      const obj = doc.context.lookup(ref);
      if (!(obj instanceof PDFRawStream)) continue;
      const subtype = obj.dict.lookup(PDFName.of("Subtype"));
      if (subtype === PDFName.of("Form")) {
        visit(obj.dict.lookup(PDFName.of("Resources")), depth + 1);
        continue;
      }
      if (subtype !== PDFName.of("Image")) continue;
      // フィルターが DCTDecode（JPEG）で終わるものだけ対象。前段の FlateDecode（zlib 圧縮）は後で展開する
      const f = obj.dict.lookup(PDFName.of("Filter"));
      const filters = !f ? [] : typeof f.asArray === "function" ? f.asArray() : [f];
      if (!filters.length || filters[filters.length - 1] !== PDFName.of("DCTDecode")) continue;
      if (!filters.slice(0, -1).every((x) => x === PDFName.of("FlateDecode"))) continue;
      if (!best || obj.contents.length > best.obj.contents.length) best = { obj, inflate: filters.length - 1 };
    }
  };
  visit(page.node.Resources(), 0);
  if (!best) return null;
  let bytes = best.obj.contents;
  for (let i = 0; i < best.inflate; i++) bytes = await inflate(bytes);
  return bytes;
}

// zlib を展開する。末尾が欠けているデータ（スキャナーによくある）でも、読めた分は返す
async function inflate(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch (e) {
    if (!chunks.length) throw e;
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
