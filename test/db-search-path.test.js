const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { isMissingRelationError, isNetworkUnreachable, shouldSwitchPoolerPort } = require("../src/db");

describe("db search_path", () => {
  it("reintenta cuando Postgres no encuentra la relación o el schema", () => {
    assert.equal(isMissingRelationError({ code: "42P01" }), true);
    assert.equal(isMissingRelationError({ code: "3F000" }), true);
    assert.equal(isMissingRelationError({ code: "42703" }), false);
    assert.equal(isMissingRelationError({ code: "23505" }), false);
    assert.equal(isMissingRelationError(null), false);
  });

  it("no trata la cola del pool como un puerto inalcanzable", () => {
    const queued = new Error("timeout exceeded when trying to connect");
    const handshake = new Error("Connection terminated due to connection timeout");
    assert.equal(isNetworkUnreachable(queued), false);
    assert.equal(isNetworkUnreachable(handshake), true);

    const base = { connectedOnce: false, alternatePortTried: false, totalCount: 0, supabaseHost: true, port: 5432 };
    assert.equal(shouldSwitchPoolerPort(queued, base), false);
    assert.equal(shouldSwitchPoolerPort(handshake, base), true);
    assert.equal(shouldSwitchPoolerPort(handshake, { ...base, totalCount: 3 }), false);
    assert.equal(shouldSwitchPoolerPort(handshake, { ...base, connectedOnce: true }), false);
  });
});
