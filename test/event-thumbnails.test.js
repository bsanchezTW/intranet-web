const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  isDiskCacheable,
  isEventImagePath,
  previewUrl,
  cacheControlFor,
  storedPathsFor,
  thumbnailRelativePath,
  renderThumbnail,
  createFromLocalFile,
  MAX_EDGE,
} = require("../src/services/media/eventThumbnails");

describe("miniaturas de la galería", () => {
  it("arma la ruta de la copia chica y no anida miniaturas", () => {
    assert.equal(
      thumbnailRelativePath("eventos/aniversario-2025/foto.jpg"),
      "eventos/aniversario-2025/thumbs/foto.jpg",
    );
    assert.equal(
      thumbnailRelativePath("/content/eventos/aniversario-2025/foto.PNG"),
      "eventos/aniversario-2025/thumbs/foto.jpg",
    );
    assert.equal(
      thumbnailRelativePath("eventos/aniversario-2025/thumbs/foto.jpg"),
      "",
    );
    assert.equal(thumbnailRelativePath("eventos/aniversario-2025/clip.mp4"), "");
    assert.equal(thumbnailRelativePath("noticias_adjuntos/12_portada.jpg"), "");
  });

  it("la URL de vista previa apunta a la miniatura y deja el resto igual", () => {
    assert.equal(
      previewUrl("/content/eventos/aniversario-2025/foto.jpg"),
      "/content/eventos/aniversario-2025/thumbs/foto.jpg",
    );
    assert.equal(previewUrl("/content/documentos/acta.pdf"), "/content/documentos/acta.pdf");
    assert.equal(previewUrl(""), "");
  });

  it("solo cachea en disco las fotos y sus miniaturas", () => {
    assert.equal(isEventImagePath("eventos/slug/foto.jpeg"), true);
    assert.equal(isDiskCacheable("eventos/slug/foto.jpeg"), true);
    assert.equal(isDiskCacheable("eventos/slug/thumbs/foto.jpg"), true);
    assert.equal(isDiskCacheable("eventos/slug/clip.mp4"), false);
    assert.equal(isDiskCacheable("user/1.jpg"), false);
  });

  it("alarga la caché del navegador en archivos de evento", () => {
    assert.equal(
      cacheControlFor("eventos/slug/foto.jpg"),
      "private, max-age=604800, immutable, no-transform",
    );
    assert.equal(
      cacheControlFor("eventos/slug/thumbs/foto.jpg"),
      "private, max-age=86400, no-transform",
    );
    assert.equal(
      cacheControlFor("eventos/slug/clip.mp4"),
      "private, max-age=604800, immutable, no-transform",
    );
    assert.equal(cacheControlFor("user/1.jpg"), "private, max-age=300, no-transform");
  });

  it("borrar una foto también señala su miniatura", () => {
    assert.deepEqual(storedPathsFor("/content/eventos/slug/foto.jpg"), [
      "eventos/slug/foto.jpg",
      "eventos/slug/thumbs/foto.jpg",
    ]);
    assert.deepEqual(storedPathsFor("eventos/slug/clip.mp4"), ["eventos/slug/clip.mp4"]);
  });

  it("reduce el lado largo a 960 px y no agranda una foto chica", async () => {
    const { createCanvas, loadImage } = require("@napi-rs/canvas");
    const grande = createCanvas(1200, 600);
    grande.getContext("2d").fillRect(0, 0, 1200, 600);
    const thumb = await renderThumbnail(grande.toBuffer("image/png"));
    const decoded = await loadImage(thumb);
    assert.equal(thumb[0], 0xff);
    assert.equal(decoded.width, MAX_EDGE);
    assert.equal(decoded.height, 480);

    const chica = createCanvas(100, 80);
    chica.getContext("2d").fillRect(0, 0, 100, 80);
    const igual = await renderThumbnail(chica.toBuffer("image/png"));
    const decodedChica = await loadImage(igual);
    assert.equal(decodedChica.width, 100);
    assert.equal(decodedChica.height, 80);
  });

  it("sube la miniatura junto a la foto original", async () => {
    const { createCanvas } = require("@napi-rs/canvas");
    const canvas = createCanvas(40, 20);
    canvas.getContext("2d").fillRect(0, 0, 40, 20);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "event-thumb-"));
    const local = path.join(dir, "origen.png");
    await fs.writeFile(local, canvas.toBuffer("image/png"));

    const uploaded = [];
    const result = await createFromLocalFile(local, "eventos/slug/origen.png", {
      uploadFile: async (buffer, relativePath, options) => {
        uploaded.push({ buffer, relativePath, options });
      },
    });

    assert.equal(result.relativePath, "eventos/slug/thumbs/origen.jpg");
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0].options.contentType, "image/jpeg");
    assert.equal(uploaded[0].buffer[0], 0xff);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
