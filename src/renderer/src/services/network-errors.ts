// Errors from a failed download reach the renderer as text (often wrapped as
// "Error invoking remote method ...: Error: fetch failed"), so match the
// network failure codes rather than an error type.
const NETWORK_ERROR_PATTERN =
  /fetch failed|failed to fetch|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|getaddrinfo|UND_ERR_CONNECT|socket hang up|network error/i

/** True when an error message means the machine could not reach the download server. */
export function isNetworkErrorMessage(message: string | null | undefined): boolean {
  return Boolean(message && NETWORK_ERROR_PATTERN.test(message))
}
