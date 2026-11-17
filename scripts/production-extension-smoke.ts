import registerMobileRemote from "../extension";

const warnings: string[] = [];
process.env.OMP_MOBILE_SLOT = "production-smoke-invalid";
registerMobileRemote({
  logger: { warn: (message: string) => warnings.push(message) },
} as never);

if (
  warnings.length !== 1 ||
  !warnings[0]?.includes("OMP_MOBILE_SLOT must be a desktop runtime id")
) {
  throw new Error(
    `Expected the extension registration guard to warn once; got ${JSON.stringify(warnings)}`,
  );
}

console.log("PASS production extension import and registration guard");
