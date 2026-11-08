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

// スキャンした PDF のページに埋め込まれている JPEG 画像（いちばん大きいもの）を取り出す。
// Workers AI の画像モデルは PDF を直接読めないため。JPEG 以外の形式なら null。
export async function extractPageJpeg(pageBytes) {
  const doc = await PDFDocument.load(pageBytes, { ignoreEncryption: true, updateMetadata: false });
  const page = doc.getPage(0);
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
      const filter = obj.dict.lookup(PDFName.of("Filter"));
      const isJpeg = filter === PDFName.of("DCTDecode") ||
        (filter && typeof filter.asArray === "function" && filter.asArray().length === 1 && filter.asArray()[0] === PDFName.of("DCTDecode"));
      if (isJpeg && (!best || obj.contents.length > best.length)) best = obj.contents;
    }
  };
  visit(page.node.Resources(), 0);
  return best;
}
