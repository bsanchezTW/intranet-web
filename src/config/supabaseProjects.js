const SHARED_INTRANET_PROJECT_REF = "dgadjvptxhotjylwsglx";

const KNOWN_COUNTRY_PROJECT_REFS = Object.freeze({
  CL: SHARED_INTRANET_PROJECT_REF,
  PE: SHARED_INTRANET_PROJECT_REF,
});

// Un repo, dos procesos (dominios). Misma base; el aislamiento es el schema.
// El login del pooler es el rol del país: intranet_chile.<ref> / intranet_peru.<ref>.
// postgres.<ref> se reescribe al arrancar al rol de COUNTRY (la clave del .env
// es la de esos roles, no la del usuario postgres del dashboard).
const SHARED_POOLER_ROLE = "postgres";

const COUNTRY_BINDINGS = Object.freeze({
  CL: Object.freeze({
    schema: "chile",
    role: "intranet_chile",
    bucket: "intranet-content",
  }),
  PE: Object.freeze({
    schema: "peru",
    role: "intranet_peru",
    bucket: "intranet-content-pe",
  }),
});

class SupabaseProjectBindingError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SupabaseProjectBindingError";
    this.code = "SUPABASE_PROJECT_BINDING_ERROR";
    this.statusCode = 500;
    Object.assign(this, details);
  }
}

function extractProjectRefFromSupabaseUrl(url) {
  const hostname = new URL(url).hostname.toLowerCase();
  const match = hostname.match(/^([a-z0-9-]{8,})\.supabase\.co$/);
  return match?.[1] || null;
}

function isLoopbackHostname(hostname) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    String(hostname || "").toLowerCase(),
  );
}

function expectedProjectVariable(country) {
  return `SUPABASE_PROJECT_REF_${country}`;
}

function getCountryDbBinding(countryValue) {
  const country = String(countryValue || "").trim().toUpperCase();
  const binding = COUNTRY_BINDINGS[country];
  if (!binding) {
    throw new SupabaseProjectBindingError(
      `País no soportado para el aislamiento de schema: ${countryValue || "(vacío)"}.`,
      { country },
    );
  }
  return { country, ...binding };
}

function resolveExpectedProjectRef(countryValue, env = process.env) {
  const country = String(countryValue || "").trim().toUpperCase();
  if (!country) return null;
  if (!COUNTRY_BINDINGS[country]) {
    throw new SupabaseProjectBindingError(`País no soportado para Supabase: ${country}.`);
  }

  const variable = expectedProjectVariable(country);
  const configured = String(env[variable] || "").trim().toLowerCase();
  const fixed = KNOWN_COUNTRY_PROJECT_REFS[country] || null;
  if (fixed && configured && configured !== fixed) {
    throw new SupabaseProjectBindingError(
      `${variable} no coincide con el proyecto registrado para ${country}.`,
      { country, variable, expectedRef: fixed, configuredRef: configured },
    );
  }

  const expected = fixed || configured;
  if (!expected) {
    throw new SupabaseProjectBindingError(
      `${variable} es obligatoria para vincular la instancia ${country} con su proyecto.`,
      { country, variable },
    );
  }
  if (!/^[a-z0-9-]{8,}$/.test(expected)) {
    throw new SupabaseProjectBindingError(`${variable} no contiene un project ref válido.`, {
      country,
      variable,
    });
  }

  return expected;
}

function assertCountrySupabaseProject(url, country, env = process.env) {
  const expectedRef = resolveExpectedProjectRef(country, env);
  if (!expectedRef) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new SupabaseProjectBindingError(
      `La instancia ${String(country).toUpperCase()} exige Supabase "${expectedRef}", ` +
        'pero SUPABASE_URL apunta a "un host no identificable".',
      { country: String(country).toUpperCase(), expectedRef, actualRef: null },
    );
  }
  if (isLoopbackHostname(parsed.hostname)) return expectedRef;
  const actualRef = extractProjectRefFromSupabaseUrl(url);
  if (!actualRef || actualRef !== expectedRef) {
    throw new SupabaseProjectBindingError(
      `La instancia ${String(country).toUpperCase()} exige Supabase "${expectedRef}", ` +
        `pero SUPABASE_URL apunta a "${actualRef || "un host no identificable"}".`,
      { country: String(country).toUpperCase(), expectedRef, actualRef },
    );
  }
  return expectedRef;
}

function extractDatabaseRole(env = process.env) {
  let user = null;
  if (env.DATABASE_URL?.trim()) {
    try {
      user = decodeURIComponent(new URL(env.DATABASE_URL).username).trim();
    } catch {
      return null;
    }
  } else if (env.DB_USER) {
    user = String(env.DB_USER).trim();
  }
  if (!user) return null;
  const lower = user.toLowerCase();
  const pooler = lower.match(/^([a-z0-9_]+)\.([a-z0-9-]{8,})$/);
  return pooler ? pooler[1] : lower;
}

function foreignDatabaseRoles(country) {
  return Object.entries(COUNTRY_BINDINGS)
    .filter(([code]) => code !== country)
    .map(([, binding]) => binding.role);
}

