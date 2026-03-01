/**
 * Server-side layout load function.
 * Can be extended for session checks or server-side data loading.
 */

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async () => {
  return {};
};
