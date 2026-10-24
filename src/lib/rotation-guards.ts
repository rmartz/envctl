import { err, warn } from "./logger";
import {
  resolveServiceProvider,
  type ServiceContext,
  type ServiceProvider,
} from "./providers/service";

export interface RotationGuardInput {
  providers: ServiceProvider[];
  ctx: ServiceContext;
  init?: string;
  provider?: string;
  isPresent: (p: ServiceProvider) => boolean;
  willInit: (p: ServiceProvider) => boolean;
  inScope: (p: ServiceProvider) => boolean;
}

// Guards, iterating the registry rather than naming providers:
//  - init: erroring if a selected provider's secret already exists
//  - scoped rotate: erroring if the named provider is absent
//  - unscoped rotate: erroring if nothing is present to rotate
//  - manual-only providers: refusing an explicit init/rotate with the manual
//    steps, and warning with them when an unscoped rotate finds the secret
export function assertRotationGuards(g: RotationGuardInput): void {
  const { providers, ctx, isPresent, willInit, inScope } = g;
  if (g.init) {
    for (const p of providers) {
      if (willInit(p) && p.manualSteps) err(p.manualSteps(ctx));
      if (willInit(p) && isPresent(p))
        err(
          `${p.displayName} keys already exist in this Vercel project — use \`envctl secrets rotate\` to update them, not \`envctl secrets init\`.`,
        );
    }
  } else if (g.provider) {
    const scoped = resolveServiceProvider(g.provider);
    if (scoped.manualSteps) err(scoped.manualSteps(ctx));
    if (!isPresent(scoped))
      err(
        `No ${scoped.displayName} keys found in this Vercel project — nothing to rotate for \`${g.provider}\`. To push them for the first time, use \`envctl secrets init ${g.provider}\`.`,
      );
  } else {
    const automatable = providers.filter((p) => !p.manualSteps);
    for (const p of providers)
      if (p.manualSteps && isPresent(p) && inScope(p)) warn(p.manualSteps(ctx));
    if (!automatable.some(isPresent))
      err(
        `No ${automatable.map((p) => p.displayName).join(" or ")} keys found in this Vercel project — nothing to rotate. To push secrets for the first time, use \`envctl secrets init\`.`,
      );
  }
}
