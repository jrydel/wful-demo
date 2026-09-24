import { DataBucket } from "@doctor-directory/shared/bucket";
import { CONTROL_KEY } from "@doctor-directory/shared/control-flags";
import { Clock, Context, Effect, Layer, Ref, Schema } from "effect";

/** How long a Worker instance trusts the switch it read; a flip takes effect within this. */
const RECHECK_MS = 5000;

const Flags = Schema.fromJsonString(Schema.Struct({ simulateOutage: Schema.Boolean }));

/**
 * The console's "Simulate outage" switch. Reading it must never break lookups: if the flag
 * cannot be read, lookups carry on as normal and a warning is logged.
 */
export class OutageSwitch extends Context.Service<
  OutageSwitch,
  { readonly active: Effect.Effect<boolean> }
>()("doctor-lookup/OutageSwitch") {
  static readonly layer = Layer.effect(
    OutageSwitch,
    Effect.gen(function* () {
      const bucket = yield* DataBucket;
      const decode = Schema.decodeUnknownEffect(Flags);
      const cached = yield* Ref.make({ active: false, readAt: Number.NEGATIVE_INFINITY });

      const read = Effect.gen(function* () {
        const object = yield* Effect.tryPromise(() => bucket.get(CONTROL_KEY));
        if (object === null) return false;
        const flags = yield* decode(yield* Effect.tryPromise(() => object.text()));
        return flags.simulateOutage;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("outage switch unreadable; serving normally", error).pipe(
            Effect.as(false),
          ),
        ),
      );

      const active = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const last = yield* Ref.get(cached);
        if (now - last.readAt < RECHECK_MS) return last.active;
        const value = yield* read;
        yield* Ref.set(cached, { active: value, readAt: now });
        return value;
      });

      return OutageSwitch.of({ active });
    }),
  );
}
