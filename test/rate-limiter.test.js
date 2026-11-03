const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createRateLimiter } = require("../src/utils/rateLimiter");

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe("rateLimiter", () => {
  it("deja pasar hasta `max` golpes por ventana y después bloquea", () => {
    const c = clock();
    const limiter = createRateLimiter({ windowMs: 1000, max: 3, now: c.now });
    assert.equal(limiter.hit("a").allowed, true);
    assert.equal(limiter.hit("a").allowed, true);
    const tercero = limiter.hit("a");
    assert.equal(tercero.allowed, true);
    assert.equal(tercero.remaining, 0);
    const cuarto = limiter.hit("a");
    assert.equal(cuarto.allowed, false);
    assert.equal(cuarto.retryAfterMs, 1000);
  });

  it("la ventana se renueva al vencer", () => {
    const c = clock();
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: c.now });
    limiter.hit("a");
    assert.equal(limiter.hit("a").allowed, false);
    c.advance(1000);
    assert.equal(limiter.hit("a").allowed, true);
  });

  it("check no cuenta y bloquea al alcanzar el tope", () => {
    const c = clock();
    const limiter = createRateLimiter({ windowMs: 1000, max: 2, now: c.now });
    assert.equal(limiter.check("a").allowed, true);
    limiter.hit("a");
    assert.equal(limiter.check("a").allowed, true);
    limiter.hit("a");
    const estado = limiter.check("a");
    assert.equal(estado.allowed, false);
    c.advance(400);
    assert.equal(limiter.check("a").retryAfterMs, 600);
  });

  it("las claves no se mezclan y reset olvida una", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => 0 });
    limiter.hit("a");
    assert.equal(limiter.hit("a").allowed, false);
    assert.equal(limiter.hit("b").allowed, true);
    limiter.reset("a");
    assert.equal(limiter.hit("a").allowed, true);
  });

  it("no crece sin tope con claves inventadas", () => {
    const c = clock();
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: c.now });
    for (let i = 0; i < 60000; i += 1) limiter.hit(`k${i}`);
    assert.ok(limiter.size() <= 50000);
  });

  it("exige una configuración positiva", () => {
    assert.throws(() => createRateLimiter({ windowMs: 0, max: 1 }));
    assert.throws(() => createRateLimiter({ windowMs: 1000, max: 0 }));
  });
});
