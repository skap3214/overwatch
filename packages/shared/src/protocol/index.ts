// Public protocol types. Re-exported from the codegenned module so consumers
// import via `@overwatch/shared/protocol` rather than reaching into the
// generated file directly.
//
// The schema lives in /protocol/schema/. To update types, edit the schema and
// run `npm run protocol:gen` from the repo root.

export * from "./types.generated.js";

export const PROTOCOL_VERSION = "1.0";