function isAllowedDatabaseRole(country, actualRole) {
  const binding = getCountryDbBinding(country);
  return actualRole === SHARED_POOLER_ROLE || actualRole === binding.role;
}

function assertCountryDatabaseRole(env = process.env) {
  const country = String(env.COUNTRY || "").trim().toUpperCase();
  if (!country) return null;
  const binding = getCountryDbBinding(country);
  const actualRole = extractDatabaseRole(env);
  if (!actualRole) {
    throw new SupabaseProjectBindingError(
      `La instancia ${country} necesita DB_USER o DATABASE_URL.`,
      { country, expectedRole: binding.role, actualRole: null },
    );
  }

  if (foreignDatabaseRoles(country).includes(actualRole)) {
    throw new SupabaseProjectBindingError(
      `La instancia ${country} no puede usar el rol "${actualRole}" ` +
        `(reservado para el otro país). El aislamiento es el schema "${binding.schema}".`,
      { country, expectedRole: binding.role, actualRole },
    );
  }

  if (isAllowedDatabaseRole(country, actualRole)) return actualRole;

  throw new SupabaseProjectBindingError(
    `Rol Postgres no reconocido: "${actualRole}". ` +
      `Ambas instancias comparten el proyecto; el login es "${SHARED_POOLER_ROLE}.<ref>" ` +
      `o el rol dedicado "${binding.role}". El schema lo fija COUNTRY.`,
    { country, expectedRole: binding.role, actualRole },
  );
}

function assertCountryStorageBucket(bucket, countryValue) {
  const country = String(countryValue || "").trim().toUpperCase();
  if (!country) return null;
  const binding = getCountryDbBinding(country);
  const name = String(bucket || "").trim();
  for (const [otherCountry, otherBinding] of Object.entries(COUNTRY_BINDINGS)) {
    if (otherCountry !== country && otherBinding.bucket === name) {
      throw new SupabaseProjectBindingError(
        `La instancia ${country} no puede usar el bucket "${name}" (reservado para ${otherCountry}).`,
        { country, bucket: name, otherCountry },
      );
    }
  }
  if (name !== binding.bucket) {
    throw new SupabaseProjectBindingError(
      `La instancia ${country} exige el bucket "${binding.bucket}", se recibió "${name || "(vacío)"}".`,
      { country, expectedBucket: binding.bucket, actualBucket: name },
    );
  }
  return name;
}

function defaultStorageBucketForCountry(countryValue) {
  const country = String(countryValue || "").trim().toUpperCase();
  if (!country || !COUNTRY_BINDINGS[country]) return null;
  return COUNTRY_BINDINGS[country].bucket;
}

function resolveCountryPoolerUser(countryValue, currentUser) {
  const { role } = getCountryDbBinding(countryValue);
  const current = String(currentUser || "").trim();
  const match = current.match(/^([a-z0-9_]+)\.([a-z0-9-]{8,})$/i);
  const ref = match?.[2] || SHARED_INTRANET_PROJECT_REF;
  return `${role}.${ref}`;
}

function applyCountryPoolerUser(env = process.env) {
  const country = String(env.COUNTRY || "").trim().toUpperCase();
  if (!COUNTRY_BINDINGS[country]) return null;

  if (env.DB_USER?.trim()) {
    env.DB_USER = resolveCountryPoolerUser(country, env.DB_USER);
  }

  if (env.DATABASE_URL?.trim()) {
    try {
      const parsed = new URL(env.DATABASE_URL.trim());
      parsed.username = resolveCountryPoolerUser(
        country,
        decodeURIComponent(parsed.username),
      );
      env.DATABASE_URL = parsed.toString();
    } catch {
      // assertCountryDatabaseRole valida el valor original si no se puede parsear.
    }
  }

  return env.DB_USER || extractDatabaseRole(env);
}

function countryStorageBuckets() {
  return Object.values(COUNTRY_BINDINGS).map((binding) => binding.bucket);
}

function searchPathStatement(countryValue) {
  const { schema } = getCountryDbBinding(countryValue);
  return `SET search_path TO ${schema}`;
}

// Parámetro de arranque de Postgres: el pooler lo aplica al conectar.
// Evita un SET search_path (un RTT a us-west-2) en cada consulta.
function postgresStartupOptions(countryValue) {
  const { schema } = getCountryDbBinding(countryValue);
  return `-c search_path=${schema}`;
}

module.exports = {
  SHARED_INTRANET_PROJECT_REF,
  SHARED_POOLER_ROLE,
  KNOWN_COUNTRY_PROJECT_REFS,
  COUNTRY_BINDINGS,
  SupabaseProjectBindingError,
  extractProjectRefFromSupabaseUrl,
  expectedProjectVariable,
  getCountryDbBinding,
  resolveExpectedProjectRef,
  assertCountrySupabaseProject,
  extractDatabaseRole,
  resolveCountryPoolerUser,
  applyCountryPoolerUser,
  assertCountryDatabaseRole,
  assertCountryStorageBucket,
  defaultStorageBucketForCountry,
  countryStorageBuckets,
  searchPathStatement,
  postgresStartupOptions,
};
