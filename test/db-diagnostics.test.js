const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { redactDatabaseUrl, formatPgError } = require("../src/services/dbDiagnostics");

describe("diagnóstico BD", () => {
  it("oculta la contraseña de DATABASE_URL", () => {
    const redacted = redactDatabaseUrl(
      "postgresql://intranet_peru.abc:super-secret@aws-1-us-west-2.pooler.supabase.com:6543/postgres",
    );
    assert.match(redacted, /intranet_peru\.abc/);
    assert.match(redacted, /:\*\*\*@/);
    assert.equal(redacted.includes("super-secret"), false);
  });

  it("devuelve null si no hay URL", () => {
    assert.equal(redactDatabaseUrl(""), null);
    assert.equal(redactDatabaseUrl(undefined), null);
  });

  it("desempaqueta AggregateError con IP y puerto", () => {
    const text = formatPgError({
      code: "ECONNREFUSED",
      message: "AggregateError",
      address: "1.2.3.4",
      port: 5432,
      syscall: "connect",
      errors: [{ code: "ECONNREFUSED", address: "1.2.3.4", port: 5432 }],
    });
    assert.match(text, /address=1\.2\.3\.4/);
    assert.match(text, /port=5432/);
    assert.match(text, /cPanel no alcanza/);
  });
});
