/**
 * Reads a provider's reply body as JSON. A body that is empty or not JSON (an HTML
 * error page from a gateway, for example) reads as `undefined` on purpose: callers
 * decide from the status code and the expected shape, so an unreadable body is not
 * itself the error to report.
 */
export const readJsonBody = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};
