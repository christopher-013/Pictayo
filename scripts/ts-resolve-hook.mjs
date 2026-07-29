/**
 * Lets Node import the app's source directly.
 *
 * The source uses extensionless relative imports (`../store/db`), which is
 * normal for a bundler but not something Node's ESM resolver accepts. Rather
 * than litter the source with `.ts` extensions to suit a test runner, this hook
 * retries a failed relative resolution with `.ts` appended.
 *
 * Node 24 strips the types itself, so nothing needs compiling.
 */

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const looksExtensionless = specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier);
    if (!looksExtensionless) throw error;

    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // Report the original failure — it names the specifier as written.
      throw error;
    }
  }
}
