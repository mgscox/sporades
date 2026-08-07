// The per-build values a generated server bundle carries: the Capsule's config, its Server env, the
// sealed-env descriptor, the Capsule entry's own source text, and the data URL the Capsule module
// travels as. They are not knowable when this repository is compiled, so the module-graph bundle
// builder substitutes a generated module for this specifier at esbuild time.
//
// The specifier is virtual rather than a real file with placeholder values on purpose. A real file
// would still resolve if the substitution failed, and a Capsule would then boot with an empty
// config and an empty Server env — a silent wrong answer. Nothing resolves this specifier except
// the builder's plugin, so a substitution that did not happen is a build error instead.
declare module "sporades:server-bundle-inputs" {
  export const sporadesConfig: any;
  export const sporadesServerEnv: any;
  export const sporadesSealedServerEnv: any;
  export const sporadesServerSource: string;
  export const sporadesCapsuleModuleUrl: string;
}
