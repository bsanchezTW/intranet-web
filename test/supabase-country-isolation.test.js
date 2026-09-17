const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  COUNTRY_BINDINGS,
  SHARED_INTRANET_PROJECT_REF,
  SupabaseProjectBindingError,
  getCountryDbBinding,
  countryStorageBuckets,
  searchPathStatement,
  postgresStartupOptions,
  extractDatabaseRole,
  resolveCountryPoolerUser,
  applyCountryPoolerUser,
  assertCountryDatabaseRole,
  assertCountryStorageBucket,
  assertCountrySupabaseProject,
} = require("../src/config/supabaseProjects");

describe("aislamiento Chile / Perú en el mismo proyecto", () => {
  it("asigna schema, rol y bucket distintos por país", () => {
    assert.equal(getCountryDbBinding("CL").schema, "chile");
    assert.equal(getCountryDbBinding("PE").schema, "peru");
    assert.equal(getCountryDbBinding("CL").role, "intranet_chile");
    assert.equal(getCountryDbBinding("PE").role, "intranet_peru");
    assert.equal(COUNTRY_BINDINGS.CL.bucket, "intranet-content");
    assert.equal(COUNTRY_BINDINGS.PE.bucket, "intranet-content-pe");
    assert.notEqual(COUNTRY_BINDINGS.CL.bucket, COUNTRY_BINDINGS.PE.bucket);
    assert.deepEqual(countryStorageBuckets(), [
      "intranet-content",
      "intranet-content-pe",
    ]);
  });

  it("fija search_path exclusivo al schema del país", () => {
    assert.equal(searchPathStatement("CL"), "SET search_path TO chile");
    assert.equal(searchPathStatement("PE"), "SET search_path TO peru");
    assert.equal(searchPathStatement("CL").includes("peru"), false);
    assert.equal(searchPathStatement("PE").includes("chile"), false);
    assert.throws(() => searchPathStatement("XX"), SupabaseProjectBindingError);
    assert.equal(postgresStartupOptions("CL"), "-c search_path=chile");
    assert.equal(postgresStartupOptions("PE"), "-c search_path=peru");
  });

  it("lee el rol de DATABASE_URL del pooler y rechaza el del otro país", () => {
    assert.equal(
      extractDatabaseRole({
        DATABASE_URL:
          "postgresql://intranet_chile.dgadjvptxhotjylwsglx:x@aws.pooler.supabase.com/postgres",
      }),
      "intranet_chile",
    );
    assert.throws(
      () =>
        assertCountryDatabaseRole({
          COUNTRY: "PE",
          DB_USER: "intranet_chile.dgadjvptxhotjylwsglx",
        }),
      /otro país/,
    );
    assert.equal(
      assertCountryDatabaseRole({
        COUNTRY: "PE",
        DB_USER: "intranet_peru",
      }),
      "intranet_peru",
    );
    assert.equal(
      extractDatabaseRole({
        DB_USER: "postgres.dgadjvptxhotjylwsglx",
      }),
      "postgres",
    );
    assert.equal(
      assertCountryDatabaseRole({
        COUNTRY: "CL",
        DB_USER: "postgres.dgadjvptxhotjylwsglx",
      }),
      "postgres",
    );
    assert.equal(
      assertCountryDatabaseRole({
        COUNTRY: "PE",
        DB_USER: "postgres.dgadjvptxhotjylwsglx",
      }),
      "postgres",
    );
    assert.throws(
      () =>
        assertCountryDatabaseRole({
          COUNTRY: "CL",
          DB_USER: "intranet_peru.dgadjvptxhotjylwsglx",
        }),
      /otro país/,
    );
    assert.equal(
      resolveCountryPoolerUser("CL", "postgres.dgadjvptxhotjylwsglx"),
      "intranet_chile.dgadjvptxhotjylwsglx",
    );
    assert.equal(
      resolveCountryPoolerUser("PE", "postgres.dgadjvptxhotjylwsglx"),
      "intranet_peru.dgadjvptxhotjylwsglx",
    );
    assert.equal(
      resolveCountryPoolerUser("PE", "intranet_chile.dgadjvptxhotjylwsglx"),
      "intranet_peru.dgadjvptxhotjylwsglx",
    );
    const remapped = applyCountryPoolerUser({
      COUNTRY: "CL",
      DB_USER: "postgres.dgadjvptxhotjylwsglx",
    });
    assert.equal(remapped, "intranet_chile.dgadjvptxhotjylwsglx");
    assert.throws(
      () =>
        assertCountryDatabaseRole({
          COUNTRY: "CL",
          DB_USER: "otro_rol",
        }),
      /no reconocido/,
    );
  });

  it("rechaza que Perú use el bucket de Chile y al revés", () => {
    assert.throws(
      () => assertCountryStorageBucket("intranet-content", "PE"),
      /reservado para CL/,
    );
    assert.throws(
      () => assertCountryStorageBucket("intranet-content-pe", "CL"),
      /reservado para PE/,
    );
    assert.equal(
      assertCountryStorageBucket("intranet-content-pe", "PE"),
      "intranet-content-pe",
    );
  });

  it("permite el mismo project ref para CL y PE", () => {
    const url = `https://${SHARED_INTRANET_PROJECT_REF}.supabase.co`;
    assert.equal(assertCountrySupabaseProject(url, "CL"), SHARED_INTRANET_PROJECT_REF);
    assert.equal(assertCountrySupabaseProject(url, "PE"), SHARED_INTRANET_PROJECT_REF);
  });
});
