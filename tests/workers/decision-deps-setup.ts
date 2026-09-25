// Default decision-job deps for the worker suite (Task 22): pre-22 tests
// were written before rooms executed AI jobs, so the suite default is a
// fail-closed budget — every evaluate job dies instantly with no upstream
// call and no quota spend, keeping pre-22 assertions deterministic.
// global-budget.test.ts re-injects real deps per test.
import { injectDecisionJobDeps } from "../../apps/server/src/rooms/decision-jobs";

injectDecisionJobDeps({ control: null });
