const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  isCloudinaryUrl,
  isStoredContentUrl,
  folderForUpload,
  folderForRow,
  fileNameForLegacyObject,
  destinationPath,
} = require("../src/services/documents/processDocumentStorage");

describe("processDocumentStorage", () => {
  it("reconoce Cloudinary y deja fuera /content", () => {
    assert.equal(
      isCloudinaryUrl(
        "https://res.cloudinary.com/dficfgah3/raw/upload/v1/documentos/procedimientos/logistica/abc.pdf",
      ),
      true,
    );
    assert.equal(isCloudinaryUrl("/content/documentos/procedimientos/3666/abc.pdf"), false);
    assert.equal(isStoredContentUrl("/content/documentos/otros/general/x.pdf"), true);
  });

  it("usa la misma carpeta que la subida actual", () => {
    assert.equal(
      folderForUpload("procedimientos", "3666"),
      "documentos/procedimientos/3666",
    );
    assert.equal(folderForUpload("reglamento", "general"), "documentos/reglamento/general");
    assert.equal(folderForUpload("otros", "general"), "documentos/otros/general");
  });

  it("coloca procedimientos, protocolos, reglamento y huérfanos", () => {
    assert.equal(
      folderForRow("documents", {
        doc_kind: "procedimiento",
        type: "procedimiento_logistica",
        work_area_id: 3666,
      }),
      "documentos/procedimientos/3666",
    );
    assert.equal(
      folderForRow("documents", {
        doc_kind: "protocolo",
        type: "protocolo_logistica",
        work_area_id: 3666,
      }),
      "documentos/protocolos/3666",
    );
    assert.equal(
      folderForRow("documents", { type: "reglamento", work_area_id: null }),
      "documentos/reglamento/general",
    );
    assert.equal(
      folderForRow("documents", { doc_kind: "procedimiento", work_area_id: null }),
      "documentos/procedimientos/sin-area",
    );
    assert.equal(
      folderForRow("other_documents", { name: "Acta" }),
      "documentos/otros/general",
    );
  });

  it("conserva el id de Cloudinary y completa la extensión", () => {
    assert.equal(
      fileNameForLegacyObject({
        url: "https://res.cloudinary.com/demo/raw/upload/v1/documentos/procedimientos/logistica/vo6l3xcu2g1pfikaya0y.pdf",
        publicId: "documentos/procedimientos/logistica/vo6l3xcu2g1pfikaya0y.pdf",
      }),
      "vo6l3xcu2g1pfikaya0y.pdf",
    );
    assert.equal(
      fileNameForLegacyObject({
        url: "https://res.cloudinary.com/demo/raw/upload/v1/intranet_otros_docs/tdcjcewagtasjfl2c0hf",
        publicId: "intranet_otros_docs/tdcjcewagtasjfl2c0hf",
        buffer: Buffer.from("%PDF-1.4 rest of file"),
      }),
      "tdcjcewagtasjfl2c0hf.pdf",
    );
    const docxHeader = Buffer.concat([
      Buffer.from("PK\u0003\u0004"),
      Buffer.alloc(64),
      Buffer.from("word/document.xml"),
    ]);
    assert.equal(
      fileNameForLegacyObject({
        url: "https://res.cloudinary.com/demo/raw/upload/v1/intranet_otros_docs/tdcjcewagtasjfl2c0hf",
        publicId: "intranet_otros_docs/tdcjcewagtasjfl2c0hf",
        buffer: docxHeader,
      }),
      "tdcjcewagtasjfl2c0hf.docx",
    );
    assert.equal(
      destinationPath(
        "documents",
        { doc_kind: "procedimiento", work_area_id: 3666 },
        "vo6l3xcu2g1pfikaya0y.pdf",
      ),
      "documentos/procedimientos/3666/vo6l3xcu2g1pfikaya0y.pdf",
    );
  });
});
