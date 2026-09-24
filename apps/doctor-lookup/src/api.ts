import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity,
  OpenApi,
} from "effect/unstable/httpapi";
import { FindDoctorPayload, FindDoctorResult, Health } from "./contract";

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class NotReady extends Schema.TaggedError<NotReady>()(
  "NotReady",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** Shared bearer token between the voice platform and this service. */
export class ToolAuth extends HttpApiMiddleware.Service<ToolAuth>()("doctor-lookup/ToolAuth", {
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized,
}) {}

export class ToolsApi extends HttpApiGroup.make("tools")
  .add(
    HttpApiEndpoint.post("findDoctor", "/tools/find-doctor", {
      payload: FindDoctorPayload,
      success: FindDoctorResult,
    }),
  )
  .middleware(ToolAuth) {}

export class SystemApi extends HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("health", "/health", { success: Health, error: NotReady }),
) {}

export class Api extends HttpApi.make("doctor-lookup")
  .add(ToolsApi)
  .add(SystemApi)
  .annotateMerge(OpenApi.annotations({ title: "Doctor lookup tools" })) {}
