import { runLifecycle } from "../lib/notify.mjs";

export default async () => {
  await runLifecycle();
};

export const config = { schedule: "*/15 * * * *" };
