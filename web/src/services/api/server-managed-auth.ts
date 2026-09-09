import { AxiosHeaders, type AxiosRequestConfig } from "axios";

export const SERVER_MANAGED_API_KEY = "server-managed";

export function isServerManagedApiKey(apiKey: string) {
    return apiKey.trim().toLowerCase() === SERVER_MANAGED_API_KEY;
}

export function bearerAuthHeaders(apiKey: string): Record<string, string> {
    return isServerManagedApiKey(apiKey) ? {} : { Authorization: `Bearer ${apiKey}` };
}

/** Keep a site's HTTP Basic Authorization header available for server-managed, same-origin model gateways. */
export function withoutServerManagedAuthorization<T extends AxiosRequestConfig>(apiKey: string, request: T): T {
    if (!isServerManagedApiKey(apiKey)) return request;
    const headers = request.headers instanceof AxiosHeaders
        ? new AxiosHeaders(request.headers)
        : Object.fromEntries(Object.entries(request.headers || {}).filter(([name]) => name.toLowerCase() !== "authorization"));
    if (headers instanceof AxiosHeaders) headers.delete("Authorization");
    return { ...request, headers };
}
