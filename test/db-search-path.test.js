const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { isMissingRelationError } = require("../src/db");

describe("db search_path", () => {
  it("reintenta cuando Postgres no encuentra la relación o el schema", () => {
    assert.equal(isMissingRelationError({ code: "42P01" }), true);
    assert.equal(isMissingRelationError({ code: "3F000" }), true);
    assert.equal(isMissingRelationError({ code: "42703" }), false);
    assert.equal(isMissingRelationError({ code: "23505" }), false);
    assert.equal(isMissingRelationError(null), false);
  });
});
